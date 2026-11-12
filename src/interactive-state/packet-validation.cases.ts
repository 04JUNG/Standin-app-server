import test from "node:test";
import assert from "node:assert/strict";
import { binaryFixture, binaryFixtureBytes, splitBinaryState, fixturePacket, fixtureSelection, protocolFixture } from "./fixture.js";
import { parsePacket } from "./packet.js";
import { validatePacketAsync, validateBinaryPacketAsync } from "./packet-validation.js";
import { hash, STATE_ENCODING_V2, type Operation } from "./model.js";
import { parseBinaryPacketMeta, parseBinaryState } from "./packetV2.js";

const identity = protocolFixture.receipt.identity;
const op = { operationId: identity.selection.operation, revision: identity.selection.revision,
  personIndex: Number(identity.selection.person), candidateId: identity.selection.candidate } as Operation;
const selection = fixtureSelection("fixture");

test("worker retains the full validator proof without returning mesh arrays", async () => {
  const packet = fixturePacket(op), expected = parsePacket(packet, op, selection);
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  try {
    const actual = await validatePacketAsync(packet, op, selection, new AbortController().signal);
    assert.deepEqual(actual, { stateHash: expected.packet.stateHash, snapshotProof: expected.snapshotProof });
    assert.ok(ticks > 0, "HTTP timers must run while worker starts and validates");
  } finally { clearInterval(interval); }
});

test("worker rejects tampered canonical bytes and wrong identity", async () => {
  for (const packet of [{ ...fixturePacket(op), stateHash: "0".repeat(64) }, fixturePacket({ ...op, revision: op.revision + 1 })]) {
    await assert.rejects(validatePacketAsync(packet, op, selection, new AbortController().signal), { code: "CONVERTER_INTEGRITY" });
  }
});

test("running and queued cancellation release admission for the next validation", async () => {
  const first = new AbortController(), second = new AbortController();
  const a = validatePacketAsync(fixturePacket(op), op, selection, first.signal);
  const b = validatePacketAsync(fixturePacket(op), op, selection, second.signal);
  const rejected = Promise.all([assert.rejects(a, { code: "INTERACTIVE_SUPERSEDED" }),
    assert.rejects(b, { code: "INTERACTIVE_SUPERSEDED" })]);
  second.abort(); first.abort(); await rejected;
  assert.ok((await validatePacketAsync(fixturePacket(op), op, selection, new AbortController().signal)).stateHash);
});

test("skin topology rejection still runs inside worker", async () => {
  const skinOp = { ...op, skinPreview: { compatibility: { vertices: -1 } } } as unknown as Operation;
  await assert.rejects(validatePacketAsync(fixturePacket(op), skinOp, selection, new AbortController().signal), { code: "SKIN_UV_INCOMPATIBLE" });
});

const binaryOp = { ...op, stateHash: null, snapshotProof: null, stateEncoding: STATE_ENCODING_V2 } as Operation;
const binaryMeta = () => parseBinaryPacketMeta(binaryFixture.packet, binaryOp);

test("binary worker retains identical identity/model/runtime proof without returning decoded geometry", async () => {
  const expected = await parseBinaryState(binaryMeta(), binaryFixtureBytes, binaryOp, selection);
  const pooled = Buffer.concat([Buffer.from([1, 2, 3]), binaryFixtureBytes]).subarray(3);
  const original = Buffer.from(pooled);
  let ticks = 0;
  const interval = setInterval(() => ticks++, 5);
  try {
    const actual = await validateBinaryPacketAsync(binaryMeta(), pooled, binaryOp, selection, new AbortController().signal);
    assert.deepEqual(actual, { stateHash: expected.meta.stateHash, snapshotProof: expected.snapshotProof });
    assert.deepEqual(pooled, original, "the caller's pooled/misaligned Buffer must not be detached or mutated");
    assert.ok(ticks > 0, "HTTP poll and lease timers must remain runnable during binary validation");
  } finally { clearInterval(interval); }
});

test("binary worker rejects changed bytes, current owner/body/revision and published proof", async () => {
  const flipped = Buffer.from(binaryFixtureBytes); flipped[flipped.length - 1] ^= 1;
  await assert.rejects(validateBinaryPacketAsync(binaryMeta(), flipped, binaryOp, selection, new AbortController().signal), { code: "CONVERTER_INTEGRITY" });
  for (const [operation, current] of [
    [{ ...binaryOp, revision: binaryOp.revision + 1 }, selection],
    [binaryOp, { ...selection, identity: { ...selection.identity, ownerBinding: "0".repeat(64) } }],
    [binaryOp, { ...selection, body: { ...selection.body, resolvedBody: { ...selection.body.resolvedBody!, assetSha256: "0".repeat(64) } } }],
    [{ ...binaryOp, snapshotProof: { identityHash: "0".repeat(64), modelSha256: "0".repeat(64), runtimeRevision: "0".repeat(64) } }, selection],
  ] as const)
    await assert.rejects(validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes, operation, current, new AbortController().signal), { code: "CONVERTER_INTEGRITY" });
});

test("binary skin pins are checked inside the worker exactly like v1", async () => {
  const model = splitBinaryState(binaryFixtureBytes).model;
  // Use the already shared-reader-verified mesh for an exact existing pin.
  const decoded = await parseBinaryState(binaryMeta(), binaryFixtureBytes, binaryOp, selection);
  const v1 = parsePacket(fixturePacket(op), op, selection).payload.model;
  assert.ok(model.length > 0);
  const pin = { compatibility: { previewMesh: decoded.state.model.meshes[0].name,
    vertices: decoded.state.model.meshes[0].vertexCount, bones: decoded.state.model.bones.length,
    trianglesSha256: hash(v1.meshes[0].triangles) } } as unknown as NonNullable<Operation["skinPreview"]>;
  assert.ok((await validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes, { ...binaryOp, skinPreview: pin }, selection, new AbortController().signal)).stateHash);
  for (const change of [{ vertices: -1 }, { trianglesSha256: "0".repeat(64) }, { previewMesh: "other" }, { bones: 0 }])
    await assert.rejects(validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes,
      { ...binaryOp, skinPreview: { ...pin, compatibility: { ...pin.compatibility, ...change } } }, selection,
      new AbortController().signal), { code: "SKIN_UV_INCOMPATIBLE" });
});

test("both encodings share bounded admission; cancellation drains running and queued binary work", async () => {
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const promises = controllers.map((controller, i) => i % 2
    ? validatePacketAsync(fixturePacket(op), op, selection, controller.signal)
    : validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes, binaryOp, selection, controller.signal));
  const cancelled = Promise.all(promises.map(p => assert.rejects(p, { code: "INTERACTIVE_SUPERSEDED" })));
  await assert.rejects(validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes, binaryOp, selection, new AbortController().signal), { code: "INTERACTIVE_VALIDATION_BUSY", status: 503 });
  for (const controller of [...controllers].reverse()) controller.abort();
  await cancelled;
  assert.ok((await validatePacketAsync(fixturePacket(op), op, selection, new AbortController().signal)).snapshotProof);
  assert.ok((await validateBinaryPacketAsync(binaryMeta(), binaryFixtureBytes, binaryOp, selection, new AbortController().signal)).snapshotProof);
});
