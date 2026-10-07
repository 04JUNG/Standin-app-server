/** Candidate preview before selection: authorize the stored job on every request. */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { getPoseBvh } from "../inference.js";
import { config } from "../config.js";
import { checkCharacter } from "../characters/service.js";
import { errorEnvelope } from "../mapping.js";
import { cameraArtifact } from "./artifacts.js";
import { convertFramed } from "../converter/framing.js";
import { sha256Hex, converterEnabled } from "../converter/client.js";

const defaults = { getOwnedJob, getPoseBvh, checkCharacter, convertFramed, converterEnabled };
export function createAlignedRoutes(deps = defaults) {
  const routes = new Hono<AppEnv>();
  routes.get("/:id/aligned", async c => {
    const installationId = c.get("installationId")!;
    const jobId = c.req.query("jobId") ?? "";
    const rawPerson = c.req.query("personIndex");
    const personIndex = Number(rawPerson);
    const candidateId = c.req.query("candidateId") ?? "";
    const fail = (status: 400 | 409 | 503, code: string) => c.json(errorEnvelope(code, "미리보기를 다시 요청해 주세요.", c.get("requestId")), status);
    if (!jobId || !rawPerson || !Number.isInteger(personIndex) || personIndex < 0 || !candidateId)
      return fail(400, "INVALID_INPUT");
    const job = await deps.getOwnedJob(jobId, installationId);
    const candidate = job?.result?.candidatesByPerson.find(p => p.personIndex === personIndex)?.candidates.find(p => p.id === candidateId && p.poseId === c.req.param("id"));
    if (job?.status !== "completed" || !candidate?.camera) return fail(409, "INVALID_EXPORT");
    if (!deps.converterEnabled()) return fail(503, "FBX_UNAVAILABLE");
    const characterId = c.req.query("characterId") || config.converterCharacterId;
    try {
      if (await deps.checkCharacter(characterId) !== "ok") return fail(409, "CHARACTER_UNAVAILABLE");
      const response = await deps.getPoseBvh(candidate.poseId);
      if (!response.ok) return fail(409, "POSE_UNAVAILABLE");
      const bvhBytes = new Uint8Array(await response.arrayBuffer());
      if (sha256Hex(bvhBytes) !== candidate.camera.source_bvh_sha256) return fail(409, "POSE_UNAVAILABLE");
      const result = await cameraArtifact([installationId, jobId, personIndex, candidateId],
        { bvhBytes, characterId, scope: "full", cameraRotation: candidate.camera.rotation }, deps.convertFramed);
      const current = await deps.getOwnedJob(jobId, installationId);
      if (current?.status !== "completed") return fail(409, "INVALID_EXPORT");
      return new Response(result.preview, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
    } catch {
      return fail(503, "CONVERTER_UNAVAILABLE");
    }
  });
  return routes;
}
