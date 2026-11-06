import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { validateConfirmedSelection } from "../analytics/store.js";
import { createCandidateRefineTransport } from "../inference.js";
import { resolvePreparation } from "./resolver.js";
import { PreparationStore } from "./store.js";
import { active, ENGINE_CONTRACT, hash, HTTP_SCHEMA, PreparationError, publicBatch,
  type Batch, type Candidate, type EngineResult, type Owner, type Prepare, type Reuse } from "./model.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  engine = z.record(z.string(), z.unknown());
export const resultSchema = z.object({
  person_id: z.string(), candidate_id: z.string(), context_fingerprint: digest, source_fingerprint: digest,
  status: z.enum(["ready_refined", "ready_base", "unsupported", "failed_retryable"]), reason: z.string().min(1).max(200),
  quality_scope: z.literal("source_only"), engine, source_sha256: digest,
  artifact_sha256: digest.nullable(), bvh: z.string().max(2 * 1024 * 1024).nullable(),
  prepared_id: z.string().min(1).max(128).nullable(),
  timing: z.object({ queue_ms: z.number().nonnegative(), execution_ms: z.number().nonnegative(),
    total_ms: z.number().nonnegative(), origin_queue_ms: z.number().nonnegative().optional(),
    origin_execution_ms: z.number().nonnegative().optional(), cache: z.enum(["miss", "hit", "in_flight"]) }),
}).strict();
const capabilitySchema = z.object({ contract_version: z.literal(ENGINE_CONTRACT), available: z.literal(true),
  source_refine: z.literal(true), target_refine: z.literal(false), quality_scope: z.literal("source_only"), engine,
  max_candidates: z.literal(10), max_candidates_per_person: z.literal(5),
}).passthrough();
const bytesSha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export interface PreparationDeps {
  store: PreparationStore;
  resolve: typeof resolvePreparation;
  transport: ReturnType<typeof createCandidateRefineTransport>;
  confirmed: typeof validateConfirmedSelection;
  metric(event: string, data: Record<string, unknown>): void;
}
export class PreparationService {
  private running = new Map<string, AbortController>();
  constructor(readonly deps: PreparationDeps) {}
  async identity() { return capabilitySchema.parse(await this.deps.transport.capabilities()).engine; }
  async prepare(l: Owner, input: Prepare) {
    const identity = await this.identity(), context = await this.deps.resolve(l, identity),
      now = this.deps.store.clock();
    const candidates: Candidate[] = context.candidates.map(c => ({ personIndex: Number(c.person_id), candidateId: c.candidate_id,
      resultId: `result_${randomUUID()}`, contextHash: context.contextHash, status: "queued", reasonCode: "queued",
      qualityScope: "source_only", sourceSha256: c.source_sha256, outputSha256: null, engineResult: null,
      modelSha256: null, modelBytes: null, bvh: null }));
    candidates.push(...context.unsupported.map(c => ({ personIndex: c.personIndex, candidateId: c.candidateId,
      resultId: `result_${randomUUID()}`, contextHash: context.contextHash, status: "unsupported" as const, reasonCode: c.reason,
      qualityScope: "source_only" as const, sourceSha256: c.sourceSha256, outputSha256: null, engineResult: null,
      modelSha256: null, modelBytes: null, bvh: null })));
    // Preserve the registered original rank/order; unsupported rows are not dropped or reordered.
    const ordered = context.order.map(k => candidates.find(c => c.personIndex === k.personIndex && c.candidateId === k.candidateId)!);
    const result = await this.deps.store.prepare(l, input, { ...l, ...context,
      eventSequence: 1, status: "queued", candidates: ordered, retryAfter: null,
      expiresAt: new Date(now + 9 * 60000).toISOString(), createdAt: new Date(now).toISOString(),
      input: { contract_version: ENGINE_CONTRACT, batch_id: "pending", owner_id: l.installationId, job_id: l.jobId,
        candidate_set_revision: context.candidateSetRevision, batch_budget_ms: 60000, candidate_budget_ms: 5000,
        candidates: context.candidates } });
    // Close TOCTOU window between authoritative reads and durable publication.
    await this.current(l, result.batch.batchId);
    this.deps.metric(result.replay ? "in_flight_or_result_reuse" : "queued", { candidates: ordered.length });
    return result;
  }
  async current(l: Owner, id?: string) {
    l = { installationId: l.installationId, jobId: l.jobId };
    const b = id ? await this.deps.store.get(l, id) : await this.deps.store.head(l);
    if (!b) return null;
    if (Date.parse(b.expiresAt) <= this.deps.store.clock()) throw new PreparationError("PREPARATION_EXPIRED", 410);
    const context = await this.deps.resolve(l, await this.identity());
    if (context.contextHash !== b.contextHash) {
      await this.deps.store.close(b, "invalidated");
      this.running.get(b.batchId)?.abort();
      throw new PreparationError("PREPARATION_SUPERSEDED");
    }
    return b;
  }
  async cancel(l: Owner, id: string) {
    const b = await this.deps.store.get(l, id);
    this.running.get(id)?.abort();
    return await this.deps.store.close(b, "cancelled") ?? b;
  }
  private checkResult(raw: unknown, expected: { person_id: string; candidate_id: string; source_sha256: string }, identity: unknown) {
    const r = resultSchema.parse(raw);
    if (r.person_id !== expected.person_id || r.candidate_id !== expected.candidate_id ||
      r.source_sha256 !== expected.source_sha256 || hash(r.engine) !== hash(identity))
      throw new PreparationError("PREPARATION_INTEGRITY");
    const ready = r.status === "ready_base" || r.status === "ready_refined";
    if (ready && (!r.bvh || !r.prepared_id || bytesSha(r.bvh) !== r.artifact_sha256 ||
      !/^HIERARCHY\s/.test(r.bvh) || (r.status === "ready_base" && r.artifact_sha256 !== r.source_sha256)))
      throw new PreparationError("PREPARATION_INTEGRITY");
    return r;
  }
  async tick() {
    const claim = await this.deps.store.claim(); if (!claim) return false;
    let b = claim.batch; const controller = new AbortController(), started = Date.now();
    this.running.set(b.batchId, controller);
    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking) return; checking = true;
      void this.deps.store.heartbeat(b, claim.leaseId).then(ok => { if (!ok) controller.abort(); })
        .catch(() => controller.abort()).finally(() => { checking = false; });
    }, 1000); heartbeat.unref();
    try {
      await this.current(b, b.batchId);
      b = await this.deps.store.update(b, current => ({ ...current, status: "running",
        candidates: current.candidates.map(c => c.status === "queued" ? { ...c, status: "running" } : c) }), claim.leaseId) ?? b;
      const identity = await this.identity();
      this.deps.metric("started", { queueWaitMs: Math.max(0, Date.now() - Date.parse(b.createdAt)), candidates: b.candidates.length, globalBffConcurrency: 1 });
      // Internal limit10 is a chunk bound, never a product person limit or a truncation rule.
      const deadline = Date.parse(b.createdAt) + 120000;
      for (let i = 0; i < b.input.candidates.length; i += 10) {
        if (controller.signal.aborted) return true;
        const chunk = b.input.candidates.slice(i, i + 10), budget = Math.min(60000, deadline - Date.now());
        if (budget < 1) throw new PreparationError("PREPARATION_TIMEOUT", 503);
        const raw = await this.deps.transport.prepare({ ...b.input, candidates: chunk, batch_budget_ms: budget }, controller.signal);
        const response = z.object({ contract_version: z.literal(ENGINE_CONTRACT), batch_id: z.literal(b.batchId),
          owner_id: z.literal(b.installationId), job_id: z.literal(b.jobId), candidate_set_revision: z.literal(b.candidateSetRevision),
          all_terminal: z.literal(true), results: z.array(z.unknown()).length(chunk.length), elapsed_ms: z.number().nonnegative(),
        }).strict().parse(raw);
        const results = response.results.map((r, n) => {
          try { return this.checkResult(r, chunk[n], identity); }
          catch { return null; } // One corrupt candidate cannot erase valid siblings.
        });
        const accumulatedBytes = b.candidates.reduce((n, c) => n + (c.modelBytes ?? 0), 0) +
          results.reduce((n, r) => n + (r?.bvh ? Buffer.byteLength(r.bvh) : 0), 0);
        if (accumulatedBytes > 64 * 1024 * 1024) throw new PreparationError("PREPARATION_SIZE_UNSUPPORTED", 413);
        await this.current(b, b.batchId); // Late results cannot revive a changed/deleted/cancelled context.
        b = await this.deps.store.update(b, current => ({ ...current,
          candidates: current.candidates.map(c => {
            const n = chunk.findIndex(r => r.person_id === String(c.personIndex) && r.candidate_id === c.candidateId);
            if (n < 0) return c;
            const result = results[n];
            if (!result) return { ...c, status: "failed_retryable", reasonCode: "preparation_integrity", bvh: null };
            return { ...c, status: result.status, reasonCode: result.reason, qualityScope: result.quality_scope,
              engineResult: result, outputSha256: result.artifact_sha256, bvh: result.bvh,
              modelSha256: result.artifact_sha256, modelBytes: result.bvh ? Buffer.byteLength(result.bvh) : null };
          }) }), claim.leaseId) ?? b;
      }
      await this.deps.store.update(b, current => ({ ...current, status: "completed",
        retryAfter: current.candidates.some(c => c.status === "failed_retryable") ? new Date(this.deps.store.clock() + 5000).toISOString() : null }), claim.leaseId);
      this.deps.metric("completed", { durationMs: Date.now() - started, candidates: b.candidates.length });
    } catch (error) {
      const reasonCode = error instanceof PreparationError ? error.code.toLowerCase() : "preparation_unavailable";
      // Keep completed siblings and separate transient failures from permanent no-gain results.
      await this.deps.store.update(b, current => ({ ...current, status: "completed", retryAfter: new Date(this.deps.store.clock() + 5000).toISOString(),
        candidates: current.candidates.map(c => ["running", "queued"].includes(c.status)
          ? { ...c, status: "failed_retryable", reasonCode, bvh: null } : c) }), claim.leaseId);
      this.deps.metric("failed_retryable", { durationMs: Date.now() - started, reasonCode });
    } finally {
      clearInterval(heartbeat); this.running.delete(b.batchId);
      // Remote engine retains its global CPU reservation until actual completion even if HTTP aborts.
      await this.deps.store.release(b.batchId, claim.leaseId);
    }
    return true;
  }
  async source(l: Owner, batchId: string, personIndex: number, candidateId: string) {
    const b = await this.current(l, batchId);
    const c = b?.candidates.find(c => c.personIndex === personIndex && c.candidateId === candidateId);
    if (!b || !active(b) || b.status !== "completed" || !c || !["ready_refined", "ready_base"].includes(c.status) ||
      !c.bvh || !c.engineResult?.prepared_id || bytesSha(c.bvh) !== c.outputSha256)
      throw new PreparationError("PREPARATION_NOT_READY");
    const input = b.input.candidates.find(i => i.person_id === String(personIndex) && i.candidate_id === candidateId);
    if (!input || c.contextHash !== b.contextHash || c.sourceSha256 !== input.source_sha256)
      throw new PreparationError("PREPARATION_INTEGRITY");
    let raw: unknown;
    try { raw = await this.deps.transport.reuse({ contract_version: ENGINE_CONTRACT,
      batch_id: b.batchId, owner_id: b.installationId, job_id: b.jobId, candidate_set_revision: b.candidateSetRevision,
      person_id: String(personIndex), candidate_id: candidateId, prepared_id: c.engineResult.prepared_id,
      context_fingerprint: c.engineResult.context_fingerprint });
    } catch {
      await this.deps.store.close(b, "invalidated");
      throw new PreparationError("PREPARATION_EXPIRED", 410);
    }
    const result = this.checkResult(raw, input, await this.identity());
    if (result.artifact_sha256 !== c.outputSha256 || result.bvh !== c.bvh ||
      result.context_fingerprint !== c.engineResult.context_fingerprint ||
      result.source_fingerprint !== c.engineResult.source_fingerprint || result.status !== c.status) throw new PreparationError("PREPARATION_INTEGRITY");
    // Re-read ownership/head after external I/O, including cancellation while reuse was in progress.
    const latest = await this.current(l, batchId);
    if (!latest || !active(latest)) throw new PreparationError("PREPARATION_SUPERSEDED");
    return { batch: b, candidate: c, bytes: new TextEncoder().encode(c.bvh), result };
  }
  async reuse(l: Owner, batchId: string, input: Reuse) {
    if (new Set(input.selections.map(s => s.personIndex)).size !== input.selections.length)
      throw new PreparationError("INVALID_SELECTION", 400);
    const selections = [];
    for (const s of input.selections) {
      if (!(await this.deps.confirmed(l.installationId, l.jobId, s.personIndex, s.candidateId)))
        throw new PreparationError("SELECTION_REQUIRED");
      const { candidate: c, batch } = await this.source(l, batchId, s.personIndex, s.candidateId);
      if (c.resultId !== s.resultId) throw new PreparationError("PREPARATION_SUPERSEDED");
      const sourceUrl = `/v1/analysis/jobs/${encodeURIComponent(l.jobId)}/candidate-preparation/${batchId}/people/${s.personIndex}/candidates/${encodeURIComponent(s.candidateId)}/model`;
      const pose = batch.input.candidates.find(i => i.candidate_id === c.candidateId && i.person_id === String(c.personIndex))!.request.pose_id;
      const exportUrl = `/v1/pose-candidates/${encodeURIComponent(pose)}/export?${new URLSearchParams({ jobId: l.jobId, personIndex: String(c.personIndex), candidateId: c.candidateId })}`;
      selections.push({ ...s, contextHash: c.contextHash, outputSha256: c.outputSha256, sourceUrl, exportUrl,
        refined: c.status === "ready_refined", reasonCode: c.reasonCode, adjustedLimbs: [], thumbnailUrl: null,
        sourceReceipt: publicBatch(batch).candidates.find(v => v.resultId === c.resultId)!.validationReceipt });
    }
    for (const s of input.selections) if (!(await this.deps.confirmed(l.installationId, l.jobId, s.personIndex, s.candidateId)))
      throw new PreparationError("SELECTION_CHANGED");
    return { schemaVersion: HTTP_SCHEMA, batchId, contextHash: selections[0].contextHash, selections,
      targetApplicationRequired: true, finalFileVerified: false };
  }
  start() {
    let stopped = false, pending = false;
    const timer = setInterval(() => {
      if (stopped || pending) return; pending = true;
      void this.tick().catch(() => this.deps.metric("worker_unavailable", {})).finally(() => { pending = false; });
    }, 500); timer.unref();
    return () => { stopped = true; clearInterval(timer); for (const c of this.running.values()) c.abort(); };
  }
}
