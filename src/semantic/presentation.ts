import { createHash } from "node:crypto";
import type { AnalysisResult } from "../types.js";
import type { RefineContext } from "../mapping.js";
import type {
  RenderCamera,
  PreviewCandidate,
  PrivatePreviewAsset,
  PosePresentation,
} from "../pose-presentation.js";

// Text retrieval has no search camera. This explicit front reference is never a fitted view.
const front: RenderCamera = {
  version: "pose-preview-camera-v1",
  projection: "orthographic",
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  yaw_degrees: 0,
  pitch_degrees: 0,
  roll_degrees: 0,
  distance_torso: null,
  basis: "right-handed-Y-up",
  rotation_order: "Rz@Rx@Ry_column_vectors",
  origin: "hip_midpoint",
  scale: "hip_to_shoulder_midpoint_length",
  screen_y: "down",
  projection_rule: "xy=(x,-y)",
  projection_matches_search: false,
  fit_to_rough_pixels: false,
  bvh_camera_rotation_applied: false,
};
export function attachSemanticPresentation(
  result: AnalysisResult,
): RefineContext {
  const person = result.candidatesByPerson[0]!;
  const assets: Record<string, PrivatePreviewAsset> = {};
  const matches: PreviewCandidate[] = [],
    near: PreviewCandidate[] = [];
  for (const c of person.candidates) {
    if (!c.sourceBvhSha256) throw Error("missing semantic asset binding");
    const kind = c.semantic?.near ? "near_match" : "library_match";
    const id =
      "preview_" +
      createHash("sha256")
        .update(
          JSON.stringify([
            result.jobId,
            0,
            kind,
            c.poseId,
            c.sourceBvhSha256,
            front,
            "full",
          ]),
        )
        .digest("hex");
    c.id = id;
    c.posterUrl = `/v1/pose-candidates/${encodeURIComponent(c.poseId!)}/poster?${new URLSearchParams({ jobId: result.jobId, personIndex: "0", candidateId: id })}`;
    assets[id] = {
      transport: "library_bvh",
      pose_id: c.poseId,
      bvh_sha256: c.sourceBvhSha256,
    };
    const list = kind === "near_match" ? near : matches;
    list.push({
      candidate_id: id,
      pose_id: c.poseId,
      source: "library",
      kind,
      rank: list.length + 1,
      camera_kind: "front_reference",
      render_camera: structuredClone(front),
      score_kind: "semantic_similarity",
      rank_score: c.rankScore ?? null,
      score_is_accuracy: false,
      asset: {
        transport: "library_bvh",
        bvh_sha256: c.sourceBvhSha256,
        preview_bvh_url: `/v1/analysis/jobs/${encodeURIComponent(result.jobId)}/people/0/pose-previews/${id}/${c.sourceBvhSha256}`,
      },
      lookup_allowed: true,
      review_required: true,
      auto_apply_allowed: false,
      refine_allowed: false,
      export_allowed: false,
      release_allowed: false,
      actual_mesh_validated: false,
    });
  }
  const presentation: PosePresentation = {
    version: "semantic-pose-presentation-v1",
    person_index: 0,
    route: "semantic_text",
    status: matches.length ? "ready" : "review_ready",
    search_status: matches.length ? "ok" : "no_result",
    search_reason: null,
    generation_status: "not_requested",
    generation_reason: null,
    output_scope: "full",
    unobserved_body_is_default: null,
    library_candidates: matches,
    review_candidates: near,
    generated_candidates: [],
    basic_model: null,
    issues: [],
    preview_status: "available",
    auto_apply_allowed: false,
    refine_allowed: false,
    export_allowed: false,
  };
  person.posePresentation = presentation;
  return {
    personIndex: 0,
    keypoints: null,
    scores: null,
    rawScores: null,
    qualityReasons: ["text_search_no_image"],
    qualityTrace: {},
    slotOrigin: null,
    lowerBodyObserved: false,
    posePresentationAssets: assets,
  };
}
