import { readFile } from "node:fs/promises";
import type { BodyAsset } from "./model.js";
import type { ShapeSpec } from "./shape.js";

/**
 * `standin-shape-runtime.v1`: data the client uses to redraw the selected body live while the
 * user moves the shape sliders (the "내 체형" box). The client verifies sha256 and the format
 * itself; the BFF only serves operator-approved bytes and never builds or edits them.
 */
export const SHAPE_RUNTIME_FORMAT = "standin-shape-runtime.v1";
export const SHAPE_RUNTIME_MAX_BYTES = 32 * 1024 * 1024;
const MAGIC = Buffer.from("SSR1", "ascii");
type Runtime = NonNullable<BodyAsset["shapeRuntime"]>;

export function validShapeRuntime(
  r: unknown,
  shape: ShapeSpec | undefined,
): r is Runtime {
  const v = r as Runtime | null;
  return (
    !!v &&
    shape !== undefined && // live preview without numeric controls has nothing to preview
    typeof v.path === "string" &&
    v.path.startsWith("/") &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    Number.isInteger(v.bytes) &&
    v.bytes > 0 &&
    v.bytes <= SHAPE_RUNTIME_MAX_BYTES &&
    v.format === SHAPE_RUNTIME_FORMAT &&
    typeof v.rules === "string" &&
    /^[a-z0-9][a-z0-9.-]{0,63}$/.test(v.rules) &&
    typeof v.preset === "string" &&
    /^[A-Z][A-Z0-9_]{0,31}$/.test(v.preset)
  );
}

/** Public metadata; never exposes the local path. */
export function shapeRuntimeMetadata(asset: BodyAsset) {
  const r = asset.shapeRuntime;
  return r
    ? {
        url: `/v1/models/${encodeURIComponent(asset.characterId)}/shape-runtime/${r.sha256}`,
        sha256: r.sha256,
        bytes: r.bytes,
        format: r.format,
        rules: r.rules,
        preset: r.preset,
      }
    : undefined;
}

export async function readShapeRuntime(asset: BodyAsset) {
  const r = asset.shapeRuntime;
  if (!r) throw new Error("missing shape runtime");
  const bytes = await readFile(r.path);
  if (
    bytes.length !== r.bytes ||
    bytes.length > SHAPE_RUNTIME_MAX_BYTES ||
    !bytes.subarray(0, 4).equals(MAGIC)
  )
    throw new Error("invalid shape runtime");
  return bytes;
}
