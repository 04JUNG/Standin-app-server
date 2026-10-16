/**
 * Shape-key body controls (`body-shape.v1`).
 *
 * The operator declares which catalog assets accept numeric controls; the BFF only
 * validates, stores and echoes them. It never bakes a body. Until verified shape baking is explicitly enabled,
 * previews and exports refuse shaped selections instead of
 * silently rendering the unshaped asset (see `assertShapeRenderable`).
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { BodyAsset, BodyCatalog } from "./model.js";

export const BODY_SHAPE_SCHEMA = "body-shape.v1";
export interface ShapeControl {
  key: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Display name. Absent → the client names the key itself. */
  label?: string;
}
export interface ShapeSpec {
  schemaVersion: typeof BODY_SHAPE_SCHEMA;
  controls: ShapeControl[];
  /** How many leading controls the client shows by default (rest = details). Absent → 5. */
  basic?: number;
}
export interface BodyShape {
  schemaVersion: typeof BODY_SHAPE_SCHEMA;
  controls: Record<string, number>;
  shapeSha256: string;
}
export interface ShapeDefault {
  characterId: string;
  controls: Record<string, number>;
}
export class ShapeInputError extends Error {
  constructor(readonly code: "INVALID_SHAPE" | "SHAPE_UNSUPPORTED") {
    super(code);
  }
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Catalog validation. Malformed specs make the whole catalog invalid (fail closed). */
export function validShapeSpec(spec: unknown): spec is ShapeSpec {
  const s = spec as ShapeSpec | null;
  if (
    !s ||
    s.schemaVersion !== BODY_SHAPE_SCHEMA ||
    !Array.isArray(s.controls) ||
    s.controls.length < 1 ||
    s.controls.length > 64 ||
    (s.basic !== undefined &&
      (!Number.isInteger(s.basic) ||
        s.basic < 1 ||
        s.basic > Math.min(12, s.controls.length)))
  )
    return false;
  const keys = new Set<string>();
  for (const c of s.controls) {
    if (
      !c ||
      typeof c.key !== "string" ||
      !KEY.test(c.key) ||
      keys.has(c.key) ||
      ![c.min, c.max, c.step, c.default].every(finite) ||
      !(c.min < c.max) ||
      !(c.step > 0) ||
      c.default < c.min ||
      c.default > c.max ||
      (c.label !== undefined &&
        (typeof c.label !== "string" || c.label.length < 1 || c.label.length > 24))
    )
      return false;
    keys.add(c.key);
  }
  return true;
}

/** Shape editing is offered only when the flag is on and the asset declares a spec. */
export function shapeSpec(asset: BodyAsset | undefined): ShapeSpec | null {
  return config.bodyShapeEditEnabled && asset?.shape ? asset.shape : null;
}

/** Stable precision: values are snapped to the declared step before hashing. */
function snap(c: ShapeControl, v: number) {
  const n = Math.round((v - c.min) / c.step);
  const snapped = c.min + n * c.step;
  if (Math.abs(snapped - v) > c.step * 1e-6 + 1e-9)
    throw new ShapeInputError("INVALID_SHAPE");
  return Number(snapped.toFixed(6));
}

/** Unknown keys, out-of-range or off-step values are rejected; missing keys use defaults. */
export function normalizeControls(
  spec: ShapeSpec,
  raw: unknown,
): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ShapeInputError("INVALID_SHAPE");
  const input = raw as Record<string, unknown>;
  const known = new Set(spec.controls.map((c) => c.key));
  if (Object.keys(input).some((k) => !known.has(k)))
    throw new ShapeInputError("INVALID_SHAPE");
  const out: Record<string, number> = {};
  for (const c of spec.controls) {
    const v = c.key in input ? input[c.key] : c.default;
    if (!finite(v) || v < c.min || v > c.max)
      throw new ShapeInputError("INVALID_SHAPE");
    out[c.key] = snap(c, v);
  }
  return out;
}

export function isDefaultShape(
  spec: ShapeSpec,
  controls: Record<string, number>,
) {
  return spec.controls.every(
    (c) => Math.abs(controls[c.key] - c.default) <= c.step * 1e-6,
  );
}

export function shapeSha256(
  asset: Pick<BodyAsset, "characterId" | "assetSha256">,
  controls: Record<string, number>,
) {
  const ordered = Object.keys(controls)
    .sort()
    .map((k) => [k, controls[k]]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        BODY_SHAPE_SCHEMA,
        asset.characterId,
        asset.assetSha256,
        ordered,
      ]),
    )
    .digest("hex");
}

/** A default-valued shape is the plain asset; storing it would only fork caches. */
export function bodyShape(
  asset: BodyAsset,
  raw: unknown,
): BodyShape | null {
  const spec = shapeSpec(asset);
  if (!spec) throw new ShapeInputError("SHAPE_UNSUPPORTED");
  const controls = normalizeControls(spec, raw);
  if (isDefaultShape(spec, controls)) return null;
  return {
    schemaVersion: BODY_SHAPE_SCHEMA,
    controls,
    shapeSha256: shapeSha256(asset, controls),
  };
}

export function shapeDefault(
  catalog: BodyCatalog,
  raw: unknown,
): ShapeDefault | null {
  if (raw === null) return null;
  const v = raw as Record<string, unknown> | null;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => k !== "characterId" && k !== "controls") ||
    typeof v.characterId !== "string"
  )
    throw new ShapeInputError("INVALID_SHAPE");
  const asset = catalog.assets.find((a) => a.characterId === v.characterId);
  const spec = shapeSpec(asset);
  if (!asset || !spec) throw new ShapeInputError("SHAPE_UNSUPPORTED");
  return {
    characterId: asset.characterId,
    controls: normalizeControls(spec, v.controls),
  };
}

/** Characters whose controls the client may show in settings. Empty while the flag is off. */
export function shapeEditable(catalog: BodyCatalog) {
  return catalog.assets.flatMap((a) => {
    const spec = shapeSpec(a);
    return spec ? [{ characterId: a.characterId, shape: spec }] : [];
  });
}

/**
 * The shape-bake feature is opt-in. Rendering the plain asset for a
 * shaped selection would show and save a body the user did not choose.
 */
export function shapeRenderable(selection: { shape?: BodyShape | null }) {
  return !selection.shape || config.bodyShapeBakeEnabled;
}
