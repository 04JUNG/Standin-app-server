import { generatedChecksFailed } from "./generated-policy.js";
/** Source identity is independent of manual review permission. Never use request bytes or URLs. */
import type { AnalysisPerson, PoseCandidate } from "./types.js";
import { loadAssets, manualPresentationCamera } from "./pose-presentation.js";
import { previewAssetBytes } from "./hands/preview.js";
import { getPoseBvh } from "./inference.js";
import { BodyError } from "./body-selection/store.js";
import { sha256Hex } from "./converter/client.js";
export const candidatePathId = (candidate: PoseCandidate) => candidate.poseId ?? candidate.id;
export async function candidateSourceBytes(
  jobId: string, person: AnalysisPerson, candidate: PoseCandidate,
  fetchBvh = getPoseBvh, assetsFor = loadAssets,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (candidate.source === "generation") {
    const row = person.posePresentation?.generated_candidates.find(c => c.candidate_id === candidate.id);
    const asset = (await assetsFor(jobId, person.personIndex))[candidate.id];
    if (candidate.poseId !== null || !manualPresentationCamera(person, candidate) ||
        person.posePresentation?.generation_status !== "preview_ready" || !row ||
        !asset)
      throw new BodyError("GENERATED_SOURCE_UNAVAILABLE", 409);
    if (generatedChecksFailed(asset.validation))
      throw new BodyError("GENERATED_CHECKS_FAILED", 409);
    if (asset.transport !== "inline_bvh" || asset.pose_id !== null ||
        row.asset.transport !== asset.transport || asset.bvh_sha256 !== candidate.sourceBvhSha256)
      throw new BodyError("PREVIEW_SOURCE_CHANGED", 409);
    bytes = await previewAssetBytes(asset, fetchBvh);
  } else {
    if (!candidate.poseId) throw new BodyError("POSE_UNAVAILABLE", 409);
    if (candidate.sourceBvhSha256) bytes = await previewAssetBytes({ transport: "library_bvh", pose_id: candidate.poseId,
      bvh_sha256: candidate.sourceBvhSha256 }, fetchBvh);
    else {
      const response = await fetchBvh(candidate.poseId);
      if (!response.ok) { await response.body?.cancel(); throw new BodyError("POSE_UNAVAILABLE", 409); }
      bytes = new Uint8Array(await response.arrayBuffer());
    }
  }
  if (candidate.sourceBvhSha256 && sha256Hex(bytes) !== candidate.sourceBvhSha256)
    throw new BodyError("PREVIEW_HASH_MISMATCH", 409);
  return bytes;
}
