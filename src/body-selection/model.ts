/** Body choices are independent of pose selection. No inference is performed here. */
export interface BodyRef {
  bodyId: string;
  bodyVersion: string;
  assetSha256: string;
  rigVersion: string;
  measurementVersion: string;
  characterId: string;
}
export interface BodyAsset extends BodyRef {
  displayName?: string;
  neutralPreview?: {
    path: string;
    sha256: string;
    characterSha256: string;
    pose: "attention";
    framing: "body-comparison.v1";
  };
  supportedPoseIds: string[];
}
export interface BodyCatalog {
  version: string;
  defaultCharacterId: string | null;
  assets: BodyAsset[];
}
export interface BodyPreferences {
  version: "body-preferences.v1";
  scope: "installation";
  mode: "auto" | "fixed_default";
  defaultCharacterId: string | null;
  revision: number;
}
export interface BodyPolicy {
  preferences: BodyPreferences;
  userDefault: BodyRef | null;
  catalogDefault: BodyRef | null;
}
export interface BodyRecommendation {
  status: "available" | "unavailable" | "disabled" | "not_applicable";
  body: BodyRef | null;
  reasonCodes: string[];
  catalogVersion?: string;
  catalogSha256?: string;
  inputSha256?: string;
  selectionSource?: "auto_best_effort" | "auto_default";
}
export type BodyIntent = "inherit" | "manual" | "auto";
export interface BodySelection {
  schemaVersion: "body-selection.v1";
  personIndex: number;
  intent: BodyIntent;
  manualCharacterId: string | null;
  recommendation: BodyRecommendation;
  resolvedBody: BodyRef | null;
  resolvedSource:
    | "manual"
    | "fixed_default"
    | "auto_recommendation"
    | "user_default_fallback"
    | "catalog_default_fallback"
    | null;
  resolutionStatus:
    "ready" | "needs_selection" | "unavailable" | "not_applicable";
  selectionRevision: number;
  renderingExecuted: false;
}
export const defaultPreferences = (): BodyPreferences => ({
  version: "body-preferences.v1",
  scope: "installation",
  mode: "auto",
  defaultCharacterId: null,
  revision: 0,
});
export const bodyRef = (a: BodyRef): BodyRef => ({
  bodyId: a.bodyId,
  bodyVersion: a.bodyVersion,
  assetSha256: a.assetSha256,
  rigVersion: a.rigVersion,
  measurementVersion: a.measurementVersion,
  characterId: a.characterId,
});
export const sameBody = (a: BodyRef, b: BodyRef): boolean =>
  JSON.stringify(bodyRef(a)) === JSON.stringify(bodyRef(b));
export function eligible(
  ref: BodyRef | null,
  catalog: BodyCatalog,
  poses: string[],
): ref is BodyRef {
  return (
    !!ref &&
    catalog.assets.some(
      (a) =>
        sameBody(a, ref) &&
        poses.every((id) => a.supportedPoseIds.includes(id)),
    )
  );
}
export function snapshot(
  preferences: BodyPreferences,
  catalog: BodyCatalog,
): BodyPolicy {
  const find = (id: string | null) => {
    const a = catalog.assets.find((a) => a.characterId === id);
    return a ? bodyRef(a) : null;
  };
  return {
    preferences: { ...preferences },
    userDefault: find(preferences.defaultCharacterId),
    catalogDefault: find(catalog.defaultCharacterId),
  };
}
export function resolveBody(
  personIndex: number,
  policy: BodyPolicy,
  recommendation: BodyRecommendation,
  catalog: BodyCatalog,
  poses: string[],
  intent: BodyIntent = "inherit",
  manual: BodyRef | null = null,
  revision = 0,
): BodySelection {
  const state: BodySelection = {
    schemaVersion: "body-selection.v1",
    personIndex,
    intent,
    manualCharacterId:
      intent === "manual" ? (manual?.characterId ?? null) : null,
    recommendation,
    resolvedBody: null,
    resolvedSource: null,
    resolutionStatus: "needs_selection",
    selectionRevision: revision,
    renderingExecuted: false,
  };
  if (!poses.length) return { ...state, resolutionStatus: "not_applicable" };
  const use = (
    ref: BodyRef | null,
    source: BodySelection["resolvedSource"],
  ): BodySelection => ({
    ...state,
    resolvedBody: ref,
    resolvedSource: source,
    resolutionStatus: eligible(ref, catalog, poses) ? "ready" : "unavailable",
  });
  if (intent === "manual") return use(manual, "manual");
  if (intent === "inherit" && policy.preferences.mode === "fixed_default")
    return use(policy.userDefault, "fixed_default");
  if (
    recommendation.status === "available" &&
    eligible(recommendation.body, catalog, poses)
  )
    return use(recommendation.body, "auto_recommendation");
  // An explicit auto action never silently becomes a default.
  if (intent === "auto") return { ...state, resolutionStatus: "unavailable" };
  if (eligible(policy.userDefault, catalog, poses))
    return use(policy.userDefault, "user_default_fallback");
  if (eligible(policy.catalogDefault, catalog, poses))
    return use(policy.catalogDefault, "catalog_default_fallback");
  return state;
}
