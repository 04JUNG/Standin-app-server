/** Reviewed CSP automatic-import evidence, independent of upstream capability booleans.
 * csp-v2/results.json + pose-results.json (2026-11-06): current defaults, posed individual FBX; full continuous width, observed width2 crops.
 * Pre-posed FBX import is accepted; no .clip or in-CSP joint-edit claim is made.
 */
export const OUTLINE_EXPRESSION = "skinned-outward-transparent-native-outline-v2";
export const OUTLINE_MAPPING = "csp-native-scope-stature-v2-experimental";
export const OUTLINE_SUPPORT = Object.freeze({
  "male-default83-v0-7-6-p1": Object.freeze({
    sha256: "085dd9c65a3a66035f7e0ce9e0a9171b9abb0e33dada92194676d92e00c8b026", statureM: 1.78,
  }),
  "female-default80-v0-3-9-p1": Object.freeze({
    sha256: "712ac75e58efd4d6ccded0b1e931590900015de023327f1320cf6d7d94026ffc", statureM: 1.75,
  }),
});
export const OUTLINE_SCOPE_SCALE = Object.freeze({ full: 1, half: .60, bust: .35, shoulder_head: .27, head: .15 });
export function supportedOutline(characterId: string, sha256: string, scope: string, width?: number) {
  const entry = Object.entries(OUTLINE_SUPPORT).find(([id]) => id === characterId)?.[1];
  if (!entry || entry.sha256 !== sha256 || !Object.hasOwn(OUTLINE_SCOPE_SCALE, scope)) return false;
  return width === undefined || (Number.isFinite(width) && (scope === "full" ? width > 0 && width <= 2 : width === 2));
}
