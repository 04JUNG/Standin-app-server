/** Reuse the exact rendered FBX for preview, review and export of the same revision. */
import { convertFramed, FramedArtifactCache, type FramedInput } from "../converter/framing.js";
import { sha256Hex } from "../converter/client.js";

const cache = new FramedArtifactCache(128 * 1024 * 1024, 600_000, 16);
export function cameraArtifact(owner: readonly unknown[], input: FramedInput, convert = convertFramed) {
  const key = JSON.stringify([owner, sha256Hex(input.bvhBytes), input.characterId, input.scope, input.cameraRotation]);
  return cache.get(key, () => convert(input));
}
