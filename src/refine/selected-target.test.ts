import test from "node:test";
import assert from "node:assert/strict";
import { selectedRefineTarget } from "./selected-target.js";
import type { StoredRefineContext } from "./store.js";

const context = (): StoredRefineContext => ({
  keypoints: Array.from({ length: 17 }, (_, i) => [10 * i, 20 * i]),
  scores: Array(17).fill(1), refineAllowed: true, refinableLimbs: ["left_arm", "right_leg"],
  lowerBodyObserved: true, skeletonState: "valid", coverageClass: "full", slotOrigin: "vlm", skeletonSource: "full_image",
});
test("public targets use observed pixels and real image size, masking absent points and faces", () => {
  const c = context();c.scores![9] = 0;c.keypoints[15] = [NaN, 1];
  const target = selectedRefineTarget(c, 400, 800)!;
  assert.deepEqual(target.targetJoints, [7, 14, 16]);
  assert.deepEqual(target.skeleton.points[7], [.175, .175]);
  assert.deepEqual(target.skeleton.points.slice(0, 5), Array(5).fill(null));
  assert.equal(target.skeleton.points[9], null);
  assert.equal(target.skeleton.points[15], null);
  assert.doesNotMatch(JSON.stringify(target), /scores|refineAllowed|refineV3|keypoints/);
});
test("no lower-body targets without observation, no dimensions or policy means no decoration", () => {
  const c = context();c.lowerBodyObserved = false;
  assert.deepEqual(selectedRefineTarget(c, 400, 800)?.targetJoints, [7, 9]);
  assert.equal(selectedRefineTarget(c, 400, 800)?.skeleton.points[14], null);
  for (const size of [undefined, null, 0, -1, Infinity, NaN]) assert.equal(selectedRefineTarget(c, size, 800), undefined);
  c.refineAllowed = false;assert.equal(selectedRefineTarget(c, 400, 800), undefined);
  c.refineAllowed = true;c.refinableLimbs = ["torso", "unknown"];assert.equal(selectedRefineTarget(c, 400, 800), undefined);
});
test("malformed persisted targets never break refinement or produce guessed coordinates", () => {
  const c = context();c.keypoints[7] = { length: 2 } as unknown as number[];
  c.keypoints[9] = [-1, 500];c.lowerBodyObserved = false;
  assert.equal(selectedRefineTarget(c, 400, 800), undefined);
  c.scores = null;assert.equal(selectedRefineTarget(c, 400, 800), undefined);
});
