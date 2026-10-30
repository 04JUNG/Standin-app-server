import { sha256Hex } from "../converter/client.js";
import { SceneError } from "./sceneContract.js";

export const REQUIRED_PARTS_ENGINE = "refine-v4-parts.1";
export const PARTS_HTTP_CONTRACT = "refine-v4-parts-http-v1";
export const SCENE_EXECUTION_CONTRACT = "scene-execution-binding-v1";
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, limit: number): v is string => typeof v === "string" && !!v.trim() && v.length <= limit;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join() === expected.sort().join();
export type PartsOperation = { type: "advance_foot"; side: "left" | "right"; distance_m: number } |
  { type: "recipe"; recipe_id: string };
export interface PartsIntent { source: "user_confirmed"; reference: string; description: string }
export interface PartsEdit { personIndex: number; intent: PartsIntent; operation: PartsOperation }
export interface PartsSelection {
  contractVersion: typeof PARTS_HTTP_CONTRACT;
  engineVersion: typeof REQUIRED_PARTS_ENGINE;
  catalogSha256: string | null;
  edits: PartsEdit[];
}
export interface PartsCapability {
  contract_version: typeof PARTS_HTTP_CONTRACT;
  engine_version: typeof REQUIRED_PARTS_ENGINE;
  available: boolean;
  catalog_sha256: string | null;
  operations: ("advance_foot" | "recipe")[];
  recipes: { id: string; label: string; description: string }[];
  automatic_image_extraction: false;
  requires_explicit_intent: true;
  requires_artifact_review: true;
}
export interface PartsRequest {
  contract_version: typeof PARTS_HTTP_CONTRACT;
  engine_version: typeof REQUIRED_PARTS_ENGINE;
  request_id: string;
  current_asset: { fbx_base64: string; sha256: string; review_reference: string };
  intent: PartsIntent;
  operation: PartsOperation;
  context: { job_id: string; person_index: number; candidate_id: string; input_sha256: string;
    vlm_description: string | null; user_instruction: string };
}
export interface PartsReceipt {
  personIndex: number; candidateId: string;
  contractVersion: typeof PARTS_HTTP_CONTRACT; engineVersion: typeof REQUIRED_PARTS_ENGINE;
  requestId: string; requestSha256: string; contextSha256: string; catalogSha256: string | null;
  engineExecuted: true; status: "applied" | "retained"; applied: boolean;
  reason: null | "PARTS_UNCHANGED" | "PARTS_REJECTED";
  adjustedLimbs: string[]; inputSha256: string; artifactSha256: string;
  scoreStatus: "not_scored";
  bffRequestId?: string;
  savedVerification: { matrixError: number; surfaceErrorM: number } | null;
  provenance: { vlmDescription: "stored_analysis" | "not_recorded"; userInstruction: "user_confirmed" };
}

export function parsePartsSelection(raw: unknown): PartsSelection {
  if (!object(raw)) throw new SceneError("PARTS_EXPLICIT_INTENT_REQUIRED", "explicit parts selection required", false, "parts_contract");
  if (raw.contractVersion !== PARTS_HTTP_CONTRACT || raw.engineVersion !== REQUIRED_PARTS_ENGINE)
    throw new SceneError("PARTS_CONTRACT_UNSUPPORTED", "unsupported parts contract", false, "parts_contract");
  if (!keys(raw, ["contractVersion", "engineVersion", "catalogSha256", "edits"]) ||
      !(raw.catalogSha256 === null || sha(raw.catalogSha256)) || !Array.isArray(raw.edits) || !raw.edits.length || raw.edits.length > 8)
    throw new SceneError("PARTS_INVALID_INPUT", "invalid parts selection");
  const seen = new Set<number>();
  const edits = raw.edits.map((edit: unknown) => {
    if (!object(edit) || !keys(edit, ["personIndex", "intent", "operation"]) ||
        !Number.isInteger(edit.personIndex) || (edit.personIndex as number) < 0 || (edit.personIndex as number) > 255 || seen.has(edit.personIndex as number))
      throw new SceneError("PARTS_INVALID_INPUT", "invalid parts person");
    seen.add(edit.personIndex as number);
    const intent = edit.intent, operation = edit.operation;
    if (!object(intent) || !keys(intent, ["source", "reference", "description"]) ||
        intent.source !== "user_confirmed" || !id(intent.reference) || !text(intent.description, 4096))
      throw new SceneError("PARTS_EXPLICIT_INTENT_REQUIRED", "confirmed intent required");
    if (!object(operation) || !(operation.type === "recipe" && keys(operation, ["type", "recipe_id"]) && id(operation.recipe_id) ||
      operation.type === "advance_foot" && keys(operation, ["type", "side", "distance_m"]) &&
      ["left", "right"].includes(operation.side as string) && typeof operation.distance_m === "number" &&
      Number.isFinite(operation.distance_m) && operation.distance_m > 0 && operation.distance_m <= .1))
      throw new SceneError("PARTS_INVALID_INPUT", "invalid parts operation");
    return { personIndex: edit.personIndex as number, intent: { ...intent } as unknown as PartsIntent,
      operation: { ...operation } as PartsOperation };
  });
  return { contractVersion: PARTS_HTTP_CONTRACT, engineVersion: REQUIRED_PARTS_ENGINE, catalogSha256: raw.catalogSha256, edits };
}

export function validatePartsCapability(raw: unknown): PartsCapability {
  if (!object(raw) || raw.contract_version !== PARTS_HTTP_CONTRACT || raw.engine_version !== REQUIRED_PARTS_ENGINE)
    throw new SceneError("PARTS_CONTRACT_UNSUPPORTED", "parts worker contract differs", false, "parts_capabilities");
  if (raw.available === false) throw new SceneError("PARTS_DISABLED", "parts worker disabled", false, "parts_capabilities");
  if (raw.available !== true || raw.automatic_image_extraction !== false || raw.requires_explicit_intent !== true ||
      raw.requires_artifact_review !== true || !(raw.catalog_sha256 === null || sha(raw.catalog_sha256)) ||
      !Array.isArray(raw.operations) || !raw.operations.length || new Set(raw.operations).size !== raw.operations.length ||
      raw.operations.some(v => v !== "advance_foot" && v !== "recipe") || !Array.isArray(raw.recipes) || raw.recipes.length > 256)
    throw new SceneError("PARTS_INTEGRITY", "invalid parts capability", false, "parts_capabilities");
  const recipes = raw.recipes.map((r: unknown) => {
    if (!object(r) || !id(r.id) || !text(r.label, 256) || !text(r.description, 4096))
      throw new SceneError("PARTS_INTEGRITY", "invalid parts recipe");
    return { id: r.id, label: r.label, description: r.description };
  });
  if (new Set(recipes.map(r => r.id)).size !== recipes.length ||
      (raw.operations.includes("recipe") && (!sha(raw.catalog_sha256) || !recipes.length)))
    throw new SceneError("PARTS_INTEGRITY", "invalid parts catalog");
  return { contract_version: PARTS_HTTP_CONTRACT, engine_version: REQUIRED_PARTS_ENGINE, available: true,
    catalog_sha256: raw.catalog_sha256, operations: raw.operations as PartsCapability["operations"], recipes,
    automatic_image_extraction: false, requires_explicit_intent: true, requires_artifact_review: true };
}

export function authorizePartsSelection(selection: PartsSelection, cap: PartsCapability) {
  if (cap.catalog_sha256 !== selection.catalogSha256)
    throw new SceneError("PARTS_RELEASE_CHANGED", "parts catalog changed", false, "parts_capabilities");
  for (const edit of selection.edits) {
    if (!cap.operations.includes(edit.operation.type)) throw new SceneError("PARTS_RECIPE_UNAVAILABLE", "operation unavailable");
    if (edit.operation.type === "recipe") {
      const recipeId = edit.operation.recipe_id;
      const recipe = cap.recipes.find(r => r.id === recipeId);
      if (!recipe) throw new SceneError("PARTS_RECIPE_UNAVAILABLE", "recipe unavailable");
      if (recipe.description !== edit.intent.description) throw new SceneError("PARTS_INTENT_MISMATCH", "recipe intent differs");
    }
  }
}

/** Match Python json.dumps(sort_keys=True, ensure_ascii=True), used by server #153.
 * Payload numbers are only integer person indices and a finite distance <= .1.
 */
export function partsCanonicalJson(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SceneError("PARTS_INVALID_INPUT", "invalid numeric input");
    const n = v !== 0 && Math.abs(v) < .0001 && !Number.isInteger(v) ? v.toExponential() : String(v);
    return n.replace(/e([+-])(\d)$/, "e$10$2");
  }
  if (Array.isArray(v)) return `[${v.map(partsCanonicalJson).join(", ")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${partsCanonicalJson(k)}: ${partsCanonicalJson(v[k])}`).join(", ")}}`;
  if (v === null || typeof v === "boolean") return String(v);
  throw new SceneError("PARTS_INVALID_INPUT", "invalid request value");
}
export const partsDigest = (v: unknown) => sha256Hex(Buffer.from(partsCanonicalJson(v)));

export function validatePartsResult(raw: unknown, request: PartsRequest, catalogSha: string | null) {
  const bad = () => new SceneError("PARTS_INTEGRITY", "parts receipt mismatch", false, "parts_refine");
  if (!object(raw) || raw.contract_version !== PARTS_HTTP_CONTRACT || raw.engine_version !== REQUIRED_PARTS_ENGINE ||
      raw.engine_executed !== true || raw.request_id !== request.request_id || raw.request_sha256 !== partsDigest(request) ||
      raw.context_sha256 !== partsDigest(request.context) || raw.catalog_sha256 !== catalogSha ||
      raw.input_sha256 !== request.current_asset.sha256 || !sha(raw.artifact_sha256) || typeof raw.fbx_base64 !== "string" ||
      raw.fbx_base64.length > 4 * Math.ceil(32 * 1024 * 1024 / 3) ||
      raw.requires_artifact_review !== true || raw.release_allowed !== false || raw.score_status !== "not_scored" ||
      !object(raw.intent) || !object(raw.operation) || partsCanonicalJson(raw.intent) !== partsCanonicalJson(request.intent) || partsCanonicalJson(raw.operation) !== partsCanonicalJson(request.operation) ||
      !Array.isArray(raw.adjusted_limbs) || new Set(raw.adjusted_limbs).size !== raw.adjusted_limbs.length ||
      raw.adjusted_limbs.some(v => !["left_arm", "right_arm", "left_leg", "right_leg"].includes(v as string))) throw bad();
  const bytes = Buffer.from(raw.fbx_base64, "base64");
  if (bytes.toString("base64") !== raw.fbx_base64 || sha256Hex(bytes) !== raw.artifact_sha256 ||
      !bytes.subarray(0, 23).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0"))) throw bad();
  if (raw.status === "applied") {
    if (raw.applied !== true || raw.reason !== null || !raw.adjusted_limbs.length ||
        raw.artifact_contract !== "verified-parts-fbx-v1" || raw.artifact_sha256 === request.current_asset.sha256 ||
        !object(raw.saved_verification) || [raw.saved_verification.matrix_error, raw.saved_verification.surface_error_m]
          .some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 2e-5)) throw bad();
    if (request.operation.type === "advance_foot" &&
        (raw.adjusted_limbs.length !== 1 || raw.adjusted_limbs[0] !== `${request.operation.side}_leg`)) throw bad();
  } else if (raw.status !== "retained" || raw.applied !== false || !["PARTS_UNCHANGED", "PARTS_REJECTED"].includes(raw.reason as string) ||
      raw.adjusted_limbs.length !== 0 || raw.artifact_contract !== "retained-current-fbx-v1" ||
      raw.fbx_base64 !== request.current_asset.fbx_base64) throw bad();
  const receipt: PartsReceipt = {
    personIndex: request.context.person_index, candidateId: request.context.candidate_id,
    contractVersion: PARTS_HTTP_CONTRACT, engineVersion: REQUIRED_PARTS_ENGINE, engineExecuted: true,
    requestId: request.request_id, requestSha256: raw.request_sha256 as string, contextSha256: raw.context_sha256 as string,
    catalogSha256: catalogSha, status: raw.status as PartsReceipt["status"], applied: raw.applied as boolean,
    reason: raw.reason as PartsReceipt["reason"], adjustedLimbs: raw.adjusted_limbs as string[],
    inputSha256: raw.input_sha256 as string, artifactSha256: raw.artifact_sha256, scoreStatus: "not_scored",
    savedVerification: raw.status === "applied" ? { matrixError: (raw.saved_verification as Record<string, number>).matrix_error,
      surfaceErrorM: (raw.saved_verification as Record<string, number>).surface_error_m } : null,
    provenance: { vlmDescription: request.context.vlm_description === null ? "not_recorded" : "stored_analysis", userInstruction: "user_confirmed" },
  };
  return { bytes, receipt };
}

export function scenePartsCapability() {
  return { contractVersion: PARTS_HTTP_CONTRACT, requiredEngineVersion: REQUIRED_PARTS_ENGINE,
    serviceReadiness: "unverified" as const, requestEligibility: "unverified" as const,
    requiresExplicitIntent: true, automaticImageExtraction: false, executionStatus: "not_attempted" as const };
}

/** Recheck persisted execution metadata before displaying it on another replica. */
export function validateStoredPartsReceipts(value: unknown): PartsReceipt[] {
  const bad = () => new SceneError("PARTS_INTEGRITY", "stored parts receipt mismatch");
  if (!Array.isArray(value) || !value.length || value.length > 8) throw bad();
  const seen = new Set<number>();
  return value.map((r: unknown) => {
    if (!object(r) || !Number.isInteger(r.personIndex) || (r.personIndex as number) < 0 || (r.personIndex as number) > 255 || seen.has(r.personIndex as number) ||
        !text(r.candidateId, 256) || r.contractVersion !== PARTS_HTTP_CONTRACT || r.engineVersion !== REQUIRED_PARTS_ENGINE ||
        !id(r.requestId) || !sha(r.requestSha256) || !sha(r.contextSha256) || !sha(r.inputSha256) || !sha(r.artifactSha256) ||
        !(r.catalogSha256 === null || sha(r.catalogSha256)) || r.engineExecuted !== true || r.scoreStatus !== "not_scored" ||
        !Array.isArray(r.adjustedLimbs) || new Set(r.adjustedLimbs).size !== r.adjustedLimbs.length ||
        r.adjustedLimbs.some(v => !["left_arm", "right_arm", "left_leg", "right_leg"].includes(v as string)) ||
        !object(r.provenance) || !["stored_analysis", "not_recorded"].includes(r.provenance.vlmDescription as string) ||
        r.provenance.userInstruction !== "user_confirmed" || !id(r.bffRequestId)) throw bad();
    if (r.status === "applied") {
      if (r.applied !== true || r.reason !== null || !r.adjustedLimbs.length || r.inputSha256 === r.artifactSha256 ||
          !object(r.savedVerification) || [r.savedVerification.matrixError, r.savedVerification.surfaceErrorM]
            .some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 2e-5)) throw bad();
    } else if (r.status !== "retained" || r.applied !== false || !["PARTS_UNCHANGED", "PARTS_REJECTED"].includes(r.reason as string) ||
        r.adjustedLimbs.length || r.savedVerification !== null || r.inputSha256 !== r.artifactSha256) throw bad();
    seen.add(r.personIndex as number);
    // Stored data is trusted only after validation; never forward unexpected fields.
    return { personIndex: r.personIndex, candidateId: r.candidateId, contractVersion: r.contractVersion, engineVersion: r.engineVersion,
      requestId: r.requestId, requestSha256: r.requestSha256, contextSha256: r.contextSha256, catalogSha256: r.catalogSha256,
      engineExecuted: true, status: r.status, applied: r.applied, reason: r.reason, adjustedLimbs: r.adjustedLimbs,
      inputSha256: r.inputSha256, artifactSha256: r.artifactSha256, scoreStatus: "not_scored", bffRequestId: r.bffRequestId,
      savedVerification: r.status === "applied" ? { matrixError: (r.savedVerification as Record<string, number>).matrixError,
        surfaceErrorM: (r.savedVerification as Record<string, number>).surfaceErrorM } : null, provenance: { vlmDescription: r.provenance.vlmDescription, userInstruction: "user_confirmed" } } as PartsReceipt;
  });
}
