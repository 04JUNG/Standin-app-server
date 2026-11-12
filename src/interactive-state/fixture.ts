/** Synthetic transport fixture helper for tests only; no model/FBX equivalence claim. */
import { readFileSync } from "node:fs";
import { sha256Hex } from "../converter/client.js";
import { decodeTyped } from "./packet.js";
import type { Operation } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
export const protocolFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../src/interactive-state/fixtures/converter-packet.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const syntheticFbx = Buffer.from(
  "; FBX synthetic transport fixture only",
);
export function fixtureSelection(selectionHash: string): ResolvedSelection {
  const i = protocolFixture.receipt.identity;
  return {
    selectionHash,
    identity: { ownerBinding: i.ownerBinding, source: { variant: "base" } },
    originalSha: i.source.originalBvhSha256,
    sourceSha: i.source.originalBvhSha256,
    characterId: i.body.characterId,
    body: { resolvedBody: { assetSha256: i.body.characterSha256 } },
    hands: null,
    scope: "full",
    camera: { projection: "orthographic" },
  } as unknown as ResolvedSelection;
}
export function fixturePacket(op: Operation) {
  const typed = JSON.parse(protocolFixture.packet.canonicalState);
  typed.identity.selection.operation = op.operationId;
  typed.identity.selection.revision = op.revision;
  typed.identity.selection.person = String(op.personIndex);
  const canonicalState = JSON.stringify(typed),
    stateHash = sha256Hex(Buffer.from(canonicalState));
  return {
    ...protocolFixture.packet,
    operation: op.operationId,
    revision: op.revision,
    stateHash,
    canonicalState,
  };
}
export function fixtureReceipt(op: Operation) {
  const packet = fixturePacket(op),
    payload = decodeTyped(JSON.parse(packet.canonicalState)) as {
      identity: unknown;
    };
  return {
    ...protocolFixture.receipt,
    operation: op.operationId,
    revision: op.revision,
    stateHash: packet.stateHash,
    identity: payload.identity,
    artifactSha256: sha256Hex(syntheticFbx),
    artifactBytes: syntheticFbx.length,
    skin: {
      ...protocolFixture.receipt.skin,
      artifact_sha256: sha256Hex(syntheticFbx),
    },
  };
}
/** Converter Python's lossless v2 re-encoding of the fixture above (same identity/model). */
export const binaryFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../src/interactive-state/fixtures/converter-packet-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const binaryFixtureBytes = Buffer.from(binaryFixture.stateBase64, "base64");
type BinaryHeader = Record<string, unknown> & {
  identity: Record<string, unknown> & { selection: { operation: string; revision: number; person: string; candidate: string } };
};
/** Split a v2 state into its typed-JSON state header and the untouched model section. */
export function splitBinaryState(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).toString("ascii") !== "STNDSPS2") throw new Error("fixture magic");
  const size = buffer.readUInt32LE(8), text = buffer.subarray(12, 12 + size).toString("ascii");
  const modelOffset = (12 + size + 7) & ~7;
  return { header: JSON.parse(text) as BinaryHeader, text, model: buffer.subarray(modelOffset) };
}
/** Re-encode the state header (Python canonical JSON == JS stringify of sorted ASCII input). */
export function encodeBinaryState(header: unknown, model: Uint8Array) {
  const text = Buffer.from(JSON.stringify(header), "ascii");
  const head = Buffer.alloc((12 + text.length + 7) & ~7);
  head.write("STNDSPS2", 0, "ascii");
  head.writeUInt32LE(text.length, 8);
  text.copy(head, 12);
  return Buffer.concat([head, model]);
}
export function fixtureBinaryState(op: Operation, edit?: (header: BinaryHeader) => void) {
  const { header, text, model } = splitBinaryState(binaryFixtureBytes);
  if (JSON.stringify(header) !== text) throw new Error("fixture header is not JS-canonical");
  header.identity.selection.operation = op.operationId;
  header.identity.selection.revision = op.revision;
  header.identity.selection.person = String(op.personIndex);
  edit?.(header);
  const bytes = encodeBinaryState(header, model);
  return {
    bytes,
    packet: {
      ...binaryFixture.packet,
      operation: op.operationId,
      revision: op.revision,
      stateHash: sha256Hex(bytes),
      stateBytes: bytes.length,
    },
  };
}
export function fixtureBinaryReceipt(op: Operation) {
  const { bytes } = fixtureBinaryState(op);
  const identity = decodeTyped(splitBinaryState(bytes).header.identity);
  return {
    ...fixtureReceipt(op),
    stateHash: sha256Hex(bytes),
    identity,
    packetModelSha256: binaryFixture.receipt.packetModelSha256,
  };
}
