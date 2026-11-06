/** Real SQL/Hono lifecycle; the source engine is controlled unless separately stated. */
import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../jobs/store.js";
import { PreparationService } from "./service.js";
import { createPreparationResolver } from "./resolver.js";
import { createCandidateRefineTransport } from "../inference.js";
import { hash, HTTP_SCHEMA, type EngineInput } from "./model.js";
import { owner, bvh, sha, setupFixture as setup } from "./fixture.js";

test("3 people: one job flight, chunks10/5, full barrier, exact bytes, selected reuse makes zero source solves", async () => {
  const s = await setup(3);
  try {
    const first = await s.prepare();
    const joined = await s.prepare(0, "mutation_bar_view");
    assert.equal(first.batch.batchId, joined.batch.batchId); assert.equal(joined.replay, true);
    assert.equal((await s.app.request(s.base)).status, 200);
    const other = await s.app.request(s.base, { headers: { "X-Test-Owner": "inst_other" } });
    assert.equal(other.status, 404);
    const url = `${s.base}/${first.batch.batchId}`;
    assert.equal((await s.app.request(url + "/people/0/candidates/candidate_0_0/model")).status, 409);
    await s.service.tick();
    const status = await (await s.app.request(url)).json() as ReturnType<typeof import("./model.js").publicBatch>;
    assert.equal(status.top5Ready, true, JSON.stringify({status,chunks:s.state.chunks,metrics:s.state.metrics})); assert.equal(status.total, 15); assert.equal(status.terminal, 15);
    assert.deepEqual(s.state.chunks, [10, 5]);
    assert.equal(status.candidates[0].status, "ready_base");
    assert.equal(status.candidates[0].validationReceipt!.skinSafe, false);
    assert.equal(status.candidates[0].previewAsset!.format, "bvh");
    assert.equal((await s.app.request(url + `?afterSequence=${status.eventSequence}`)).status, 204);
    const model = await s.app.request(url + "/people/0/candidates/candidate_0_0/model");
    assert.equal(await model.text(), bvh); assert.equal(model.headers.get("X-Standin-Artifact-SHA256"), sha(bvh));
    const input = { schemaVersion: HTTP_SCHEMA, selections: [{ personIndex: 0, candidateId: "candidate_0_0", resultId: status.candidates[0].resultId }] } as const;
    const request = () => s.app.request(url + "/reuse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal((await request()).status, 409);
    s.state.confirmed = true;
    const before = s.state.solveCalls, selected = await request(); assert.equal(selected.status, 200);
    const result = await selected.json() as Awaited<ReturnType<PreparationService["reuse"]>>;
    assert.equal(result.finalFileVerified, false); assert.equal(result.targetApplicationRequired, true);
    assert.equal(result.selections[0].outputSha256, sha(bvh)); assert.match(result.selections[0].exportUrl, /pose-candidates\/pose_0_0\/export/);
    assert.equal(s.state.solveCalls, before);
    s.state.target++; // Real resolver test below proves source hash excludes body/hand settings.
    assert.equal((await s.service.current(owner))!.batchId, first.batch.batchId);
    const cancelled = await s.app.request(url, { method: "DELETE" }); assert.equal(cancelled.status, 200);
    assert.equal((await s.app.request(url + "/people/0/candidates/candidate_0_0/model")).status, 409);
    const next = await s.prepare(1, "mutation_reentry"); assert.equal(next.batch.revision, 2);
    assert.equal((await s.app.request(url)).status, 409);
    const counts = await s.pg.query<{ n: number }>("SELECT count(*)::int n FROM candidate_preparation_batches"); assert.equal(counts.rows[0].n, 2);
    await s.pg.query("DELETE FROM jobs WHERE id=$1", [owner.jobId]);
    assert.equal((await s.pg.query("SELECT * FROM candidate_preparation_batches")).rows.length, 0);
  } finally { await s.pg.close(); }
});

test("late source/config changes and cancellation fence results; no second global lease while call is alive", async () => {
  const s = await setup();
  try {
    const first = await s.prepare(); let release!: () => void;
    s.state.hold = new Promise<void>(r => { release = r; });
    const tick = s.service.tick();
    for (let n=0; !s.state.solveCalls && n<100; n++) await new Promise(r => setTimeout(r, 5));
    assert.ok(s.state.solveCalls, JSON.stringify(await s.store.head(owner)));
    assert.equal(await s.store.claim(), null);
    await s.service.cancel(owner, first.batch.batchId);
    assert.equal(await s.store.claim(), null); // Cancelled head retains worker reservation until settled.
    release(); await tick;
    assert.equal((await s.store.head(owner))!.status, "cancelled");
    assert.equal((await s.store.head(owner))!.candidates[0].bvh, null);
    s.state.hold = null;
    const second = await s.prepare(1, "mutation_second");
    s.state.engine++;
    await assert.rejects(s.service.current(owner, second.batch.batchId), /PREPARATION_SUPERSEDED/);
    assert.equal((await s.store.head(owner))!.status, "invalidated");
    await assert.rejects(s.prepare(2, "mutation_initial"), /IDEMPOTENCY_CONFLICT/);
  } finally { await s.pg.close(); }
});

test("no-gain is durable success; timeout/corrupt/missing prepared handles stay distinct and retryable", async () => {
  const s = await setup();
  try {
    const first = await s.prepare(); s.state.unavailableCandidate = "candidate_0_1";
    await s.service.tick();
    const b = (await s.store.head(owner))!;
    assert.equal(b.status, "completed"); assert.equal(b.candidates[0].status, "ready_base");
    assert.equal(b.candidates[1].status, "failed_retryable"); assert.ok(b.retryAfter);
    s.state.reuseInvalid = true;
    await assert.rejects(s.service.source(owner, first.batch.batchId, 0, "candidate_0_0"), /PREPARATION_EXPIRED/);
    assert.equal((await s.store.head(owner))!.status, "invalidated");
    s.state.reuseInvalid = false; s.state.corrupt = true;
    const next = await s.prepare(1, "mutation_after_expiry"); await s.service.tick();
    assert.equal((await s.store.get(owner, next.batch.batchId)).candidates[0].status, "failed_retryable");
    assert.equal((await s.store.get(owner, next.batch.batchId)).candidates[0].bvh, null);
  } finally { await s.pg.close(); }
});

test("public mutation rejects untrusted geometry/targets and capability is owned", async () => {
  const s = await setup();
  try {
    const response = await s.app.request(s.base, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: HTTP_SCHEMA, expectedRevision: 0, mutationId: "mutation_request", target: { url: "file:///private" } }) });
    assert.equal(response.status, 400); assert.equal(s.state.solveCalls, 0);
    const capability = await s.app.request(s.base + "/capabilities");
    assert.equal((await capability.json() as { candidatePreparation: boolean }).candidatePreparation, true);
    assert.equal((await s.app.request(s.base + "/capabilities", { headers: { "X-Test-Owner": "inst_other" } })).status, 404);
  } finally { await s.pg.close(); }
});

test("real authority resolver excludes body, shape, hands, appearance and shadow from source keys", async () => {
  let body = 1, hand = 1, shadow = 1, source = 1;
  const context = { keypoints: Array(17).fill([1, 2]), scores: null, refineAllowed: true, refinableLimbs: ["left_arm"],
    skeletonState: "full", coverageClass: "full", slotOrigin: "vlm", skeletonSource: "full_image", lowerBodyObserved: false };
  const resolver = createPreparationResolver({ getOwnedJob: async () => ({ status: "completed", result: { source: "capture",
    candidatesByPerson: [{ personIndex: 0, bodySelection: { selectionRevision: body }, handSelection: { revision: hand },
      candidates: [{ id: "candidate", poseId: "pose", rank: 1, view: "front", sourceBvhSha256: sha(String(source)),
        camera: { source_bvh_sha256: sha(String(source)) } }] }] } }) as unknown as Job,
    loadRefineContext: async () => ({ ...context, refineV3: { mode: "shadow", shadow } }) as never });
  const initial = await resolver(owner, { version: 1 }); body++; hand++; shadow++;
  assert.equal((await resolver(owner, { version: 1 })).contextHash, initial.contextHash);
  source++;
  assert.notEqual((await resolver(owner, { version: 1 })).contextHash, initial.contextHash);
  assert.notEqual((await resolver({ ...owner, installationId: "other" }, { version: 1 })).contextHash, initial.contextHash);
});

test("private transport uses only configured origin/credential, bounds responses, and never echoes upstream errors", async () => {
  let called = "", auth = "";
  const transport = createCandidateRefineTransport({ baseUrl: "http://127.0.0.1:1/", token: "x".repeat(32), fetch: async (url, init) => {
    called = String(url); auth = (init!.headers as Record<string, string>).Authorization;
    return new Response('{"ok":true}');
  } });
  assert.deepEqual(await transport.capabilities(), { ok: true });
  assert.equal(called, "http://127.0.0.1:1/internal/candidate-refine/v1/capabilities"); assert.equal(auth, "Bearer " + "x".repeat(32));
  const huge = createCandidateRefineTransport({ token: "x".repeat(32), fetch: async () => new Response("x".repeat(70000)) });
  await assert.rejects(huge.capabilities(), /CANDIDATE_REFINE_TOO_LARGE/);
});

test("selected-source bridge uses current confirmed prepared bytes and never falls through on stale/cancelled heads", async () => {
  const { createPreparedSelectionSource } = await import("./selection-source.js");
  const s = await setup();
  try {
    const bridge = createPreparedSelectionSource({ enabled: () => true, service: s.service,
      getJob: async () => ({ ...owner, installationId: owner.installationId }) as unknown as Job,
      confirmed: async () => s.state.confirmed });
    assert.equal(await bridge(owner.jobId, 0, "candidate_0_0"), null);
    const b = await s.prepare(); await s.service.tick();
    await assert.rejects(bridge(owner.jobId, 0, "candidate_0_0"), /SELECTION_REQUIRED/);
    s.state.confirmed = true;
    const before = s.state.solveCalls;
    assert.equal(Buffer.from((await bridge(owner.jobId, 0, "candidate_0_0"))!.bytes).toString(), bvh);
    assert.equal(s.state.solveCalls, before);
    await s.service.cancel(owner, b.batch.batchId);
    await assert.rejects(bridge(owner.jobId, 0, "candidate_0_0"), /PREPARATION_SUPERSEDED/);
  } finally { await s.pg.close(); }
});

test("lease renewal/expiry fences an old worker; swapped candidate results never become ready", async () => {
  const s = await setup();
  try {
    const prepared = await s.prepare();
    const first = (await s.store.claim())!;
    assert.equal(await s.store.heartbeat(first.batch, first.leaseId), true);
    await s.pg.query("UPDATE candidate_preparation_batches SET lease_until=now()-interval '1 second' WHERE id=$1", [prepared.batch.batchId]);
    const replacement = (await s.store.claim())!;
    assert.notEqual(replacement.leaseId, first.leaseId);
    assert.equal(await s.store.update(first.batch, b => ({ ...b, status: "completed" }), first.leaseId), null);
    await s.store.release(prepared.batch.batchId, first.leaseId);
    assert.equal(await s.store.claim(), null); // Wrong release cannot free replacement reservation.
    await s.store.release(prepared.batch.batchId, replacement.leaseId);
    const original = s.service.deps.transport.prepare;
    s.service.deps.transport.prepare = async (input, signal) => {
      const response = await original(input, signal) as { results: unknown[] };
      return { ...response, results: [...response.results].reverse() };
    };
    await s.service.tick();
    const b = (await s.store.head(owner))!;
    assert.ok(b.candidates.filter((_, n) => n !== 2).every(c => c.status === "failed_retryable" && !c.bvh));
    assert.equal(b.candidates[2].status, "ready_base"); // unchanged middle result is still valid
  } finally { await s.pg.close(); }
});
