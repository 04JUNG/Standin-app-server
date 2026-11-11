import type { SceneSelectionRevisions } from "./sceneSelection.js";
import type { Job } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";
import { SCENE_SAVE_CONTRACT, SCENE_REVIEW_VERSION, type SceneSaveMode } from "./sceneContract.js";
import { REQUIRED_PARTS_ENGINE, SCENE_EXECUTION_CONTRACT } from "./sceneParts.js";
import type { PartsSelection } from "./sceneParts.js";
import type { SceneDescriptions } from "./scenePartsDescriptions.js";
import type { SceneRef } from "./sceneRefinement.js";

function digest(value: unknown): string {
  // DB JSON object key order is not part of the selection identity.
  return sha256Hex(Buffer.from(JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)));
}

/** Capture before asynchronous work; do not rely solely on a mutable timestamp. */
export function sceneSourceIdentity(job: Job): string {
  return digest([job.id, job.updatedAt, job.inputS3Key, job.inputSha256 ?? null,
    job.inputWidth ?? null, job.inputHeight ?? null, job.result?.image,
    job.result?.inferenceMetadata, job.result?.candidatesByPerson]);
}

export function sceneReviewBinding(owner: string, jobId: string, sourceIdentity: string,
  refs: SceneRef[], saveMode: SceneSaveMode, excludedIds: number[], cameraNegotiated: boolean, parts?: PartsSelection, descriptions?: SceneDescriptions, selectionRevisions?: SceneSelectionRevisions): string {
  return digest([SCENE_EXECUTION_CONTRACT, SCENE_SAVE_CONTRACT, SCENE_REVIEW_VERSION,
    // This is an EXPECTATION in the cache identity, never execution evidence.
    saveMode === "auto-correct-v4" ? REQUIRED_PARTS_ENGINE : null,
    owner, jobId, sourceIdentity, refs, saveMode, excludedIds,
    cameraNegotiated ? "scene-camera-artifact-v1" : null, parts ?? null, descriptions ?? null, selectionRevisions ?? null]);
}
