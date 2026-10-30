/** Public save negotiation, independent of the private inference protocol. */
export const SCENE_SAVE_CONTRACT = "scene-save-v1";
export const SCENE_REVIEW_VERSION = "scene-review-v1";
export const SCENE_REVIEW_TTL_MS = 15 * 60_000;
export type SceneSaveMode = "original-selection" | "auto-correct-v4";
export function sceneSaveContract(original: boolean, refined: boolean) {
  return {
    version: SCENE_SAVE_CONTRACT,
    saveModes: [
      ...(original ? ["original-selection" as const] : []),
      ...(original && refined ? ["auto-correct-v4" as const] : []),
    ],
    partsDiscoveryRequired: true,
    manifestVersion: "csp-scene-manifest-v1",
    reviewVersion: SCENE_REVIEW_VERSION,
    reviewTtlSeconds: SCENE_REVIEW_TTL_MS / 1000,
    cancellation: { httpRequest: true, serverOperation: false },
  };
}
export const sceneRecovery = {
  SCENE_PARTIAL_CONFIRMATION_REQUIRED: "confirm_partial",
  GENERATED_INDIVIDUAL_ONLY: "change_selection",
  SCENE_CONTRACT_UNSUPPORTED: "refresh_capabilities",
  SCENE_REVIEW_REQUIRED: "prepare_again",
  SCENE_REVIEW_EXPIRED: "prepare_again",
  SCENE_SOURCE_CHANGED: "review_selection",
  SCENE_UNSUPPORTED_BODY: "change_selection",
  SCENE_UNAVAILABLE: "retry_later",
  SCENE_PARTS_UNAVAILABLE: "refresh_capabilities",
  PARTS_CONTRACT_UNSUPPORTED: "refresh_capabilities",
  PARTS_EXPLICIT_INTENT_REQUIRED: "review_selection",
  PARTS_RECIPE_UNAVAILABLE: "refresh_capabilities",
  PARTS_INTENT_MISMATCH: "review_selection",
  PARTS_INVALID_INPUT: "review_selection",
  PARTS_DISABLED: "retry_later",
  PARTS_UNAVAILABLE: "retry_later",
  PARTS_RELEASE_CHANGED: "refresh_capabilities",
  PARTS_TIMEOUT: "prepare_again",
  PARTS_WORKER_FAILED: "retry_later",
  PARTS_INTEGRITY: "prepare_again",
  SCENE_PARTS_SCOPE_UNSUPPORTED: "change_selection",
  SCENE_CANCELLED: "prepare_again",
  SCENE_BUSY: "retry_later",
  SCENE_TIMEOUT: "prepare_again",
  SCENE_INTEGRITY: "prepare_again",
  SCENE_FAILED: "retry_later",
  SCENE_OBSERVATION_MISSING: "analyze_again",
} as const;
export type SceneErrorCode = keyof typeof sceneRecovery;
export type SceneStage = "request_validation" | "source_validation" | "parts_contract" |
  "plan" | "build" | "parts_capabilities" | "parts_refine" | "composition" | "preview" | "receipt_publication" | "release";
export class SceneError extends Error {
  constructor(
    readonly code: SceneErrorCode, message: string,
    readonly serverOperationMayContinue = code === "SCENE_TIMEOUT",
    readonly stage?: SceneStage,
  ) {
    super(message);
    this.name = "SceneError";
  }
}
export function sceneErrorDetails(code: string, allowOriginal = false, serverOperationMayContinue = code === "SCENE_TIMEOUT",
  stage: SceneStage = "request_validation", jobId?: string) {
  if (!Object.hasOwn(sceneRecovery, code)) return undefined;
  return {
    phase: "scene_prepare",
    stage,
    jobId,
    retryable: ["SCENE_UNAVAILABLE", "SCENE_BUSY", "SCENE_TIMEOUT", "SCENE_FAILED",
      "PARTS_DISABLED", "PARTS_UNAVAILABLE", "PARTS_TIMEOUT", "PARTS_WORKER_FAILED"].includes(code),
    recovery: sceneRecovery[code as SceneErrorCode],
    allowedActions: [sceneRecovery[code as SceneErrorCode], ...(allowOriginal ? ["use_original_selection"] : [])],
    serverOperationMayContinue,
  };
}

export function sceneErrorStatus(code: string): 409 | 422 | 502 | 503 | 504 {
  if (["SCENE_TIMEOUT", "PARTS_TIMEOUT"].includes(code)) return 504;
  if (["SCENE_UNAVAILABLE", "SCENE_PARTS_UNAVAILABLE", "SCENE_BUSY", "PARTS_DISABLED", "PARTS_UNAVAILABLE", "PARTS_RELEASE_CHANGED"].includes(code)) return 503;
  if (code === "PARTS_INVALID_INPUT") return 422;
  if (["SCENE_UNSUPPORTED_BODY", "SCENE_SOURCE_CHANGED", "SCENE_CANCELLED", "SCENE_PARTS_SCOPE_UNSUPPORTED",
    "SCENE_OBSERVATION_MISSING", "SCENE_CONTRACT_UNSUPPORTED", "SCENE_REVIEW_REQUIRED", "SCENE_REVIEW_EXPIRED",
    "PARTS_CONTRACT_UNSUPPORTED", "PARTS_EXPLICIT_INTENT_REQUIRED", "PARTS_RECIPE_UNAVAILABLE", "PARTS_INTENT_MISMATCH"].includes(code)) return 409;
  return 502;
}
