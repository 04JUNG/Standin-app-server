/** Binary canonical state (standin-binary-f64le-v2). Same authority checks as the typed-JSON
 * v1 packet; decoding and geometry validation come from the vendored Converter reader. */
import { z } from "zod";
import { sha256Hex } from "../converter/client.js";
import {
  ENCODING,
  MEDIA_TYPE,
  readSolvedStateV2,
  type SolvedStateV2,
} from "./shared/interactive_pose_v2.mjs";
import {
  InteractiveError,
  STATE_ENCODING_V2,
  SHA,
  hash,
  type Operation,
} from "./model.js";
import { checkIdentity, identitySchema, type Identity } from "./packet.js";
import type { ResolvedSelection } from "./selection.js";

if (ENCODING !== STATE_ENCODING_V2)
  throw new Error("vendored interactive_pose_v2.mjs encoding does not match the BFF contract");
export const STATE_MEDIA_TYPE_V1 = "application/vnd.standin.solved-pose-state-v1+json";
export const STATE_MEDIA_TYPE_V2 = MEDIA_TYPE;
/** Same byte budget as the typed-JSON canonicalState and the Converter transport. */
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const sha = z.string().regex(SHA);
/** Solve response for a binary state: metadata only, the bytes come from GET /model. */
const metaSchema = z
  .object({
    schema: z.literal("solved-pose-state-v1"),
    operation: z.string(),
    revision: z.number().int().positive(),
    stateHash: sha,
    previewState: z.literal("authoritative"),
    exportState: z.literal("not-requested"),
    canonicalEncoding: z.literal(STATE_ENCODING_V2),
    stateBytes: z.number().int().positive().max(MAX_STATE_BYTES),
    modelSha256: sha,
  })
  .strict();
export type BinaryPacketMeta = z.infer<typeof metaSchema>;

/** Routing only. The strict schema below decides validity. */
export function isBinaryPacket(raw: unknown) {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).canonicalEncoding === STATE_ENCODING_V2
  );
}

/** Operation/revision/stateHash binding, like the v1 boundPacket. */
export function parseBinaryPacketMeta(raw: unknown, op: Operation): BinaryPacketMeta {
  try {
    const meta = metaSchema.parse(raw);
    if (
      meta.operation !== op.operationId ||
      meta.revision !== op.revision ||
      (op.stateHash && meta.stateHash !== op.stateHash)
    )
      throw new Error("packet binding");
    return meta;
  } catch {
    throw new InteractiveError("CONVERTER_INTEGRITY");
  }
}

/** Full decode/validation of the bytes named by a validated solve response. */
export async function parseBinaryState(
  meta: BinaryPacketMeta,
  bytes: Uint8Array,
  op: Operation,
  selection: ResolvedSelection,
): Promise<{
  meta: BinaryPacketMeta;
  state: SolvedStateV2;
  identity: Identity;
  snapshotProof: NonNullable<Operation["snapshotProof"]>;
}> {
  try {
    if (bytes.byteLength !== meta.stateBytes) throw new Error("state length");
    // A plain view: Buffer#slice would alias pooled (possibly misaligned) memory inside the reader.
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = await readSolvedStateV2(view, meta.stateHash);
    if (
      state.stateHash !== meta.stateHash ||
      state.byteLength !== meta.stateBytes ||
      state.modelSha256 !== meta.modelSha256
    )
      throw new Error("state binding");
    const identity = identitySchema.parse(state.identity);
    checkIdentity(identity, op, selection);
    // The v1 model schema bounds names to 200 characters; the shared reader does not.
    if (
      state.model.bones.some((b) => b.name.length > 200) ||
      state.model.meshes.some((m) => m.name.length > 200)
    )
      throw new Error("name bounds");
    // modelSha256 = SHA256 of the STNDMDL2 suffix; Converter receipts carry the same digest.
    const snapshotProof = {
      identityHash: hash(identity),
      modelSha256: state.modelSha256,
      runtimeRevision: identity.solver.runtimeSha256,
    };
    if (op.snapshotProof && hash(op.snapshotProof) !== hash(snapshotProof))
      throw new Error("snapshot proof changed");
    return { meta, state, identity, snapshotProof };
  } catch {
    throw new InteractiveError("CONVERTER_INTEGRITY");
  }
}

/** Initial publication validated geometry/identity/skin. Delivery only rehashes the exact bytes. */
export function verifyPublishedBinaryState(bytes: Uint8Array, op: Operation) {
  if (
    op.previewState !== "authoritative" ||
    !op.stateHash ||
    !op.snapshotProof ||
    bytes.byteLength > MAX_STATE_BYTES ||
    sha256Hex(bytes) !== op.stateHash
  )
    throw new InteractiveError("CONVERTER_INTEGRITY");
  return bytes;
}
