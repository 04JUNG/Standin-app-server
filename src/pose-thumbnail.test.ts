import assert from "node:assert/strict";
import test from "node:test";

process.env.POSE_THUMBNAIL_REVISION = "mesh-20261019";
const { poseThumbnailUrl, humanThumbnailUrl } = await import("./pose-thumbnail.js");
const { toHistoryItem } = await import("./jobs/history.js");

test("a new library image revision bypasses the previous history image cache", () => {
  const url = poseThumbnailUrl("pose/a b", "three_quarter");
  assert.equal(url, "/v1/pose-candidates/pose%2Fa%20b/thumbnail?view=three_quarter&revision=mesh-20261019");
  const item = toHistoryItem({ id: "job-1", status: "completed", created_at: "2026-10-19T00:00:00.000Z",
    completed_at: null, error_code: null, source: "semantic", input_width: null, input_height: null,
    has_input: false, person_count: 1, selection_count: 1, thumb_pose_id: "pose/a b", thumb_view: "three_quarter" });
  assert.equal(item.thumbnailUrl, humanThumbnailUrl("pose/a b"));
  assert.equal(item.thumbnailUrl, "/v1/pose-candidates/pose%2Fa%20b/reference-thumbnail?revision=human-poster-v1&assetRevision=mesh-20261019");
  assert.notEqual(url, "/v1/pose-candidates/pose%2Fa%20b/thumbnail?view=three_quarter");
});
