import type { BodyCatalog, BodyRecommendation, BodyRef } from "./model.js";

export const CHILD_SELECTION_REASON = "child_requires_explicit_user_selection";
const childId = /(?:^|[-_.\s])(child|kid|baby|infant|toddler)(?:$|[-_.\s])/i;

/** Asset identity, never a person's age, pose, head ratio or gender. */
export function isChildBody(ref: BodyRef | null, catalog: BodyCatalog): boolean {
  if (!ref) return false;
  const asset = catalog.assets.find(a => a.bodyId === ref.bodyId && a.characterId === ref.characterId);
  return [ref.bodyId, ref.characterId, asset?.displayName ?? ""].some(id => childId.test(id)) ||
    !!asset?.displayName && /^(아동|어린이|유아)(형|\s|$)/.test(asset.displayName);
}

/** Current image contracts contain no validated child-design authorization. */
export function automaticRecommendation(rec: BodyRecommendation, catalog: BodyCatalog): BodyRecommendation {
  return isChildBody(rec.body, catalog) ? {
    ...rec, status: "unavailable", body: null,
    reasonCodes: [...new Set([...rec.reasonCodes, CHILD_SELECTION_REASON])],
  } : rec;
}
