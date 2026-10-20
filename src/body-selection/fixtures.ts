import type { CutResult } from "../inference.js";
import { createHash } from "node:crypto";
import type { AnalysisPerson, AnalysisResult } from "../types.js";
import { mapCutResult } from "../mapping.js";
import type { BodyCatalog } from "./model.js";
export function catalog(count = 3): BodyCatalog {
  return {
    version: "test",
    defaultCharacterId: "character-0",
    assets: Array.from({ length: count }, (_, i) => ({
      bodyId: `shape-${i}`,
      characterId: `character-${i}`,
      bodyVersion: "v1",
      assetSha256: String(i % 10).repeat(64),
      rigVersion: "rig1",
      measurementVersion: "m1",
      supportedPoseIds: ["pose-a", "pose-b"],
    })),
  };
}
export function fixture(): CutResult {
  const a = catalog().assets[1];
  const cut: CutResult = {
    route: "core",
    count_confidence: "high",
    detector_count: 2,
    vlm_count: 2,
    image: { width: 100, height: 100 },
    notes: [],
    inference_metadata: {
      deployment_version: "test",
      vlm_provider: "test",
      vlm_model: "test",
      pose_backend: "test",
      pose_model_version: "v1",
      pose_library_version: "v1",
      feature_version: 1,
    } as CutResult["inference_metadata"],
    people: [0, 1].map((index) => ({
      index,
      box: null,
      tags: {},
      skeleton: null,
      confidence: "high",
      candidates: [
        {
          pose_id: "pose-a",
          view: "front",
          distance: 0.1,
          tags: {},
          rerank_score: null,
          bvh_url: "/pose/pose-a/bvh",
          thumbnail_url: null,
        },
      ],
    })),
  };
  cut.body_matching = {
    schema_version: "body-match.v1",
    mode: "auto",
    status: "ok",
    input_sha256: "a".repeat(64),
    catalog_sha256: "b".repeat(64),
    catalog_version: "test",
    people: cut.people.map((p) => ({
      person_index: p.index,
      person_id: `${"a".repeat(64)}:p${p.index}`,
      auto_body_id: a.bodyId,
      applied_body_id: a.bodyId,
      selection_state: "selected",
      selection_source: "auto_best_effort",
      selected_asset: {
        body_id: a.bodyId,
        body_version: a.bodyVersion,
        asset_sha256: a.assetSha256,
        rig_version: a.rigVersion,
        measurement_version: a.measurementVersion,
      },
      pose_bindings: [{ pose_id: "pose-a", view: "front", pose_sha256: null }],
    })),
  };
  return cut;
}
export function result(): AnalysisResult {
  return mapCutResult("job_test", fixture());
}

/** Owned library metadata produced by the manual-selection mapper, without a fitted camera. */
export function makeManualPresentation(person: AnalysisPerson) {
  const rows = person.candidates.map((c) => {
    const camera = c.camera!;
    c.id = "preview_" + createHash("sha256").update(c.id).digest("hex");
    c.source = "library";
    c.lookupAllowed = true;
    c.releaseAllowed = true;
    c.refineAllowed = false;
    c.bvhAvailable = true;
    c.sourceBvhSha256 = camera.source_bvh_sha256;
    c.camera = undefined;
    return {
      candidate_id: c.id,
      pose_id: c.poseId,
      source: "library" as const,
      kind: "library_match",
      rank: c.rank,
      camera_kind: "viewer_default",
      render_camera: {
        version: "pose-preview-camera-v1" as const,
        projection: "orthographic" as const,
        rotation: camera.rotation,
        yaw_degrees: 0,
        pitch_degrees: 0,
        roll_degrees: 0,
        distance_torso: null,
        basis: "right-handed-Y-up" as const,
        rotation_order: "Rz@Rx@Ry_column_vectors" as const,
        origin: "hip_midpoint" as const,
        scale: "hip_to_shoulder_midpoint_length" as const,
        screen_y: "down" as const,
        projection_rule: "xy=(x,-y)" as const,
        projection_matches_search: false,
        fit_to_rough_pixels: false as const,
        bvh_camera_rotation_applied: false as const,
      },
      score_kind: null,
      rank_score: null,
      score_is_accuracy: false as const,
      asset: {
        transport: "library_bvh" as const,
        bvh_sha256: c.sourceBvhSha256,
        preview_bvh_url: "/v1/test",
      },
      lookup_allowed: true as const,
      review_required: true as const,
      auto_apply_allowed: false as const,
      refine_allowed: false as const,
      export_allowed: false as const,
      release_allowed: false as const,
      actual_mesh_validated: false as const,
    };
  });
  person.posePresentation = {
    version: "dynamic-pose-presentation-v1",
    person_index: person.personIndex,
    route: "hybrid",
    status: "ready",
    search_status: "ok",
    search_reason: null,
    generation_status: null,
    generation_reason: null,
    output_scope: "full",
    unobserved_body_is_default: null,
    library_candidates: rows,
    review_candidates: [],
    generated_candidates: [],
    basic_model: null,
    issues: [],
    preview_status: "ready",
    auto_apply_allowed: false,
    refine_allowed: false,
    export_allowed: false,
  };
}
