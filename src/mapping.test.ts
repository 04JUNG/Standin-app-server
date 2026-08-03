import assert from "node:assert/strict";
import test from "node:test";
import { mapCutResult } from "./mapping.js";

test("mapping preserves skeleton lineage and inference versions", () => {
  const result = mapCutResult("job-1", {
    route: "core",
    count_confidence: "high",
    detector_count: 1,
    vlm_count: 1,
    image: { width: 100, height: 200 },
    inference_metadata: {
      deployment_version: "sha",
      vlm_provider: "mock",
      vlm_model: "mock",
      pose_backend: "mock",
      pose_model_version: "1",
      pose_library_version: "v1",
      feature_version: 1,
    },
    people: [
      {
        index: 0,
        box: [0, 0, 10, 20],
        tags: { action: "standing" },
        skeleton: { schema_version: "coco17-v1", keypoints: [[1, 2]], scores: [0.9] },
        confidence: "high",
        candidates: [
          {
            pose_id: "pose-1",
            view: "front",
            distance: 0.2,
            tags: { action: "standing" },
            rerank_score: null,
            bvh_url: "/pose/pose-1/bvh",
            thumbnail_url: null,
          },
        ],
      },
    ],
    notes: [],
  });
  assert.equal(result.inferenceMetadata.poseLibraryVersion, "v1");
  assert.deepEqual(result.candidatesByPerson[0]?.skeleton?.scores, [0.9]);
  assert.equal(result.candidatesByPerson[0]?.candidates[0]?.rank, 1);
  assert.equal(result.candidatesByPerson[0]?.candidateCount, 1);
  assert.equal(
    result.candidatesByPerson[0]?.candidateShortfallReason,
    "UPSTREAM_FEWER_THAN_REQUESTED",
  );
});
