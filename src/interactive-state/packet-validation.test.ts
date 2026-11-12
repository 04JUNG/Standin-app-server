import test from "node:test";
import assert from "node:assert/strict";
import { fixturePacket, fixtureSelection, protocolFixture } from "./fixture.js";
import { parsePacket } from "./packet.js";
import { validatePacketAsync } from "./packet-validation.js";
import type { Operation } from "./model.js";

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
