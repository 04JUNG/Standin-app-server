import { validateSceneCamera, type SceneCameraBinding } from "./sceneCamera.js";
import type { Job } from "../jobs/store.js";
import type { SceneSaveMode } from "./sceneContract.js";
export const SCENE_MANIFEST_VERSION = "csp-scene-manifest-v1";
export function sourceImageIdentity(job: Job) {
  return {
    identity: `${job.id}:input`,
    originalName: job.inputOriginalName ?? null,
    sha256: job.inputSha256 ?? null,
    width: job.inputWidth ?? job.result?.image?.width ?? null,
    height: job.inputHeight ?? job.result?.image?.height ?? null,
    captureMapping: { status: "unavailable" as const, reason: "not_recorded" as const },
  };
}
/** Omitted people are not silently promoted to successfully saved people. */
export function scenePeople(job: Job, requestedIds: number[], excludedIds: number[]) {
  const detected = job.result!.candidatesByPerson;
  const missing = detected.filter(p => !requestedIds.includes(p.personIndex)).map(p => ({
    personIndex: p.personIndex,
    reason: !p.candidates.length ? "no_candidates" as const
      : excludedIds.includes(p.personIndex) ? "user_excluded" as const : "not_requested" as const,
  }));
  return {
    detectedIds: detected.map(p => p.personIndex), requestedIds, includedIds: requestedIds,
    missing, partial: missing.length > 0, confirmationRequired: missing.length > 0,
  };
}
export function sceneManifest(job: Job, snapshotSha256: string, artifactSha256: string,
  saveMode: SceneSaveMode, people: ReturnType<typeof scenePeople>, camera?: SceneCameraBinding) {
  if (camera) validateSceneCamera(camera, artifactSha256, job.result?.image ?? undefined);
  const sourceImage = sourceImageIdentity(job);
  const mapped = !camera || (sourceImage.width === camera.recipe.source_dimensions[0] &&
    sourceImage.height === camera.recipe.source_dimensions[1]);
  const availableCamera = mapped ? camera : undefined;
  return {
    version: SCENE_MANIFEST_VERSION,
    jobId: job.id, snapshotSha256, sourceImage,
    artifact: { sha256: artifactSha256, saveMode,
      layoutVersion: saveMode === "auto-correct-v4" ? "scene-refinement-v4" : "rough-layout-v1", fileCount: 1 },
    people,
    // Only forward a verified compiler recipe; CSP application remains unverified.
    camera: availableCamera ? { version: "scene-camera-v1", status: "available", reason: null,
      artifactSha256, recipe: availableCamera.recipe, applicationRequired: true, automaticApplication: "unsupported", cspValidation: "unverified" } : { version: "scene-camera-v1", status: "unavailable", reason: mapped ? "converter_recipe_not_provided" : "source_dimensions_unmapped",
      recipe: null, applicationRequired: true, automaticApplication: "unsupported", cspValidation: "unverified" },
  };
}
export type SceneManifest = ReturnType<typeof sceneManifest>;
