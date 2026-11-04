import type { BodyPresentation } from "./model.js";

/** Presentation metadata never participates in BodyRef or export/cache identity. */
export function bodyPresentation(asset: BodyPresentation): BodyPresentation {
  return {
    ...(asset.gender !== undefined ? { gender: asset.gender } : {}),
    ...(asset.role !== undefined ? { role: asset.role } : {}),
    ...(asset.order !== undefined ? { order: asset.order } : {}),
  };
}
