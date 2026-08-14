// /v1/analysis/jobs — 분석 Job 생성·폴링·결과.
// 동기 추론을 "제출→폴링" 비동기 계약으로 감싼다(클라 08_API_CONTRACT.md 형태).
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { confirmSelections, saveFeedback } from "../analytics/store.js";
import { inspectInputImage, storeInput } from "../inputStorage.js";
import { exceedsPixelBudget } from "../imageHeader.js";
import { config } from "../config.js";
import {
  createJobWithLimits,
  getOwnedJob,
  refundAnalysisQuota,
  setJobInput,
  updateJob,
} from "./store.js";
import { runAnalysisJob } from "./runner.js";
import { refineRoutes } from "../refine/routes.js";
import { isAnalysisEnabled } from "../limits/flags.js";
import { limitErrorResponse } from "../limits/http.js";
import { isLimitExceeded } from "../limits/policy.js";

export const jobsRoutes = new Hono<AppEnv>();

// POST /:jobId/people/:personIndex/refine. 같은 prefix라 여기 붙이고 파일만 나눈다.
jobsRoutes.route("/", refineRoutes);

// POST /v1/analysis/jobs — 이미지 업로드 → jobId 즉시 반환(추론은 백그라운드)
jobsRoutes.post("/", async (c) => {
  // 운영자 kill switch. 사용자 잘못이 아니므로 429가 아니라 503으로 구분한다.
  // 20MB body를 읽기 전에 본다.
  if (!(await isAnalysisEnabled())) {
    return c.json(
      errorEnvelope("SERVICE_PAUSED", "지금은 분석을 이용할 수 없습니다.", c.get("requestId")),
      503,
    );
  }
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "file(멀티파트 이미지)이 필요합니다.", c.get("requestId")),
      400,
    );
  }
  if (
    !new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type) ||
    file.size <= 0 ||
    file.size > config.maxUploadBytes
  ) {
    // bodyLimit이 Content-Length로 먼저 끊지만(index.ts), 헤더가 없거나 거짓인
    // 요청이 여기까지 올 수 있어 파싱 뒤에도 한 번 더 본다.
    return c.json(
      errorEnvelope("INVALID_INPUT", "PNG, JPG, WEBP 이미지만 20MB까지 허용됩니다.", c.get("requestId")),
      400,
    );
  }
  // 바이트는 여기서 한 번만 읽어 검증·저장·추론이 나눠 쓴다.
  const bytes = new Uint8Array(await file.arrayBuffer());
  let actualSize;
  try {
    actualSize = inspectInputImage(bytes, file.type).size;
  } catch {
    return c.json(
      errorEnvelope(
        "INVALID_INPUT",
        "Image content does not match its MIME type.",
        c.get("requestId"),
      ),
      400,
    );
  }
  // 파일 크기 상한만으로는 decompression bomb을 못 막는다 — 압축이 잘 되는 이미지는
  // 20MB 안에서도 수십억 픽셀을 선언할 수 있고, 그걸 펼치는 건 추론 서버다.
  if (actualSize && exceedsPixelBudget(actualSize, config.maxImagePixels)) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "이미지 해상도가 너무 큽니다.", c.get("requestId")),
      400,
    );
  }
  const source = body["source"];
  if (source !== "capture" && source !== "file" && source !== "clipboard") {
    return c.json(
      errorEnvelope("INVALID_INPUT", "source가 필요합니다.", c.get("requestId")),
      400,
    );
  }
  const optionalDimension = (value: unknown): number | null => {
    if (typeof value !== "string" || value === "") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : null;
  };
  // 헤더에서 읽은 값이 있으면 그걸 쓴다. 클라 값은 검증되지 않았고, jobs 테이블의
  // COALESCE 때문에 한번 들어가면 실제 값이 덮어쓰지 못한다.
  const width = actualSize?.width ?? optionalDimension(body["width"]);
  const height = actualSize?.height ?? optionalDimension(body["height"]);
  const installationId = c.get("installationId")!;
  // 사용량 한도는 입력 검증을 통과한 뒤에 소비한다 — 잘못된 요청이 쿼터를 깎으면 안 된다.
  let job;
  try {
    job = await createJobWithLimits(c.get("userId") ?? null, {
      installationId,
      source,
      mime: file.type || "application/octet-stream",
      size: file.size,
      width,
      height,
    });
  } catch (error) {
    if (isLimitExceeded(error)) return limitErrorResponse(c, error);
    throw error;
  }
  try {
    const stored = await storeInput(installationId, job.id, bytes, file.type);
    await setJobInput(job.id, { s3Key: stored.key, sha256: stored.sha256 });
  } catch {
    await updateJob(job.id, { status: "failed", errorCode: "INPUT_STORAGE_FAILED" });
    // 우리 쪽 저장 장애다. 사용자의 오늘 쿼터를 깎은 채로 두지 않는다.
    await refundAnalysisQuota(installationId).catch(() => {});
    return c.json(
      errorEnvelope("STORAGE_UNAVAILABLE", "입력 이미지를 안전하게 보관하지 못했습니다.", c.get("requestId")),
      503,
    );
  }
  void runAnalysisJob(job.id, file); // fire-and-forget; free-form hints are not accepted in beta
  return c.json({ jobId: job.id, status: job.status, createdAt: job.createdAt }, 202);
});

// GET /v1/analysis/jobs/:id — 상태 폴링
jobsRoutes.get("/:id", async (c) => {
  const job = await getOwnedJob(c.req.param("id"), c.get("installationId")!);
  if (!job) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);
  }
  return c.json({
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.errorCode,
  });
});

// GET /v1/analysis/jobs/:id/result — 결과(완료 시)
jobsRoutes.get("/:id/result", async (c) => {
  const job = await getOwnedJob(c.req.param("id"), c.get("installationId")!);
  if (!job) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);
  }
  if (job.status !== "completed" || !job.result) {
    return c.json(errorEnvelope("NOT_READY", `job status: ${job.status}`, c.get("requestId")), 409);
  }
  return c.json(job.result);
});

jobsRoutes.put("/:id/selections", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { selections?: unknown[] } | null;
  if (!body?.selections || !Array.isArray(body.selections) || body.selections.length === 0) {
    return c.json(errorEnvelope("INVALID_INPUT", "selections 배열이 필요합니다.", c.get("requestId")), 400);
  }
  const selections: Array<{ personIndex: number; candidateId: string }> = [];
  const seen = new Set<number>();
  for (const raw of body.selections) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json(errorEnvelope("INVALID_INPUT", "선택 형식이 잘못되었습니다.", c.get("requestId")), 400);
    }
    const item = raw as Record<string, unknown>;
    if (
      !Number.isInteger(item.personIndex) ||
      (item.personIndex as number) < 0 ||
      typeof item.candidateId !== "string" ||
      item.candidateId.length === 0 ||
      seen.has(item.personIndex as number)
    ) {
      return c.json(errorEnvelope("INVALID_INPUT", "선택 값이 잘못되었습니다.", c.get("requestId")), 400);
    }
    seen.add(item.personIndex as number);
    selections.push({ personIndex: item.personIndex as number, candidateId: item.candidateId });
  }
  const saved = await confirmSelections(c.get("installationId")!, c.req.param("id"), selections);
  if (!saved) {
    return c.json(errorEnvelope("INVALID_SELECTION", "노출되지 않은 후보입니다.", c.get("requestId")), 409);
  }
  return c.json({ confirmed: true });
});

const FEEDBACK_REASONS = new Set([
  "good",
  "person_missing",
  "skeleton_wrong",
  "candidates_irrelevant",
  "export_problem",
  "other",
]);

jobsRoutes.post("/:id/feedback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  if (typeof body?.reason !== "string" || !FEEDBACK_REASONS.has(body.reason)) {
    return c.json(errorEnvelope("INVALID_INPUT", "허용되지 않은 피드백입니다.", c.get("requestId")), 400);
  }
  if (!(await saveFeedback(c.get("installationId")!, c.req.param("id"), body.reason))) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);
  }
  return c.json({ saved: true });
});

// POST /v1/analysis/jobs/:id/rerun — TODO(Phase 2): excludeCandidateIds 반영 재검색
jobsRoutes.post("/:id/rerun", (c) => {
  return c.json(
    errorEnvelope("NOT_IMPLEMENTED", "rerun은 Phase 2에서 구현", c.get("requestId")),
    501,
  );
});
