import { createHash } from "node:crypto";
import type {
  BodyAsset,
  BodyCard,
  BodyCatalog,
  BodyPreferences,
} from "../body-selection/model.js";
import { normalizePreferences } from "../body-selection/model.js";
import { normalizeControls, sameShapeSource } from "../body-selection/shape.js";
import { SUPPORTED_RULES } from "./bodyRuntime/evaluate.js";

const CONTROL_LABELS: Record<string, string> = {
  height: "키",
  heads: "등신",
  physique: "체격",
  muscle: "근육",
  muscle_bulk: "근육 볼륨",
  shoulders: "어깨",
  definition: "근육 선명도",
  head_scale: "머리 크기",
  head_width: "머리 폭",
  head_depth: "머리 깊이",
  neck_width: "목 굵기",
  neck_length: "목 길이",
  chest_width: "가슴 폭",
  chest_depth: "가슴 두께",
  waist: "허리",
  pelvis: "골반",
  glute: "엉덩이",
  thigh: "허벅지",
  calf: "종아리",
  torso_length: "상체 길이",
  arm_length: "팔 길이",
  leg_length: "다리 길이",
  leg_ratio: "다리 비율",
  detail_chest: "가슴 근육",
  detail_back: "등 근육",
  detail_shoulder: "어깨 근육",
  detail_upperarm: "위팔 근육",
  detail_forearm: "아래팔 근육",
  detail_thigh: "허벅지 근육",
  detail_calf: "종아리 근육",
  fat_torso: "몸통 살",
  fat_arms: "팔 살",
  fat_legs: "다리 살",
};

export class CustomBodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 429 | 503,
  ) {
    super(code);
  }
}
export const validInstallation = (s: string) => /^inst_[0-9a-f-]{36}$/.test(s);
export const validCard = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
export interface CustomBodyRow {
  installation_id: string;
  last_seen_at: string;
  app_version: string | null;
  os_name: string | null;
  value: BodyPreferences;
}
export interface CustomBodyQuery {
  limit: number;
  installationId: string | null;
  cursor: { at: string; id: string } | null;
}
export function parseCustomBodyQuery(raw: {
  limit?: string;
  installationId?: string;
  cursor?: string;
}): CustomBodyQuery {
  const limit = raw.limit === undefined ? 20 : Number(raw.limit);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (raw.installationId && !validInstallation(raw.installationId))
  )
    throw new CustomBodyError("INVALID_INPUT", 400);
  let cursor: CustomBodyQuery["cursor"] = null;
  if (raw.cursor !== undefined) {
    if (raw.cursor.length > 256)
      throw new CustomBodyError("INVALID_INPUT", 400);
    try {
      const value = JSON.parse(Buffer.from(raw.cursor, "base64url").toString());
      if (
        !validInstallation(value.id) ||
        typeof value.at !== "string" ||
        !Number.isFinite(Date.parse(value.at)) ||
        value.at.length > 40
      )
        throw new Error();
      cursor = { at: value.at, id: value.id };
    } catch {
      throw new CustomBodyError("INVALID_INPUT", 400);
    }
  }
  return { limit, installationId: raw.installationId || null, cursor };
}
/** Decode persisted cards without converting a malformed record into an invented body. */
export function savedCards(row: CustomBodyRow): BodyCard[] {
  try {
    const value = row.value;
    if (
      !value ||
      typeof value !== "object" ||
      (value.cards !== undefined && !Array.isArray(value.cards))
    )
      return [];
    return (normalizePreferences(value).cards ?? [])
      .slice(0, 48)
      .filter(
        (c) =>
          c &&
          typeof c.cardId === "string" &&
          validCard(c.cardId) &&
          typeof c.name === "string" &&
          c.name.length <= 24 &&
          typeof c.characterId === "string" &&
          c.characterId.length <= 200 &&
          c.controls &&
          typeof c.controls === "object" &&
          !Array.isArray(c.controls),
      );
  } catch {
    return [];
  }
}
export function customBody(
  row: CustomBodyRow,
  card: BodyCard,
  catalog: BodyCatalog,
) {
  const asset = catalog.assets.find((a) => a.characterId === card.characterId);
  let controls: Record<string, number> | null = null;
  let reason: string | null = null;
  if (!asset?.shape) reason = "MODEL_UNAVAILABLE";
  else {
    try {
      controls = normalizeControls(asset.shape, card.controls);
    } catch {
      reason = "CONTROLS_INCOMPATIBLE";
    }
    if (
      !reason &&
      (!asset.shapeRuntime ||
        !asset.shapeSource ||
        !sameShapeSource(asset.shapeSource, {
          ...asset.shapeSource,
          rules: asset.shapeRuntime.rules,
        }))
    )
      reason = "RUNTIME_UNAVAILABLE";
    if (
      !reason &&
      asset.shapeRuntime?.format === "standin-shape-runtime.v1" &&
      !SUPPORTED_RULES.has(asset.shapeRuntime.rules)
    )
      reason = "RUNTIME_UNSUPPORTED";
  }
  const revision = createHash("sha256")
    .update(
      JSON.stringify([
        row.installation_id,
        card,
        catalog.version,
        asset?.assetSha256,
        asset?.shapeSource,
        asset?.shapeRuntime && {
          sha256: asset.shapeRuntime.sha256,
          bytes: asset.shapeRuntime.bytes,
          format: asset.shapeRuntime.format,
          rules: asset.shapeRuntime.rules,
          preset: asset.shapeRuntime.preset,
        },
        controls,
      ]),
    )
    .digest("hex");
  return {
    cardId: card.cardId,
    name: card.name,
    characterId: card.characterId,
    modelName: asset?.displayName ?? card.characterId,
    createdAt:
      typeof card.createdAt === "string" && Date.parse(card.createdAt) > 0
        ? card.createdAt.slice(0, 64)
        : null,
    updatedAt:
      typeof card.updatedAt === "string" && Date.parse(card.updatedAt) > 0
        ? card.updatedAt.slice(0, 64)
        : null,
    controls: Object.entries(card.controls)
      .filter(
        ([key, value]) =>
          key.length <= 40 &&
          typeof value === "number" &&
          Number.isFinite(value),
      )
      .slice(0, 64)
      .map(([key, value]) => ({
        key,
        label:
          asset?.shape?.controls.find((c) => c.key === key)?.label ??
          CONTROL_LABELS[key] ??
          key,
        value,
      })),
    previewStatus: reason ? ("unavailable" as const) : ("available" as const),
    previewReason: reason,
    revision,
    asset,
    normalizedControls: controls,
  };
}
export function publicCustomBody(value: ReturnType<typeof customBody>) {
  const { asset: _asset, normalizedControls: _controls, ...safe } = value;
  return safe;
}
export function requireRenderable(value: ReturnType<typeof customBody>): {
  asset: BodyAsset;
  controls: Record<string, number>;
} {
  if (
    value.previewStatus !== "available" ||
    !value.asset ||
    !value.normalizedControls
  )
    throw new CustomBodyError(
      value.previewReason ?? "PREVIEW_UNAVAILABLE",
      409,
    );
  return { asset: value.asset, controls: value.normalizedControls };
}
