import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import { getOwnedJob } from "../jobs/store.js";
import { errorEnvelope } from "../mapping.js";
import { HTTP_SCHEMA, PreparationError, prepareSchema, publicBatch, reuseSchema } from "./model.js";
import type { PreparationService } from "./service.js";
export function createPreparationRoutes(service: PreparationService, enabled: () => boolean, owned = getOwnedJob) {
  const r = new Hono<AppEnv>(), base = "/:jobId/candidate-preparation";
  r.onError((e, c) => c.json(errorEnvelope(e instanceof PreparationError ? e.code : "PREPARATION_UNAVAILABLE",
    "후보 준비 상태를 다시 확인해 주세요.", c.get("requestId")), e instanceof PreparationError ? e.status : 503));
  r.use(`${base}/*`, bodyLimit({ maxSize: 128000 }));
  r.use(base, bodyLimit({ maxSize: 4096 }));
  const location = (c: { req: { param(k: string): string }; get(k: "installationId"): string | undefined }, gate = true) => {
    const installationId = c.get("installationId"), jobId = c.req.param("jobId");
    if (!installationId) throw new PreparationError("NOT_FOUND", 404);
    if (!/^job_[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new PreparationError("INVALID_INPUT", 400);
    if (gate && !enabled()) throw new PreparationError("PREPARATION_DISABLED", 503);
    return { installationId, jobId };
  };
  const id = (c: { req: { param(k: string): string } }) => {
    const value = c.req.param("batchId");
    if (!/^prep_[a-f0-9-]{36}$/.test(value)) throw new PreparationError("NOT_FOUND", 404);
    return value;
  };
  const headers = { "Cache-Control": "private, no-store", "Retry-After": "1" };
  r.get(`${base}/capabilities`, async c => {
    const l = location(c, false);
    if (!(await owned(l.jobId, l.installationId))) throw new PreparationError("NOT_FOUND", 404);
    let available = false;
    if (enabled()) try { await service.identity(); available = true; } catch { /* legacy fallback */ }
    return c.json({ schemaVersion: HTTP_SCHEMA, candidatePreparation: available, sourceOnly: true,
      modelFormat: "bvh", maxCandidates: 64, maxCandidatesPerPerson: 5, targetRefine: false, automaticParts: false }, 200, headers);
  });
  r.post(base, async c => {
    const l = location(c), parsed = prepareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new PreparationError("INVALID_INPUT", 400);
    const result = await service.prepare(l, parsed.data);
    return c.json(publicBatch(result.batch), result.replay ? 200 : 202, headers);
  });
  r.get(base, async c => {
    const b = await service.current(location(c));
    if (b && c.req.query("afterSequence") === String(b.eventSequence)) return c.body(null, 204, headers);
    return c.json(b ? publicBatch(b) : { schemaVersion: HTTP_SCHEMA, currentRevision: 0, batch: null }, 200, headers);
  });
  r.get(`${base}/:batchId`, async c => {
    const b = (await service.current(location(c), id(c)))!;
    if (c.req.query("afterSequence") === String(b.eventSequence)) return c.body(null, 204, headers);
    return c.json(publicBatch(b), 200, headers);
  });
  r.delete(`${base}/:batchId`, async c => c.json(publicBatch(await service.cancel(location(c), id(c))), 200, headers));
  r.post(`${base}/:batchId/reuse`, async c => {
    const l = location(c), batchId = id(c), parsed = reuseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new PreparationError("INVALID_INPUT", 400);
    return c.json(await service.reuse(l, batchId, parsed.data), 200, headers);
  });
  r.get(`${base}/:batchId/people/:personIndex/candidates/:candidateId/model`, async c => {
    const l = location(c), batchId = id(c), personIndex = Number(c.req.param("personIndex")), candidateId = c.req.param("candidateId");
    if (!/^(0|[1-9][0-9]*)$/.test(c.req.param("personIndex")) || !Number.isSafeInteger(personIndex) || candidateId.length > 200)
      throw new PreparationError("INVALID_INPUT", 400);
    const source = await service.source(l, batchId, personIndex, candidateId);
    return new Response(source.bytes, { headers: { ...headers, "Content-Type": "application/octet-stream",
      "Content-Length": String(source.bytes.length), "X-Standin-Source-SHA256": source.candidate.sourceSha256,
      "X-Standin-Artifact-SHA256": source.candidate.outputSha256!, "X-Standin-Context-Hash": source.batch.contextHash,
      "X-Standin-Quality-Scope": "source_only", "X-Content-Type-Options": "nosniff" } });
  });
  return r;
}
