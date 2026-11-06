import { z } from "zod";
import type { RefineUpstreamRequest } from "../inference.js";
export { hash, InteractiveError as PreparationError } from "../interactive-state/model.js";
export const HTTP_SCHEMA = "standin.candidate-preparation.v1";
export const ENGINE_CONTRACT = "candidate-refine-v1";
export interface Owner { installationId: string; jobId: string }
export const prepareSchema = z.object({
  schemaVersion: z.literal(HTTP_SCHEMA),
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type Prepare = z.infer<typeof prepareSchema>;
export const reuseSchema = z.object({
  schemaVersion: z.literal(HTTP_SCHEMA),
  selections: z.array(z.object({
    personIndex: z.number().int().nonnegative(), candidateId: z.string().min(1).max(200),
    resultId: z.string().min(1).max(200),
  }).strict()).min(1).max(1000),
}).strict();
export type Reuse = z.infer<typeof reuseSchema>;
export type CandidateStatus = "queued" | "running" | "ready_refined" | "ready_base" |
  "unsupported" | "failed_retryable" | "invalidated" | "cancelled";
export const terminal = (s: CandidateStatus) => !["queued", "running"].includes(s);
export interface EngineInput {
  contract_version: typeof ENGINE_CONTRACT; batch_id: string; owner_id: string; job_id: string;
  candidate_set_revision: string; batch_budget_ms: number; candidate_budget_ms: number;
  candidates: Array<{ person_id: string; candidate_id: string; source_sha256: string;
    request: RefineUpstreamRequest }>;
}
export interface EngineResult {
  person_id: string; candidate_id: string; context_fingerprint: string; source_fingerprint: string;
  status: "ready_refined" | "ready_base" | "unsupported" | "failed_retryable";
  reason: string; quality_scope: "source_only"; engine: Record<string, unknown>;
  source_sha256: string; artifact_sha256: string | null; bvh: string | null; prepared_id: string | null;
  timing: Record<string, unknown>;
}
export interface EngineResponse {
  contract_version: typeof ENGINE_CONTRACT; batch_id: string; owner_id: string; job_id: string;
  candidate_set_revision: string; all_terminal: true; results: EngineResult[];
}
export interface Candidate {
  personIndex: number; candidateId: string; resultId: string; contextHash: string;
  status: CandidateStatus; reasonCode: string; qualityScope: "source_only";
  sourceSha256: string; outputSha256: string | null;
  engineResult: EngineResult | null;
  modelSha256: string | null; modelBytes: number | null;
  /** Frozen source result; private and never returned in the polling DTO. */
  bvh: string | null;
}
export interface Batch extends Owner {
  batchId: string; revision: number; contextHash: string; candidateSetRevision: string;
  eventSequence: number; status: "queued" | "running" | "completed" | "cancelled" | "invalidated";
  candidates: Candidate[]; input: EngineInput; expiresAt: string; createdAt: string;
  retryAfter: string | null;
}
export function active(b: Batch) { return b.status !== "cancelled" && b.status !== "invalidated"; }
export function publicBatch(b: Batch) {
  const base = `/v1/analysis/jobs/${encodeURIComponent(b.jobId)}/candidate-preparation/${b.batchId}`;
  return {
    schemaVersion: HTTP_SCHEMA, batchId: b.batchId, revision: b.revision, contextHash: b.contextHash,
    candidateSetRevision: b.candidateSetRevision, eventSequence: b.eventSequence, status: b.status,
    terminal: b.candidates.filter(c => terminal(c.status)).length, total: b.candidates.length,
    top5Ready: active(b) && b.status === "completed" && b.candidates.every(c => terminal(c.status)),
    expiresAt: b.expiresAt, retryAfter: b.retryAfter,
    capabilities: { candidatePreparation: true, preparedResults: true, modelFormat: "bvh", maxCandidates: 64, maxCandidatesPerPerson: 5,
      sourceOnly: true, targetRefine: false, automaticParts: false, sceneJointValidation: false },
    candidates: b.candidates.map(c => {
      const ready = active(b) && ["ready_refined", "ready_base"].includes(c.status) && !!c.bvh;
      const route = `${base}/people/${c.personIndex}/candidates/${encodeURIComponent(c.candidateId)}`;
      return { personIndex: c.personIndex, candidateId: c.candidateId, resultId: c.resultId,
        contextHash: c.contextHash, status: c.status, reasonCode: c.reasonCode, qualityScope: c.qualityScope,
        sourceSha256: c.sourceSha256, outputSha256: c.outputSha256,
        engine: c.engineResult ? Object.fromEntries([
          "adapter_version", "policy_version", "selector_version", "code_version", "config_sha256",
          "source_revision", "pose_library_version",
        ].flatMap(key => typeof c.engineResult!.engine[key] === "string" && (c.engineResult!.engine[key] as string).length <= 200
          ? [[key, c.engineResult!.engine[key]]] : [])) : null,
        timing: c.engineResult?.timing ?? null,
        modelUrl: ready ? `${route}/model` : null,
        previewAsset: ready ? { schemaVersion: "candidate-source-preview-v1", format: "bvh",
          url: `${route}/model`, sha256: c.outputSha256, bytes: c.modelBytes,
          contextHash: c.contextHash, sourceSha256: c.sourceSha256, displayOnly: true,
          camera: b.input.candidates.find(i => i.person_id === String(c.personIndex) && i.candidate_id === c.candidateId)?.request.camera ?? null } : null,
        validationReceipt: ready ? { schema: "candidate-source-receipt-v1", contextHash: c.contextHash,
          sourceFingerprint: c.engineResult?.source_fingerprint, contextFingerprint: c.engineResult?.context_fingerprint,
          qualityScope: "source_only", skinSafe: false, finalFileVerified: false } : null,
      };
    }),
  };
}
