import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import type { ReplayService } from "./service.js";
/** Observe only validated server response hashes; never infer save/import success. */
export function replayArtifactWitness(
  service: ReplayService,
  onFailure: () => void,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const installationId = c.get("installationId");
    if (!installationId || !c.res.ok) return;
    const path = c.req.path;
    const scene = /^\/v1\/analysis\/jobs\/([^/]+)\/scene$/.exec(path);
    const person = /^\/v1\/pose-candidates\/[^/]+\/(?:framed|export)$/.test(
      path,
    );
    if (!scene && !person) return;
    const format = c.req.query("format") ?? "bvh";
    if (person && !["fbx", "preview", "ready"].includes(format)) return;
    const artifactHash = c.res.headers.get("X-Standin-Artifact-SHA256");
    const jobId = scene?.[1] ?? c.req.query("jobId");
    if (!jobId || !artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash)) return;
    try {
      await service.witnessArtifact(installationId, jobId, artifactHash);
    } catch {
      onFailure();
    }
    // Replay problems must never change a successfully prepared/downloaded FBX response.
  };
}
