import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import { getOwnedJob } from "./jobs/store.js";
import { errorEnvelope } from "./mapping.js";
import { restrictedCandidate } from "./routed-search.js";

/** Applied before either base BVH or FBX bytes can be resolved. Client flags are ignored. */
export function createReleaseGuard(
  load = getOwnedJob,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const raw = c.req.query("personIndex");
    const index = Number(raw);
    const jobId = c.req.query("jobId");
    const job =
      jobId && raw !== undefined && Number.isInteger(index) && index >= 0
        ? await load(jobId, c.get("installationId")!)
        : undefined;
    const candidate = job?.result?.candidatesByPerson
      .find((p) => p.personIndex === index)
      ?.candidates.find(
        (p) =>
          p.id === c.req.query("candidateId") && p.poseId === c.req.param("id"),
      );
    if (
      job?.status !== "completed" ||
      !candidate ||
      restrictedCandidate(candidate)
    )
      return c.json(
        errorEnvelope(
          "CANDIDATE_RELEASE_FORBIDDEN",
          "이 후보는 파일로 저장할 수 없습니다.",
          c.get("requestId"),
        ),
        409,
      );
    await next();
  };
}
