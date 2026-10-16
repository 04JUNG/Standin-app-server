import { readFile } from "node:fs/promises";
import type { BodyAsset } from "./model.js";
import { sameShapeSource, type ShapeSpec } from "./shape.js";

/**
 * `standin-shape-runtime.v1`: data the client uses to redraw the selected body live while the
 * user moves the shape sliders (the "내 체형" box). The client verifies sha256 and the format
 * itself; the BFF only serves operator-approved bytes and never builds or edits them.
 */
export const SHAPE_RUNTIME_FORMAT = "standin-shape-runtime.v1";
/**
 * v2: version-agnostic sampled runtime (built by running the controller in Blender).
 * Its header names the authoring source; the catalog must bind it to `shapeSource`.
 */
export const SHAPE_RUNTIME_FORMAT_V2 = "standin-shape-runtime.v2";
export const SHAPE_RUNTIME_MAX_BYTES = 32 * 1024 * 1024;
const MAGIC: Record<string, Buffer> = {
  [SHAPE_RUNTIME_FORMAT]: Buffer.from("SSR1", "ascii"),
  [SHAPE_RUNTIME_FORMAT_V2]: Buffer.from("SSR2", "ascii"),
};
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
    (v.format === SHAPE_RUNTIME_FORMAT || v.format === SHAPE_RUNTIME_FORMAT_V2) &&
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
        // The client refuses a runtime whose header names another source (falls back to images).
        ...(asset.shapeSource ? { source: asset.shapeSource } : {}),
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
    !bytes.subarray(0, 4).equals(MAGIC[r.format]!)
  )
    throw new Error("invalid shape runtime");
  if (r.format === SHAPE_RUNTIME_FORMAT_V2 && !headerMatchesSource(bytes, asset))
    throw new Error("shape runtime source mismatch");
  return bytes;
}

/** SSR2 header names its authoring source; never serve one built from another source. */
function headerMatchesSource(bytes: Buffer, asset: BodyAsset) {
  try {
    const size = bytes.readUInt32LE(4);
    if (size > 4 * 1024 * 1024 || 8 + size > bytes.length) return false;
    const header = JSON.parse(bytes.subarray(8, 8 + size).toString("utf8")) as {
      rules?: unknown;
      source?: { blendSha256?: unknown; controllerSha256?: unknown };
    };
    return sameShapeSource(asset.shapeSource, {
      rules: header.rules,
      blendSha256: header.source?.blendSha256,
      controllerSha256: header.source?.controllerSha256,
    });
  } catch {
    return false;
  }
}
