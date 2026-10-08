import type { CutResult } from "../inference.js";
import type { AnalysisResult } from "../types.js";
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
