/** Approved neutral UV/texture overlay metadata; canonical model bytes stay unchanged. */
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { hash, InteractiveError } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import type { SkinContext } from "./skin-proof.js";
export interface SkinPreview {
  schema: "skin-preview-v1";
  skin: SkinContext["skin"];
  assetVersion: string;
  assetManifestSha256: string;
  compatibility: { characterId: string; characterSha256: string; previewMesh: string; vertices: number;
    bones: number; polygonIndicesSha256: string; weightsSha256: string; trianglesSha256: string };
  uv: { sha256: string; bytes: number };
  texture: { sha256: string; bytes: number };
}
export function skinPreview(context: SkinContext, characterId: string): SkinPreview {
  const a = context.asset, texture = a.previewTextures[context.skin.id];
  if (!texture) throw new InteractiveError("SKIN_UNSUPPORTED");
  return { schema: "skin-preview-v1", skin: context.skin, assetVersion: context.assetVersion,
    assetManifestSha256: context.assetManifestSha256,
    compatibility: { characterId, characterSha256: a.characterSha256, previewMesh: a.previewMesh, vertices: a.vertices,
      bones: a.bones, polygonIndicesSha256: a.polygonIndicesSha256, weightsSha256: a.weightsSha256, trianglesSha256: a.trianglesSha256 },
    uv: { sha256: a.uvSha256, bytes: a.uvBytes }, texture };
}
export function checkSkinPreviewModel(preview: SkinPreview | undefined, model: { meshes: { name: string; positions: unknown[]; triangles: number[][] }[]; bones: unknown[] }) {
  if (!preview) return;
  const pin = preview.compatibility, mesh = model.meshes[0];
  if (model.meshes.length !== 1 || !mesh || mesh.name !== pin.previewMesh || mesh.positions.length !== pin.vertices ||
    model.bones.length !== pin.bones || hash(mesh.triangles) !== pin.trianglesSha256)
    throw new InteractiveError("SKIN_UV_INCOMPATIBLE");
}
export function verifySkinPreviewAsset(preview: SkinPreview, digest: string, bytes: Uint8Array) {
  const pin = digest === preview.uv.sha256 ? preview.uv : digest === preview.texture.sha256 ? preview.texture : undefined;
  if (!pin || bytes.length !== pin.bytes || sha256Hex(bytes) !== digest) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
  try {
    if (digest === preview.texture.sha256) {
      const png = Buffer.from(bytes);
      if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.subarray(12, 16).toString("ascii") !== "IHDR" || png.readUInt32BE(16) < 1 || png.readUInt32BE(20) < 1 ||
        png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) > 2048) throw new Error("PNG bounds");
      return "image/png";
    }
    const raw: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
    const value = z.object({ source_sha256: z.literal(preview.compatibility.characterSha256),
      uv: z.array(z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)])).min(3).max(1000000),
      triangles: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])).min(1).max(333333),
    }).strict().parse(raw);
    if (value.uv.length !== value.triangles.length * 3 || hash(value.triangles) !== preview.compatibility.trianglesSha256 ||
      value.triangles.some(t => t.some(i => i >= preview.compatibility.vertices))) throw new Error("UV topology");
    return "application/gzip";
  } catch { throw new InteractiveError("SKIN_INTEGRITY_ERROR"); }
}
