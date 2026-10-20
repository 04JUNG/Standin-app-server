import { createHash } from "node:crypto";
import type { UpstreamPerson } from "../inference.js";
import type { PreviewCandidate } from "../pose-presentation.js";
import type { PoseCandidate } from "../types.js";

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Refine permission is independent of automatic release and manual export. */
export function refinableLibraryCandidate(c: PoseCandidate | undefined): boolean {
  const camera = c?.camera;
  return !!c && c.source === "library" && c.presentationKind === "library_match" &&
    c.refineAllowed === true && c.lookupAllowed === true && c.manualExportAllowed === true &&
    c.reviewRequired === true && c.notExactMatch === false && hash(c.sourceBvhSha256) &&
    camera?.version === "candidate-camera-v2" && camera.pose_id === c.poseId &&
    camera.source_bvh_sha256 === c.sourceBvhSha256 && hash(camera.query_sha256);
}

export function candidateRefineAllowed(c: PoseCandidate | undefined): boolean {
  return !!c && (refinableLibraryCandidate(c) ||
    (c.source === undefined && c.releaseAllowed !== false && c.refineAllowed !== false));
}

/** Accept only the inference server's explicit binding to this preview's source and camera. */
export function dynamicRefineBinding(person: UpstreamPerson, row: PreviewCandidate) {
  const kp = person.keypoints ?? person.skeleton?.keypoints;
  if (row.kind !== "library_match" || person.refine_allowed !== true ||
      !person.refinable_limbs?.length || row.camera_kind !== "fixed_117" ||
      row.render_camera.projection_matches_search !== true ||
      !kp || kp.length !== 17 || kp.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v)))) return null;
  const bytes = Buffer.alloc(17 * 2 * 4);
  kp.flat().forEach((v, i) => bytes.writeFloatLE(v === 0 ? 0 : v, i * 4));
  const query = createHash("sha256").update(bytes).digest("hex");
  const matches = (person.refine_candidates ?? []).filter(c => c.pose_id === row.pose_id);
  if (matches.length !== 1) return null;
  const binding = matches[0]!, camera = binding.camera;
  if (!camera || camera.version !== "candidate-camera-v2" || camera.pose_id !== row.pose_id ||
      camera.source_bvh_sha256 !== row.asset.bvh_sha256 || camera.query_sha256 !== query ||
      camera.labels_swapped !== false || camera.projection !== row.render_camera.projection ||
      camera.distance_torso !== row.render_camera.distance_torso ||
      !Array.isArray(camera.rotation) || camera.rotation.length !== 3 ||
      camera.rotation.some((r, i) => !Array.isArray(r) || r.length !== 3 ||
        r.some((v, j) => !Number.isFinite(v) || Math.abs(v - row.render_camera.rotation[i]![j]!) > 1e-6))) return null;
  return binding;
}
