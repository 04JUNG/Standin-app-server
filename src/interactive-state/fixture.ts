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
