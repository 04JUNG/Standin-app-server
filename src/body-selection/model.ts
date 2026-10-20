/** Body choices are independent of pose selection. No inference is performed here. */
import { automaticRecommendation } from "./childPolicy.js";
import {
  bodyShape,
  type BodyShape,
  type ShapeSource,
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
    pose: "t_pose" | "attention";
    framing: "body-comparison.v1";
  };
  supportedPoseIds: string[];
  /** Operator-declared numeric controls (`body-shape.v1`). Absent = fixed body. */
  shape?: ShapeSpec;
  /** Authoring source shaped selections of this asset are baked from. Requires `shape`. */
  shapeSource?: ShapeSource;
  /**
   * Live preview data for the client (`standin-shape-runtime.v1`). Shared by every preset of the
   * same rules; `preset` picks the starting values. Offered only together with `shape`.
   */
  shapeRuntime?: {
    path: string;
    sha256: string;
    bytes: number;
    format: "standin-shape-runtime.v1" | "standin-shape-runtime.v2";
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
  /** Last hand-picked body, or the common male base when none is usable. */
  mode: "auto" | "last_used";
  /** Absent on rows written before cards existed (see `cardsOf`). */
  cards?: BodyCard[];
  /** Written by manual body selections, not by preference writes. Never bumps `revision`. */
  lastUsed?: LastUsedBody | null;
  revision: number;
}
export interface BodyPolicy {
  preferences: BodyPreferences;
  /** Resolved at capture time so a later catalog change cannot reshape a running job. */
  lastUsed?: { body: BodyRef; shape: BodyShape | null } | null;
  /** Catalog identity captured for the first-use male base, independent of recommendations. */
  firstUseDefault?: BodyRef | null;
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
  /**
   * Derived on read from the current catalog (never stored): the source the converter must
   * bake `shape` with. Null when the asset declares none — then the shape cannot render.
   */
  shapeSource?: ShapeSource | null;
  recommendation: BodyRecommendation;
  resolvedBody: BodyRef | null;
  resolvedSource:
    | "manual"
    | "last_used"
    | "auto_recommendation"
    | "catalog_default_fallback"
    | null;
  resolutionStatus:
    "ready" | "needs_selection" | "unavailable" | "not_applicable";
  selectionRevision: number;
  /** Lookup-only mesh preview; never authorizes release/export. */
  previewOnly?: true;
  renderingExecuted: false;
}
export const defaultPreferences = (): BodyPreferences => ({
  version: "body-preferences.v1",
  scope: "installation",
  mode: "last_used",
  cards: [],
  lastUsed: null,
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
/** Catalog identity is required for review surfaces; the pose allowlist remains strict for exports. */
export function previewEligible(
  ref: BodyRef | null,
  catalog: BodyCatalog,
  poses: string[],
): ref is BodyRef {
  return (
    !!ref && poses.length > 0 && catalog.assets.some((a) => sameBody(a, ref))
  );
}
export const bodyEligible = (
  ref: BodyRef | null,
  catalog: BodyCatalog,
  poses: string[],
  previewOnly: boolean,
) =>
  previewOnly
    ? previewEligible(ref, catalog, poses)
    : eligible(ref, catalog, poses);
export function snapshot(
  preferences: BodyPreferences,
  catalog: BodyCatalog,
): BodyPolicy {
  preferences = normalizePreferences(preferences);
  return {
    preferences: structuredClone(preferences),
    lastUsed: lastUsedBody(preferences, catalog),
    firstUseDefault: firstUseBody(catalog),
  };
}
/** Use only a registered current male BASE asset; never invent a fallback identity. */
export function firstUseBody(catalog: BodyCatalog): BodyRef | null {
  const asset = catalog.assets.find((a) =>
    /^male-base(?:-|$)/.test(a.characterId),
  );
  return asset ? bodyRef(asset) : null;
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
  previewOnly = false,
): BodySelection {
  recommendation = automaticRecommendation(recommendation, catalog);
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
    ...(previewOnly ? { previewOnly: true as const } : {}),
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
    resolutionStatus: bodyEligible(ref, catalog, poses, previewOnly)
      ? "ready"
      : "unavailable",
  });
  if (intent === "manual") return use(manual, "manual");
  const preferences = normalizePreferences(policy.preferences);
  const last =
    policy.lastUsed === undefined
      ? lastUsedBody(preferences, catalog)
      : policy.lastUsed;
  if (intent === "inherit" && preferences.mode === "last_used") {
    if (last && bodyEligible(last.body, catalog, poses, previewOnly)) {
      try {
        const asset = catalog.assets.find((a) => sameBody(a, last.body))!;
        const shape = last.shape ? bodyShape(asset, last.shape.controls) : null;
        return { ...use(last.body, "last_used"), shape };
      } catch {
        /* Invalid remembered controls use the common base, never the plain old body. */
      }
    }
    return useMaleBase();
  }
  if (
    recommendation.status === "available" &&
    bodyEligible(recommendation.body, catalog, poses, previewOnly)
  )
    return use(recommendation.body, "auto_recommendation");
  return useMaleBase();

  // Old snapshots have no captured identity; current catalog is the migration boundary.
  // A captured null or changed hash must stay unavailable, never become another asset.
  function useMaleBase(): BodySelection {
    const ref =
      policy.firstUseDefault === undefined
        ? firstUseBody(catalog)
        : policy.firstUseDefault;
    return use(ref, "catalog_default_fallback");
  }
}

/** Upgrade persisted installation rows and job snapshots without losing personal cards. */
export function normalizePreferences(value: BodyPreferences): BodyPreferences {
  const old = value as BodyPreferences & {
    mode: string;
    shapeDefault?: {
      characterId: string;
      controls: Record<string, number>;
    } | null;
  };
  const cards = [...(value.cards ?? [])];
  if (old.shapeDefault && !cards.some((c) => c.cardId === "my-default")) {
    cards.push({
      cardId: "my-default",
      name: "내 기본 체형",
      ...old.shapeDefault,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }
  return {
    version: "body-preferences.v1",
    scope: "installation",
    mode: old.mode === "auto" ? "auto" : "last_used",
    cards,
    lastUsed: value.lastUsed ?? null,
    revision: value.revision,
  };
}
