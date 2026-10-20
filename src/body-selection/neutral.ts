import { readFile } from "node:fs/promises";
import type { BodyAsset } from "./model.js";
export function neutralMetadata(asset: BodyAsset) {
  const p = asset.neutralPreview;
  return p
    ? {
        url: `/v1/models/${encodeURIComponent(asset.characterId)}/body-preview/${p.sha256}`,
        sha256: p.sha256,
        characterSha256: asset.assetSha256,
        pose: p.pose,
        framing: p.framing,
      }
    : undefined;
}
export async function readNeutral(asset: BodyAsset) {
  const p = asset.neutralPreview;
  if (!p) throw new Error("missing preview");
  const bytes = await readFile(p.path);
  if (
    bytes.length > 2 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("invalid preview");
  return bytes;
}
