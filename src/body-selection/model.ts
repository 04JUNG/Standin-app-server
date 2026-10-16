/** Body choices are independent of pose selection. No inference is performed here. */
import {
  bodyShape,
  type BodyShape,
  type ShapeDefault,
  type ShapeSpec,
} from "./shape.js";
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
  /** Operator-declared numeric controls (`body-shape.v1`). Absent = fixed body. */
  shape?: ShapeSpec;
  /**
   * Live preview data for the client (`standin-shape-runtime.v1`). Shared by every preset of the
   * same rules; `preset` picks the starting values. Offered only together with `shape`.
   */
  shapeRuntime?: {
    path: string;
    sha256: string;
    bytes: number;
    format: "standin-shape-runtime.v1";
    rules: string;
    preset: string;
  };
}
export interface BodyCatalog {
  version: string;
  defaultCharacterId: string | null;
  assets: BodyAsset[];
}
/**
 * A named custom body ("주인공 A"): one shape-capable catalog body plus its controls.
 * Cards are the user's own; catalog presets are never stored here.
 */
export interface BodyCard {
  cardId: string;
  name: string;
  characterId: string;
  controls: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}
/** The body the user last picked by hand. New jobs start with it in `last_used` mode. */
export interface LastUsedBody {
  characterId: string;
  /** Null = the cataloged body as is. */
  controls: Record<string, number> | null;
  usedAt: string;
}
export interface BodyPreferences {
  version: "body-preferences.v1";
  scope: "installation";
  /**
   * `last_used` (default): new jobs start with the last hand-picked body, else the
   * recommendation. `fixed_default` is kept for rows saved by older clients.
   */
  mode: "auto" | "fixed_default" | "last_used";
  defaultCharacterId: string | null;
  /** "내 기본값": saved controls for one shape-capable character. Optional for old rows. */
  shapeDefault?: ShapeDefault | null;
  /** Absent on rows written before cards existed (see `cardsOf`). */
  cards?: BodyCard[];
  /** Written by manual body selections, not by preference writes. Never bumps `revision`. */
  lastUsed?: LastUsedBody | null;
  revision: number;
}
export interface BodyPolicy {
  preferences: BodyPreferences;
  userDefault: BodyRef | null;
  catalogDefault: BodyRef | null;
  /** Resolved at capture time so a later catalog change cannot reshape a running job. */
  lastUsed?: { body: BodyRef; shape: BodyShape | null } | null;
}
export interface BodyRecommendation {
  status: "available" | "unavailable" | "disabled" | "not_applicable";
  body: BodyRef | null;
  reasonCodes: string[];
  catalogVersion?: string;
  catalogSha256?: string;
  inputSha256?: string;
  selectionSource?:
    "auto_best_effort" | "auto_default" | "auto_presentation_default";
}
export type BodyIntent = "inherit" | "manual" | "auto";
export interface BodySelection {
  schemaVersion: "body-selection.v1";
  personIndex: number;
  intent: BodyIntent;
  manualCharacterId: string | null;
  /** Manual numeric controls on top of `resolvedBody`. Null = the asset as cataloged. */
  shape?: BodyShape | null;
  recommendation: BodyRecommendation;
  resolvedBody: BodyRef | null;
  resolvedSource:
    | "manual"
    | "fixed_default"
    | "last_used"
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
  mode: "last_used",
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
    lastUsed: lastUsedBody(preferences, catalog),
  };
}
/**
 * The last hand-picked body as the catalog accepts it now. If its controls no longer fit
 * (spec changed, shape editing off) it is dropped rather than rendered as the plain asset.
 */
function lastUsedBody(
  preferences: BodyPreferences,
  catalog: BodyCatalog,
): BodyPolicy["lastUsed"] {
  const last = preferences.lastUsed;
  const asset = last
    ? catalog.assets.find((a) => a.characterId === last.characterId)
    : undefined;
  if (!last || !asset) return null;
  if (!last.controls) return { body: bodyRef(asset), shape: null };
  try {
    return { body: bodyRef(asset), shape: bodyShape(asset, last.controls) };
  } catch {
    return null;
  }
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
  shape: BodyShape | null = null,
): BodySelection {
  const state: BodySelection = {
    schemaVersion: "body-selection.v1",
    personIndex,
    intent,
    manualCharacterId:
      intent === "manual" ? (manual?.characterId ?? null) : null,
    shape: intent === "manual" ? shape : null,
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
  // Last used body: only when it fits these poses; otherwise fall through to the recommendation.
  const last = policy.lastUsed;
  if (
    intent === "inherit" &&
    policy.preferences.mode === "last_used" &&
    last &&
    eligible(last.body, catalog, poses)
  )
    return { ...use(last.body, "last_used"), shape: last.shape };
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
