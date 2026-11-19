import type { StoredRefineContext } from "./store.js";

/** Observed input targets, not solver iterations, predicted points, or accepted output. */
export function selectedRefineTarget(
  context: StoredRefineContext | undefined | null,
  width: number | null | undefined,
  height: number | null | undefined,
) {
  if (!context?.refineAllowed || !width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Array.isArray(context.keypoints) || context.keypoints.length !== 17 || !Array.isArray(context.scores) || context.scores.length !== 17 || !Array.isArray(context.refinableLimbs)) return undefined;
  const points = context.keypoints.map((p, i): [number, number] | null =>
    i >= 5 && (i < 13 || context.lowerBodyObserved) && Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
    Number.isFinite(context.scores![i]) && context.scores![i] > 0 &&
    p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height
      ? [p[0] / width, p[1] / height] : null);
  const limbs: Record<string, number[]> = {
    left_arm: [7, 9], right_arm: [8, 10],
    ...(context.lowerBodyObserved ? { left_leg: [13, 15], right_leg: [14, 16] } : {}),
  };
  const targetJoints = [...new Set(context.refinableLimbs.flatMap(limb => limbs[limb] ?? []))].filter(i => points[i]);
  if (!targetJoints.length) return undefined;
  return { version: "selected-refine-target.v1" as const, width, height,
    skeleton: { format: "coco17" as const, coordinateSpace: "image-normalized" as const, points }, targetJoints };
}

export type SelectedRefineObserver = (phase: "refining" | "preparing", context?: StoredRefineContext) => void;
