/** Read-only precomputed GLB. This endpoint cannot queue Blender work. */
import { config } from "../config.js";
import { sha256Hex } from "./client.js";

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
