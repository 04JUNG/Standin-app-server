/** Read-only precomputed GLB. This endpoint cannot queue Blender work. */
import { config } from "../config.js";
import { sha256Hex } from "./client.js";

export function matchesLibraryModel(
  bytes: Buffer,
  source: string,
  characterId: string,
  characterSha256: string,
) {
  try {
    if (
      bytes.length < 28 ||
      bytes.length > 8 * 1024 * 1024 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length ||
      bytes.readUInt32LE(16) !== 0x4e4f534a
    )
      return false;
    const size = bytes.readUInt32LE(12);
    if (size % 4 || size > 128 * 1024 || size + 28 > bytes.length) return false;
    const meta = JSON.parse(bytes.subarray(20, 20 + size).toString("utf8"))
      .asset?.extras;
    return (
      meta?.version === "posed-mesh-v1" &&
      meta.source_bvh_sha256 === source &&
      meta.character_id === characterId &&
      meta.character_sha256 === characterSha256 &&
      meta.scope === "full" &&
      meta.coordinates === "Y-up-hips-origin"
    );
  } catch {
    return false;
  }
}

export async function getPreviewModel(
  sourceSha: string,
  characterId: string,
  fetcher = fetch,
) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha)) throw new Error("invalid source");
  const url = `${config.converterBaseUrl.replace(/\/+$/, "")}/pose-preview/${sourceSha}?character_id=${encodeURIComponent(characterId)}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("preview model unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty preview model");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("preview model too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (
    response.headers.get("content-type") !== "model/gltf-binary" ||
    response.headers.get("x-standin-model-version") !== "posed-mesh-v1" ||
    response.headers.get("x-standin-source-bvh-sha256") !== sourceSha ||
    !/^[a-f0-9]{64}$/.test(
      response.headers.get("x-standin-character-sha256") ?? "",
    ) ||
    response.headers.get("x-standin-artifact-sha256") !== sha256Hex(bytes) ||
    bytes.subarray(0, 4).toString() !== "glTF"
  )
    throw new Error("preview model integrity");
  return bytes;
}
