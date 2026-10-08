/** Read-only precomputed GLB. This endpoint cannot queue Blender work. */
import { config } from "../config.js";
import { ConverterError, sha256Hex } from "./client.js";

export async function getPreviewModel(
  sourceSha: string,
  characterId: string,
  fetcher = fetch,
  expected?: {
    characterSha256: string;
    previewRevision: string;
    modelRevision: string;
  },
) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha)) throw new Error("invalid source");
  if (
    expected &&
    !Object.values(expected).every((v) => /^[a-f0-9]{64}$/.test(v))
  )
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "invalid expected model lineage",
    );
  const params = new URLSearchParams({ character_id: characterId });
  if (expected) {
    params.set("expected_character_sha256", expected.characterSha256);
    params.set("expected_preview_revision", expected.previewRevision);
  }
  const url = `${config.converterBaseUrl.replace(/\/+$/, "")}/pose-preview/${sourceSha}?${params}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConverterError(
      response.status === 404
        ? "PREVIEW_NOT_READY"
        : response.status === 409
          ? "CONVERTER_REJECTED"
          : "CONVERTER_UNAVAILABLE",
      "preview model unavailable",
    );
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
    (expected &&
      (response.headers.get("x-standin-character-sha256") !==
        expected.characterSha256 ||
        response.headers.get("x-standin-preview-revision") !==
          expected.previewRevision ||
        response.headers.get("x-standin-model-revision") !==
          expected.modelRevision)) ||
    response.headers.get("content-type") !== "model/gltf-binary" ||
    response.headers.get("x-standin-model-version") !== "posed-mesh-v1" ||
    response.headers.get("x-standin-source-bvh-sha256") !== sourceSha ||
    !/^[a-f0-9]{64}$/.test(
      response.headers.get("x-standin-character-sha256") ?? "",
    ) ||
    response.headers.get("x-standin-artifact-sha256") !== sha256Hex(bytes) ||
    bytes.subarray(0, 4).toString() !== "glTF"
  )
    throw new ConverterError("CONVERTER_INTEGRITY", "preview model integrity");
  if (expected) {
    // A correct HTTP digest alone does not prove that the GLB's embedded identity matches.
    try {
      if (
        bytes.length < 28 ||
        bytes.readUInt32LE(4) !== 2 ||
        bytes.readUInt32LE(8) !== bytes.length ||
        bytes.readUInt32LE(16) !== 0x4e4f534a
      )
        throw new Error("header");
      const size = bytes.readUInt32LE(12);
      if (size > 128 * 1024 || size + 28 > bytes.length)
        throw new Error("JSON size");
      const meta = JSON.parse(bytes.subarray(20, 20 + size).toString("utf8"))
        .asset?.extras;
      if (
        meta?.version !== "posed-mesh-v1" ||
        meta.revision !== expected.modelRevision ||
        meta.source_bvh_sha256 !== sourceSha ||
        meta.character_sha256 !== expected.characterSha256 ||
        meta.character_id !== characterId ||
        meta.scope !== "full" ||
        meta.coordinates !== "Y-up-hips-origin"
      )
        throw new Error("identity");
    } catch {
      throw new ConverterError(
        "CONVERTER_INTEGRITY",
        "embedded model lineage mismatch",
      );
    }
  }
  return bytes;
}
