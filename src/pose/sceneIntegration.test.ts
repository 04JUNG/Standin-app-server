import assert from "node:assert/strict";
import test from "node:test";
import { captureSceneWireFixture, createSceneIntegrationFixture } from "./sceneIntegration.fixture.js";
import { resolveOutputScope } from "../output-scope/model.js";

const mode = { contractVersion: "scene-save-v1", saveMode: "auto-correct-v4" };
async function preparedFixture() {
  const f = createSceneIntegrationFixture(), persons = await f.references();
  const response = await f.send({ ...mode, persons, prepare: true, artifactOnly: true });
  assert.equal(response.status, 200, await response.clone().text());
  const review = await response.json() as { reviewKey: string; reviewVersion: string; artifactSha256: string };
  // Only the confirmation fields belong in a save request, not the full JSON review.
  const request = { ...mode, persons, reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 };
  return { ...f, persons, request };
}
test("joined per-person and scene handlers produce client-consumable wire responses and exact replica download", async () => {
  const fixture = await captureSceneWireFixture();
  assert.equal(fixture.responses.prepare.json.personCount, fixture.persons.length);
  assert.equal(fixture.individuals.length, fixture.persons.length);
  for (const person of fixture.individuals) {
    assert.deepEqual(person.reference, fixture.persons[person.personIndex]);
    assert.equal(person.readyResponse.headers["x-standin-artifact-sha256"], person.reference.sha256);
    assert.equal(person.response.headers["x-standin-artifact-sha256"], person.reference.sha256);
  }
  assert.equal(fixture.responses.confirm.headers["x-standin-scene-save-mode"], "auto-correct-v4");
  const exposed = fixture.responses.confirm.headers["access-control-expose-headers"]!.toLowerCase();
  for (const header of ["x-standin-artifact-sha256", "x-standin-person-count", "x-standin-scene-contract", "x-standin-scene-save-mode"])
    assert.ok(exposed.includes(header));
  assert.equal(fixture.observed.workerPlans, 1); assert.equal(fixture.observed.workerBuilds, 1);
  assert.equal(fixture.observed.sceneReceiptLoads, 1);
});
for (const change of ["body", "hands", "scope", "candidate", "source", "confirmation", "owner", "runtime"] as const)
  test(`actual person route blocks changed ${change} on scene preview and save`, async () => {
    const f = await preparedFixture();
    if (change === "body") f.state.bodyRevision[0]++;
    if (change === "hands") f.state.handRevision[0]++;
    if (change === "scope") f.job.result!.candidatesByPerson[0]!.outputScope = resolveOutputScope({ selection: "full" });
    if (change === "candidate") f.job.result!.candidatesByPerson[0]!.candidates[0]!.id = "different-pick";
    if (change === "source") f.state.sourceChanged = true;
    if (change === "confirmation") f.state.confirmed = false;
    if (change === "owner") f.state.owned = false;
    if (change === "runtime") f.state.runtime = "e".repeat(64);
    for (const preview of [true, false]) {
      const response = await f.send({ ...f.request, ...(preview ? { preview: true } : {}) }, f.makeReplica());
      assert.equal(response.status, change === "runtime" ? 503 : 409, await response.clone().text());
      const error = await response.json() as { error: { code: string } };
      assert.ok(error.error.code);
      if (change === "runtime") assert.equal(error.error.code, "PREVIEW_NOT_READY");
      assert.notEqual(response.headers.get("Content-Type"), "image/png");
    }
    assert.equal(f.state.planCalls, 1); assert.equal(f.state.buildCalls, 1);
  });
for (const [change, expected] of [["body", "BODY_PREVIEW_STALE"], ["hands", "HANDS_CHANGED"],
  ["scope", "OUTPUT_SCOPE_CHANGED"], ["job", "SCENE_SOURCE_CHANGED"]] as const)
  test(`late ${change} changes during scene rendering retain typed recovery`, async () => {
    const f = await preparedFixture();
    f.state.beforeRender = () => {
      if (change === "body") f.state.bodyRevision[0]++;
      if (change === "hands") f.state.handRevision[0]++;
      if (change === "scope") f.job.result!.candidatesByPerson[0]!.outputScope = resolveOutputScope({ selection: "full" });
      if (change === "job") f.job.updatedAt = "changed";
    };
    const response = await f.send({ ...f.request, preview: true });
    assert.equal(response.status, 409, await response.clone().text());
    const error = await response.json() as { error: { code: string } };
    assert.equal(error.error.code, expected);
    assert.equal(f.state.planCalls, 1); assert.equal(f.state.buildCalls, 1);
  });

test("render failure never masks a simultaneous source invalidation", async () => {
  const f = await preparedFixture();
  f.state.renderFails = true;
  f.state.beforeRender = () => { f.state.bodyRevision[0]++; };
  const response = await f.send({ ...f.request, preview: true });
  assert.equal(response.status, 409);
  const error = await response.json() as { error: { code: string } };
  assert.equal(error.error.code, "BODY_PREVIEW_STALE");
  assert.equal(f.state.planCalls, 1); assert.equal(f.state.buildCalls, 1);
});
test("optional render failure retains the same valid scene receipt for save", async () => {
  const f = await preparedFixture();
  f.state.renderFails = true;
  const response = await f.send({ ...f.request, preview: true });
  assert.equal(response.status, 502);
  const saved = await f.send(f.request, f.makeReplica());
  assert.equal(saved.status, 200);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), f.finalFbx);
  assert.equal(f.state.planCalls, 1); assert.equal(f.state.buildCalls, 1);
});

for (const change of ["body", "hands", "scope", "candidate", "source", "confirmation", "owner", "runtime"] as const)
  test(`original manifest metadata and binary both retain actual person-route ${change} guards`, async () => {
    const f = createSceneIntegrationFixture(), persons = await f.references();
    const mode = { contractVersion: "scene-save-v1", saveMode: "original-selection", manifestVersion: "csp-scene-manifest-v1" };
    const response = await f.send({ ...mode, persons, prepare: true });
    assert.equal(response.status, 200, await response.clone().text());
    const review = await response.json() as { reviewKey: string; reviewVersion: string; artifactSha256: string };
    const request = { ...mode, persons, reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 };
    if (change === "body") f.state.bodyRevision[0]++;
    if (change === "hands") f.state.handRevision[0]++;
    if (change === "scope") f.job.result!.candidatesByPerson[0]!.outputScope = resolveOutputScope({ selection: "full" });
    if (change === "candidate") f.job.result!.candidatesByPerson[0]!.candidates[0]!.id = "different-pick";
    if (change === "source") f.state.sourceChanged = true;
    if (change === "confirmation") f.state.confirmed = false;
    if (change === "owner") f.state.owned = false;
    if (change === "runtime") f.state.runtime = "e".repeat(64);
    for (const metadataOnly of [true, false]) {
      const result = await f.send({ ...request, ...(metadataOnly ? { metadataOnly: true } : {}) }, f.makeReplica());
      assert.equal(result.status, change === "runtime" ? 503 : 409, await result.clone().text());
      assert.ok((await result.json() as { error: { code: string } }).error.code);
    }
    assert.equal(f.state.composeCalls, 1);
    assert.equal(f.state.planCalls, 0, "original mode never calls v4");
  });
