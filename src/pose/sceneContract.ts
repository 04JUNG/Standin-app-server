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
    reviewVersion: SCENE_REVIEW_VERSION,
    reviewTtlSeconds: SCENE_REVIEW_TTL_MS / 1000,
    cancellation: { httpRequest: true, serverOperation: false },
  };
}
export const sceneRecovery = {
  SCENE_CONTRACT_UNSUPPORTED: "refresh_capabilities",
  SCENE_REVIEW_REQUIRED: "prepare_again",
  SCENE_REVIEW_EXPIRED: "prepare_again",
  SCENE_SOURCE_CHANGED: "review_selection",
  SCENE_UNSUPPORTED_BODY: "change_selection",
  SCENE_UNAVAILABLE: "retry_later",
  SCENE_BUSY: "retry_later",
  SCENE_TIMEOUT: "prepare_again",
  SCENE_INTEGRITY: "prepare_again",
  SCENE_FAILED: "retry_later",
  SCENE_OBSERVATION_MISSING: "analyze_again",
} as const;
export type SceneErrorCode = keyof typeof sceneRecovery;
export class SceneError extends Error {
  constructor(readonly code: SceneErrorCode, message: string) {
    super(message);
    this.name = "SceneError";
  }
}
export function sceneErrorDetails(code: string, allowOriginal = false) {
  if (!Object.hasOwn(sceneRecovery, code)) return undefined;
  return {
    recovery: sceneRecovery[code as SceneErrorCode],
    allowedActions: [sceneRecovery[code as SceneErrorCode], ...(allowOriginal ? ["use_original_selection"] : [])],
    serverOperationMayContinue: code === "SCENE_TIMEOUT",
  };
}
