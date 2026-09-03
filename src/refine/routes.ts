// POST /v1/analysis/jobs/:jobId/people/:personIndex/refine — 선택 후보 refine 프록시.
// jobsRoutes 아래에 마운트된다(경로 prefix는 /v1/analysis/jobs).
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { getOwnedJob } from "../jobs/store.js";
import { validateExportCandidate } from "../analytics/store.js";
import { isRefineFailure, resolveRefinedThumbnail, runRefine } from "./service.js";

export const refineRoutes = new Hono<AppEnv>();

refineRoutes.post("/:jobId/people/:personIndex/refine", async (c) => {
  const jobId = c.req.param("jobId");
  const personIndex = Number(c.req.param("personIndex"));
  const installationId = c.get("installationId")!;
  const requestId = c.get("requestId");

  if (!Number.isInteger(personIndex) || personIndex < 0) {
    return c.json(errorEnvelope("INVALID_INPUT", "personIndex가 올바르지 않습니다.", requestId), 400);
  }

  const body = (await c.req.json().catch(() => null)) as { candidateId?: unknown } | null;
  const candidateId = body?.candidateId;
  if (typeof candidateId !== "string" || candidateId.length === 0) {
    return c.json(errorEnvelope("INVALID_INPUT", "candidateId가 필요합니다.", requestId), 400);
  }

  // 1) 이 installation이 job에 접근할 수 있는가.
  if (!(await getOwnedJob(jobId, installationId))) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", requestId), 404);
  }
  // 2) 그 인물에게 실제로 노출된 Top-5 후보인가.
  if (!(await validateExportCandidate(installationId, jobId, personIndex, candidateId))) {
    return c.json(
      errorEnvelope("INVALID_SELECTION", "작업에서 노출된 후보가 아닙니다.", requestId),
      409,
    );
  }

  const outcome = await runRefine({ installationId, jobId, personIndex, candidateId });
  if (isRefineFailure(outcome)) {
    return c.json(
      errorEnvelope("INVALID_SELECTION", "작업에서 노출된 후보가 아닙니다.", requestId),
      409,
    );
  }

  // exportUrl은 기존 공개 export 경로 그대로다(BFF-06). 조정본이 있으면 그 URL이 조정본을,
  // 없으면 베이스를 준다 — 클라이언트는 어느 쪽인지 몰라도 같은 URL만 내려받으면 된다.
  const exportUrl =
    `/v1/pose-candidates/${encodeURIComponent(outcome.poseId)}/export?` +
    new URLSearchParams({ jobId, personIndex: String(personIndex), candidateId });

  // 미리보기는 별도 GET이다. 응답에 base64를 그대로 실으면 다인 컷에서 refine 응답이
  // 인물 수만큼 커지는데, 이 값은 화면에 한 번 그려지고 마는 그림이다.
  const thumbnailUrl = outcome.thumbnailAvailable
    ? `/v1/analysis/jobs/${encodeURIComponent(jobId)}/people/${personIndex}/refine/thumbnail?` +
      new URLSearchParams({ candidateId })
    : null;

  return c.json({
    jobId,
    personIndex,
    candidateId,
    refined: outcome.refined,
    reasonCode: outcome.reasonCode,
    adjustedLimbs: outcome.adjustedLimbs,
    exportUrl,
    thumbnailUrl,
  });
});

// GET /v1/analysis/jobs/:jobId/people/:personIndex/refine/thumbnail?candidateId=…
// 저장 직전 확인 화면이 쓰는 미리보기 PNG(ADR-010). 조정본 BVH와 같은 소유권 검사를 거친다.
refineRoutes.get("/:jobId/people/:personIndex/refine/thumbnail", async (c) => {
  const jobId = c.req.param("jobId");
  const personIndex = Number(c.req.param("personIndex"));
  const installationId = c.get("installationId")!;
  const requestId = c.get("requestId");

  if (!Number.isInteger(personIndex) || personIndex < 0) {
    return c.json(errorEnvelope("INVALID_INPUT", "personIndex가 올바르지 않습니다.", requestId), 400);
  }
  const candidateId = c.req.query("candidateId");
  if (!candidateId) {
    return c.json(errorEnvelope("INVALID_INPUT", "candidateId가 필요합니다.", requestId), 400);
  }

  // POST와 같은 두 단계 검사. 미리보기는 사용자 입력에서 파생된 private artifact이므로
  // job 소유권만으로는 부족하고, 그 인물에게 실제로 노출된 후보여야 한다.
  if (!(await getOwnedJob(jobId, installationId))) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", requestId), 404);
  }
  if (!(await validateExportCandidate(installationId, jobId, personIndex, candidateId))) {
    return c.json(
      errorEnvelope("INVALID_SELECTION", "작업에서 노출된 후보가 아닙니다.", requestId),
      409,
    );
  }

  const bytes = await resolveRefinedThumbnail(jobId, personIndex, candidateId);
  // 그림이 없는 것은 오류가 아니지만, 응답으로는 "없음"이어야 한다 — 빈 200을 주면
  // 클라이언트가 깨진 이미지를 그린다.
  if (!bytes) {
    return c.json(errorEnvelope("NOT_FOUND", "미리보기가 없습니다.", requestId), 404);
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      // 같은 (job, person, candidate)의 그림은 바뀌지 않는다 — 멱등 캐시가 그걸 보장한다.
      "Cache-Control": "private, max-age=86400",
    },
  });
});
