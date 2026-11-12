/** Binary state (standin-binary-f64le-v2) validation against the Converter Python fixture. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePacket, parseReceipt } from "./packet.js";
import {
  STATE_MEDIA_TYPE_V2,
  isBinaryPacket,
  parseBinaryPacketMeta,
  parseBinaryState,
  verifyPublishedBinaryState,
} from "./packetV2.js";
import { STATE_ENCODING_V2, hash, type Operation } from "./model.js";
import { checkSkinPreviewBinaryModel, checkSkinPreviewModel, type SkinPreview } from "../appearance/skin-preview.js";
import { parseSwitch } from "../config.js";
import { MEDIA_TYPE, ENCODING, toV1Model, triangleIndexJson } from "./shared/interactive_pose_v2.mjs";
import {
  binaryFixture,
  binaryFixtureBytes,
  encodeBinaryState,
  fixtureSelection,
  protocolFixture,
  splitBinaryState,
} from "./fixture.js";
import type { ResolvedSelection } from "./selection.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const shared = new URL("../../src/interactive-state/shared/", import.meta.url);
const identity = binaryFixture.receipt.identity;
const op = {
  operationId: identity.selection.operation,
  revision: 1,
  personIndex: 0,
  candidateId: "candidate",
  stateHash: null,
  stateEncoding: STATE_ENCODING_V2,
  previewState: "solving",
  snapshotProof: null,
} as unknown as Operation;
const selection = fixtureSelection(hash("selection"));
const v1Op = { ...op, stateHash: protocolFixture.packet.stateHash, stateEncoding: undefined } as Operation;
const parse = (bytes: Uint8Array = binaryFixtureBytes, packet: unknown = binaryFixture.packet,
  operation: Operation = op, current: ResolvedSelection = selection) =>
  parseBinaryState(parseBinaryPacketMeta(packet, operation), bytes, operation, current);
/** Re-sign a byte change so only the targeted check can reject it. */
const resigned = (bytes: Buffer) => ({ bytes, packet: { ...binaryFixture.packet, stateHash: sha256(bytes), stateBytes: bytes.length } });

test("vendored reader is the Converter file byte-for-byte (PROVENANCE pin and fixture source digest)", () => {
  const bytes = readFileSync(new URL("interactive_pose_v2.mjs", shared));
  const provenance = readFileSync(new URL("PROVENANCE.txt", shared), "utf8");
  const pinned = /^SHA256: ([a-f0-9]{64})$/m.exec(provenance)?.[1];
  assert.equal(sha256(bytes), pinned);
  assert.equal(pinned, binaryFixture.sourceSha256["converter/shared/interactive_pose_v2.mjs"]);
  assert.match(provenance, /^Path: converter\/shared\/interactive_pose_v2\.mjs$/m);
  // Optional live check against a Converter checkout (not available in BFF CI).
  const root = process.env.STANDIN_CONVERTER_ROOT;
  if (root) {
    const upstream = join(root, "converter", "shared", "interactive_pose_v2.mjs");
    assert.ok(existsSync(upstream), upstream);
    assert.deepEqual(readFileSync(upstream), bytes);
  }
  assert.equal(ENCODING, STATE_ENCODING_V2);
  assert.equal(MEDIA_TYPE, STATE_MEDIA_TYPE_V2);
  assert.equal(binaryFixture.mediaType, STATE_MEDIA_TYPE_V2);
});

test("binary fixture validates with the same identity proof as its v1 original and a v2 model digest", async () => {
  assert.equal(isBinaryPacket(binaryFixture.packet), true);
  assert.equal(isBinaryPacket(protocolFixture.packet), false);
  const v2 = await parse();
  const v1 = parsePacket(protocolFixture.packet, v1Op, selection);
  assert.equal(binaryFixture.v1StateHash, protocolFixture.packet.stateHash);
  assert.equal(v2.meta.stateHash, binaryFixture.packet.stateHash);
  assert.equal(v2.snapshotProof.identityHash, v1.snapshotProof.identityHash);
  assert.equal(v2.snapshotProof.runtimeRevision, v1.snapshotProof.runtimeRevision);
  assert.equal(v2.snapshotProof.modelSha256, binaryFixture.packet.modelSha256);
  assert.equal(v2.snapshotProof.modelSha256, binaryFixture.receipt.packetModelSha256);
  assert.notEqual(v2.snapshotProof.modelSha256, v1.snapshotProof.modelSha256);
  // Model suffix digest, independent of the state header.
  const modelOffset = binaryFixtureBytes.length - splitBinaryState(binaryFixtureBytes).model.length;
  assert.equal(sha256(binaryFixtureBytes.subarray(modelOffset)), v2.snapshotProof.modelSha256);
  assert.equal(sha256(binaryFixtureBytes), v2.meta.stateHash);
  // Same decoded geometry as the typed-JSON v1 payload (bitwise equality is the Converter's test).
  assert.equal(hash(toV1Model(v2.state.model)), hash(v1.payload.model));
  assert.equal(hash(v2.identity), hash(v1.payload.identity));
  // A published proof is stable on re-validation and any other proof is refused.
  await parse(binaryFixtureBytes, binaryFixture.packet, { ...op, stateHash: v2.meta.stateHash, snapshotProof: v2.snapshotProof });
  await assert.rejects(parse(binaryFixtureBytes, binaryFixture.packet, { ...op, snapshotProof: v1.snapshotProof }), /CONVERTER_INTEGRITY/);
});

test("pooled, misaligned Buffers are read through a private aligned copy", async () => {
  const pooled = Buffer.concat([Buffer.from([1, 2, 3]), binaryFixtureBytes]).subarray(3);
  assert.notEqual(pooled.byteOffset % 8, 0);
  const result = await parse(pooled);
  assert.equal(result.meta.stateHash, binaryFixture.packet.stateHash);
  assert.equal(pooled[0], binaryFixtureBytes[0]);
});

test("solve metadata is strict and bound to operation, revision, stateHash, length and model digest", async () => {
  const p = binaryFixture.packet;
  for (const packet of [
    { ...p, operation: "op_other" },
    { ...p, revision: 2 },
    { ...p, canonicalEncoding: "typed-f64be-json-v1" },
    { ...p, canonicalState: "{}" },
    { ...p, stateBytes: 0 },
    { ...p, stateBytes: 64 * 1024 * 1024 + 1 },
    { ...p, modelSha256: "A".repeat(64) },
    { ...p, previewState: "solving" },
    (({ modelSha256: _, ...rest }) => rest)(p),
  ])
    assert.throws(() => parseBinaryPacketMeta(packet, op), /CONVERTER_INTEGRITY/);
  assert.throws(() => parseBinaryPacketMeta(p, { ...op, stateHash: "0".repeat(64) }), /CONVERTER_INTEGRITY/);
  // Hash mismatch, wrong length and a model digest that names other geometry.
  for (const packet of [{ ...p, stateHash: "0".repeat(64) }, { ...p, stateBytes: p.stateBytes + 8 },
    { ...p, modelSha256: "0".repeat(64) }])
    await assert.rejects(parse(binaryFixtureBytes, packet), /CONVERTER_INTEGRITY/);
  await assert.rejects(parse(binaryFixtureBytes.subarray(0, -8)), /CONVERTER_INTEGRITY/);
});

test("changed bytes are refused even when re-signed: geometry, padding, trailing data and identity", async () => {
  const { header, model } = splitBinaryState(binaryFixtureBytes);
  const flipped = Buffer.from(binaryFixtureBytes);
  flipped[flipped.length - 1] ^= 1;
  await assert.rejects(parse(flipped), /CONVERTER_INTEGRITY/); // stateHash no longer matches
  const trailing = resigned(Buffer.concat([binaryFixtureBytes, Buffer.alloc(8)]));
  await assert.rejects(parse(trailing.bytes, trailing.packet), /CONVERTER_INTEGRITY/);
  const weight = Buffer.from(binaryFixtureBytes);
  weight.writeDoubleLE(0.5, weight.length - 8); // last skin weight: sums no longer 1
  const weights = resigned(weight);
  await assert.rejects(parse(weights.bytes, { ...weights.packet, modelSha256: sha256(weight.subarray(binaryFixtureBytes.length - model.length)) }), /CONVERTER_INTEGRITY/);
  // Valid encoding, wrong owner/candidate/scope/solver: identity binding refuses.
  for (const edit of [
    (h: typeof header) => { h.identity.ownerBinding = "0".repeat(64); },
    (h: typeof header) => { h.identity.selection.candidate = "other"; },
    (h: typeof header) => { h.identity.scope = "head"; },
    (h: typeof header) => { h.identity.selection.revision = 2; },
    (h: typeof header) => { (h.identity.solver as Record<string, unknown>).version = "other"; },
    (h: typeof header) => { h.identity.unexpected = true; },
  ]) {
    const changed = structuredClone(header);
    edit(changed);
    const candidate = resigned(encodeBinaryState(changed, model));
    await assert.rejects(parse(candidate.bytes, candidate.packet), /CONVERTER_INTEGRITY/);
  }
  const unchanged = resigned(encodeBinaryState(structuredClone(header), model));
  assert.deepEqual(unchanged.bytes, binaryFixtureBytes);
  // Current selection changes are refused exactly as for v1.
  for (const current of [{ ...selection, originalSha: "0".repeat(64) },
    { ...selection, identity: { ...selection.identity, ownerBinding: "0".repeat(64) } },
    { ...selection, hands: { left: "fist", right: null, library_sha256: "0".repeat(64) } }])
    await assert.rejects(parse(binaryFixtureBytes, binaryFixture.packet, op, current as ResolvedSelection), /CONVERTER_INTEGRITY/);
});

test("existing skin trianglesSha256 pins verify binary triangles with the same digest", async () => {
  const v2 = await parse();
  const v1 = parsePacket(protocolFixture.packet, v1Op, selection);
  const mesh = v2.state.model.meshes[0];
  assert.equal(sha256(triangleIndexJson(mesh.triangles)), hash(v1.payload.model.meshes[0].triangles));
  // Same digest on a large index list, including multi-digit and 32-bit indexes.
  const nested = Array.from({ length: 5000 }, (_, i) => [i * 3, i * 3 + 1, (i * 7919 + 4294967295 - i) % 4294967296]);
  assert.equal(sha256(triangleIndexJson(Uint32Array.from(nested.flat()))), hash(nested));
  const preview = { compatibility: { previewMesh: mesh.name, vertices: mesh.vertexCount, bones: v2.state.model.bones.length,
    trianglesSha256: hash(v1.payload.model.meshes[0].triangles) } } as SkinPreview;
  checkSkinPreviewModel(preview, v1.payload.model);
  checkSkinPreviewBinaryModel(preview, v2.state.model);
  checkSkinPreviewBinaryModel(undefined, v2.state.model);
  for (const change of [{ previewMesh: "other" }, { vertices: mesh.vertexCount + 1 }, { bones: 99 },
    { trianglesSha256: hash([[0, 2, 1]]) }]) {
    const pin = { compatibility: { ...preview.compatibility, ...change } } as SkinPreview;
    assert.throws(() => checkSkinPreviewModel(pin, v1.payload.model), /SKIN_UV_INCOMPATIBLE/);
    assert.throws(() => checkSkinPreviewBinaryModel(pin, v2.state.model), /SKIN_UV_INCOMPATIBLE/);
  }
});

test("export receipt binds the v2 state hash and v2 model digest; v1 and v2 proofs are not interchangeable", async () => {
  const v2 = await parse();
  const v1 = parsePacket(protocolFixture.packet, v1Op, selection);
  const solved = { ...op, stateHash: v2.meta.stateHash, snapshotProof: v2.snapshotProof } as Operation;
  assert.equal(parseReceipt(binaryFixture.receipt, solved, selection).stateHash, v2.meta.stateHash);
  assert.throws(() => parseReceipt(protocolFixture.receipt, solved, selection), /CONVERTER_INTEGRITY/);
  assert.throws(() => parseReceipt(binaryFixture.receipt, { ...v1Op, snapshotProof: v1.snapshotProof }, selection), /CONVERTER_INTEGRITY/);
  for (const change of [{ packetModelSha256: protocolFixture.receipt.packetModelSha256 }, { stateHash: protocolFixture.packet.stateHash }])
    assert.throws(() => parseReceipt({ ...binaryFixture.receipt, ...change }, solved, selection), /CONVERTER_INTEGRITY/);
});

test("delivery rehashes the exact published bytes without decoding", async () => {
  const v2 = await parse();
  const published = { ...op, previewState: "authoritative", stateHash: v2.meta.stateHash, snapshotProof: v2.snapshotProof } as Operation;
  assert.equal(verifyPublishedBinaryState(binaryFixtureBytes, published), binaryFixtureBytes);
  const flipped = Buffer.from(binaryFixtureBytes);
  flipped[100] ^= 1;
  assert.throws(() => verifyPublishedBinaryState(flipped, published), /CONVERTER_INTEGRITY/);
  assert.throws(() => verifyPublishedBinaryState(binaryFixtureBytes, { ...published, snapshotProof: null }), /CONVERTER_INTEGRITY/);
  assert.throws(() => verifyPublishedBinaryState(binaryFixtureBytes, { ...published, previewState: "solving" }), /CONVERTER_INTEGRITY/);
});

test("INTERACTIVE_BINARY_STATE accepts only explicit 0/1 (true/false) values", () => {
  for (const value of ["1", "true", " TRUE "]) assert.equal(parseSwitch("INTERACTIVE_BINARY_STATE", value), true);
  for (const value of ["0", "false"]) assert.equal(parseSwitch("INTERACTIVE_BINARY_STATE", value), false);
  for (const value of ["", "yes", "2", "off"])
    assert.throws(() => parseSwitch("INTERACTIVE_BINARY_STATE", value), /INTERACTIVE_BINARY_STATE must be 0 or 1/);
});
