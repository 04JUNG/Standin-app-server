// /v1/analysis/jobs — 분석 Job 생성·폴링·결과.
// 동기 추론을 "제출→폴링" 비동기 계약으로 감싼다(클라 08_API_CONTRACT.md 형태).
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { createJob, getJob } from "./store.js";
import { runAnalysisJob } from "./runner.js";

export const jobsRoutes = new Hono<AppEnv>();

// POST /v1/analysis/jobs — 이미지 업로드 → jobId 즉시 반환(추론은 백그라운드)
jobsRoutes.post("/", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "file(멀티파트 이미지)이 필요합니다.", c.get("requestId")),
      400,
    );
  }
  const hint = typeof body["hint"] === "string" ? body["hint"] : "";
  // TODO(Phase 1): requireAuth에서 userId 획득해 전달
  const job = createJob(null);
  void runAnalysisJob(job.id, file, hint); // fire-and-forget
  return c.json({ jobId: job.id, status: job.status, createdAt: job.createdAt }, 202);
});

// GET /v1/analysis/jobs/:id — 상태 폴링
jobsRoutes.get("/:id", (c) => {
  const job = getJob(c.req.param("id"));
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
jobsRoutes.get("/:id/result", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);
  }
  if (job.status !== "completed" || !job.result) {
    return c.json(errorEnvelope("NOT_READY", `job status: ${job.status}`, c.get("requestId")), 409);
  }
  return c.json(job.result);
});

// POST /v1/analysis/jobs/:id/rerun — TODO(Phase 2): excludeCandidateIds 반영 재검색
jobsRoutes.post("/:id/rerun", (c) => {
  return c.json(
    errorEnvelope("NOT_IMPLEMENTED", "rerun은 Phase 2에서 구현", c.get("requestId")),
    501,
  );
});
