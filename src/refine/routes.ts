// POST /v1/analysis/jobs/:jobId/people/:personIndex/refine — 선택 후보 refine 프록시.
// jobsRoutes 아래에 마운트된다(경로 prefix는 /v1/analysis/jobs).
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { getOwnedJob } from "../jobs/store.js";
import { validateExportCandidate } from "../analytics/store.js";
import { isRefineFailure, runRefine } from "./service.js";

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
    `/v1/pose-candidates/${encodeURIComponent(candidateIdToPoseId(candidateId))}/export?` +
    new URLSearchParams({ jobId, personIndex: String(personIndex), candidateId });

  return c.json({
    jobId,
    personIndex,
    candidateId,
    refined: outcome.refined,
    reasonCode: outcome.reasonCode,
    adjustedLimbs: outcome.adjustedLimbs,
    exportUrl,
  });
});

/** candidateId는 `${poseId}::${view}` 형식이다(mapping.ts). export 경로는 poseId를 쓴다. */
function candidateIdToPoseId(candidateId: string): string {
  const separator = candidateId.lastIndexOf("::");
  return separator === -1 ? candidateId : candidateId.slice(0, separator);
}
