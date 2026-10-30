/** Native parts HTTP v1 adapter. No BVH generation, IK or natural-language inference. */
import { log } from "../log.js";
import { randomBytes } from "node:crypto";
import type { Job } from "../jobs/store.js";
import type { SceneSource } from "../converter/scene.js";
import { composeRoughScene } from "../converter/scene.js";
import { ConverterError, sha256Hex } from "../converter/client.js";
import { scenePartsRequest } from "../inference.js";
import { resolvePersonOutputScope } from "../output-scope/model.js";
import { config } from "../config.js";
import { SceneBudget } from "./sceneBudget.js";
import { SceneError, type SceneStage } from "./sceneContract.js";
import { PARTS_HTTP_CONTRACT, REQUIRED_PARTS_ENGINE, authorizePartsSelection, validatePartsCapability,
  validatePartsResult, type PartsCapability, type PartsReceipt, type PartsRequest, type PartsSelection } from "./sceneParts.js";
import type { SceneSelectionRevisions } from "./sceneSelection.js";
import { type SceneDescriptions } from "./scenePartsDescriptions.js";
import type { RefinedScene } from "./sceneTypes.js";
export type { RefinedScene } from "./sceneTypes.js";
export type { SceneRef, SceneDirection, ScenePersonSummary } from "./sceneTypes.js";
import type { SceneRef } from "./sceneTypes.js";
export interface PartsExecution {
  selection: PartsSelection; requestId: string; descriptions: SceneDescriptions; capability: PartsCapability; selectionRevisions: SceneSelectionRevisions;
  setStage?: (stage: SceneStage) => void;
}
const defaults = { request: scenePartsRequest, composeRoughScene };
export async function prepareRefinedScene(owner: string, job: Job, refs: SceneRef[], sources: SceneSource[],
  overrides: Partial<typeof defaults> = {}, _artifactOnly = false,
  budget = new SceneBudget(config.sceneRefinementTimeoutMs), execution?: PartsExecution): Promise<RefinedScene> {
  if (!execution) throw new SceneError("PARTS_EXPLICIT_INTENT_REQUIRED", "explicit parts selection required", false, "parts_contract");
  execution.setStage?.("source_validation");
  const deps = { ...defaults, ...overrides };
  const { selection, descriptions, capability } = execution;
  authorizePartsSelection(selection, capability);
  if (!job.inputSha256 || !/^[a-f0-9]{64}$/.test(job.inputSha256) || !job.result?.image)
    throw new SceneError("SCENE_OBSERVATION_MISSING", "original input identity missing");
  const adjusted = sources.map(s => ({ ...s }));
  const parts: PartsReceipt[] = [];
  for (const edit of selection.edits) {
    execution.setStage?.("source_validation");
    const ref = refs.find(r => r.personIndex === edit.personIndex);
    const source = adjusted.find(s => s.person_index === edit.personIndex);
    const person = job.result.candidatesByPerson.find(p => p.personIndex === edit.personIndex);
    if (!ref || !source || !person || !person.candidates.some(c => c.id === ref.candidateId) ||
        sha256Hex(source.bytes) !== ref.sha256)
      throw new SceneError("SCENE_SOURCE_CHANGED", "parts selection changed");
    // A cropped asset cannot be reconstructed from a baseline without replacing
    // the exact reviewed input. Await a native final-FBX crop contract instead.
    if (resolvePersonOutputScope(person).resolved !== "full")
      throw new SceneError("SCENE_PARTS_SCOPE_UNSUPPORTED", "parts require current full FBX");
    const bytes = Buffer.from(source.bytes);
    if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 23).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")))
      throw new SceneError("PARTS_INVALID_INPUT", "invalid current FBX");
    const description = descriptions.find(d => d.personIndex === edit.personIndex);
    if (!description) throw new SceneError("SCENE_SOURCE_CHANGED", "description source unavailable");
    const request: PartsRequest = {
      contract_version: PARTS_HTTP_CONTRACT, engine_version: REQUIRED_PARTS_ENGINE,
      request_id: `parts_${randomBytes(16).toString("hex")}`,
      current_asset: { fbx_base64: bytes.toString("base64"), sha256: ref.sha256,
        review_reference: `selection_${sha256Hex(Buffer.from(JSON.stringify([owner, job.id, job.updatedAt, ref, execution.selectionRevisions, execution.requestId])))}` },
      intent: edit.intent, operation: edit.operation,
      context: { job_id: job.id, person_index: edit.personIndex, candidate_id: ref.candidateId,
        input_sha256: job.inputSha256, vlm_description: description.description, user_instruction: edit.intent.description },
    };
    execution.setStage?.("parts_refine");
    log.info({ type: "scene_parts_request", jobId: job.id, requestId: execution.requestId,
      workerRequestId: request.request_id, personIndex: edit.personIndex, candidateId: ref.candidateId,
      contractVersion: PARTS_HTTP_CONTRACT, expectedEngineVersion: REQUIRED_PARTS_ENGINE, inputArtifactSha256: ref.sha256 });
    const raw = await budget.run(() => deps.request("refine", request, { signal: budget.signal }));
    const result = validatePartsResult(raw, request, capability.catalog_sha256);
    log.info({ type: "scene_parts_result", jobId: job.id, requestId: execution.requestId,
      workerRequestId: request.request_id, engineVersion: result.receipt.engineVersion,
      outcome: result.receipt.status, reason: result.receipt.reason, adjustedLimbs: result.receipt.adjustedLimbs,
      inputArtifactSha256: result.receipt.inputSha256, nativeArtifactSha256: result.receipt.artifactSha256,
      scoreStatus: "not_scored" });
    source.bytes = result.bytes;
    parts.push({ ...result.receipt, bffRequestId: execution.requestId });
  }
  // Composition consumes returned native FBXs; no legacy plan/build or BVH path.
  execution.setStage?.("composition");
  let final: Awaited<ReturnType<typeof composeRoughScene>>;
  try {
    final = await budget.run(() => deps.composeRoughScene(job.id, job.result!.image!, adjusted, { signal: budget.signal }));
  } catch (error) {
    if (error instanceof SceneError) throw error;
    const code = error instanceof ConverterError && error.code === "CONVERTER_TIMEOUT" ? "SCENE_TIMEOUT"
      : error instanceof ConverterError && error.code === "CONVERTER_INTEGRITY" ? "SCENE_INTEGRITY"
      : error instanceof ConverterError && ["CONVERTER_UNAVAILABLE", "CONVERTER_DISABLED"].includes(error.code) ? "SCENE_UNAVAILABLE"
      : "SCENE_FAILED";
    throw new SceneError(code, "final scene composition failed", code === "SCENE_TIMEOUT", "composition");
  }
  budget.check();
  return { ...final, artifactContract: "verified-scene-fbx-v1", preview: "",
    previewSha256: sha256Hex(Buffer.alloc(0)), summary: [], parts };
}
export async function getScenePartsCapability(signal?: AbortSignal): Promise<PartsCapability> {
  return validatePartsCapability(await scenePartsRequest("capabilities", undefined, { signal }));
}
