import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { getOwnedJob } from "./jobs/store.js";
import { getPoseThumbnail } from "./inference.js";
import { errorEnvelope } from "./mapping.js";
import { restrictedCandidate } from "./routed-search.js";

const defaults = { getOwnedJob, getPoseThumbnail };
export function createRoutedPreviewRoutes(
  overrides: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/:id/lookup-thumbnail", async (c) => {
    const jobId = c.req.query("jobId") ?? "";
    const raw = c.req.query("personIndex");
    const index = Number(raw);
    const job =
      jobId && raw !== undefined && Number.isInteger(index) && index >= 0
        ? await deps.getOwnedJob(jobId, c.get("installationId")!)
        : undefined;
    const candidate = job?.result?.candidatesByPerson
      .find((p) => p.personIndex === index)
      ?.candidates.find(
        (p) =>
          p.id === c.req.query("candidateId") && p.poseId === c.req.param("id"),
      );
    if (
      job?.status !== "completed" ||
      !candidate?.lookupAllowed ||
      !restrictedCandidate(candidate)
    )
      return c.json(
        errorEnvelope(
          "INVALID_SELECTION",
          "조회할 후보를 다시 선택해 주세요.",
          c.get("requestId"),
        ),
        409,
      );
    const response = await deps.getPoseThumbnail(candidate.poseId, "front");
    if (!response.ok)
      return c.json(
        errorEnvelope(
          "POSE_UNAVAILABLE",
          "미리보기를 불러오지 못했습니다.",
          c.get("requestId"),
        ),
        409,
      );
    return new Response(response.body, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Standin-Preview": "canonical-front-reference",
      },
    });
  });
  return routes;
}
