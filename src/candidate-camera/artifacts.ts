/** Reuse the exact rendered FBX for preview, review and export of the same revision. */
import {
  convertFramed,
  FramedArtifactCache,
  FRAMING_VERSION,
  type FramedInput,
} from "../converter/framing.js";
import { sha256Hex } from "../converter/client.js";

const cache = new FramedArtifactCache(128 * 1024 * 1024, 600_000, 16);
export function cameraArtifact(
  owner: readonly unknown[],
  input: FramedInput,
  convert = convertFramed,
  existingOnly = false,
  signal?: AbortSignal,
) {
  const key = JSON.stringify([
    owner,
    sha256Hex(input.bvhBytes),
    input.characterId,
    input.scope,
    input.cameraRotation,
    input.expectedCharacterSha256,
    input.expectedPreviewRevision,
    FRAMING_VERSION,
    input.previewFormat,
    input.modelRevision,
    input.characterSha256,
    input.shape?.shapeSha256 ?? null,
    input.hands,
  ]);
  if (typeof owner[0] !== "string" || typeof owner[1] !== "string")
    throw new Error("missing framed artifact owner");
  // Long-lived reuse requires the character and exporter revision to be pinned.
  const pinned = (input.expectedCharacterSha256 && input.expectedPreviewRevision) ||
    (input.characterSha256 && input.modelRevision);
  return cache.get(key, (workSignal) => convert({ ...input, signal: workSignal }), pinned
    ? { installationId: owner[0], jobId: owner[1] } : undefined, existingOnly, signal);
}
