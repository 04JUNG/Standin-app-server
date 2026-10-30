import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validateSceneCamera, readSceneCameraHeader } from "./sceneCamera.js";
import { SceneBudget } from "./sceneBudget.js";
import { setTimeout as delay } from "node:timers/promises";
import { createSceneIntegrationFixture } from "./sceneIntegration.fixture.js";
import { sceneManifest, scenePeople } from "./sceneManifest.js";
const camera = JSON.parse(readFileSync("src/pose/fixtures/scene-camera-artifact-v1.json", "utf8"));
const image = { width: 1000, height: 768 };
test("Python-generated artifact camera crosses the binary transport without losing framing", () => {
  const header = Buffer.from(JSON.stringify(camera)).toString("base64");
  assert.deepEqual(readSceneCameraHeader(header, camera.artifact_sha256, image), camera);
  assert.equal(readSceneCameraHeader(null, camera.artifact_sha256, image), undefined);
});
for (const field of ["sha", "size", "optics", "target", "auto", "finite"]) {
  test(`camera rejects ${field} mismatch`, () => {
    const c = structuredClone(camera);
    if (field === "sha") c.artifact_sha256 = "f".repeat(64);
    if (field === "size") c.recipe.source_dimensions[0]++;
    if (field === "optics") c.recipe.csp.perspective += 1;
    if (field === "target") c.recipe.csp.focal_point_position[2]++;
    if (field === "auto") c.recipe.automatic_import_framing_verified = true;
    if (field === "finite") c.recipe.csp.camera_position[0] = Infinity;
    assert.throws(() => validateSceneCamera(c, camera.artifact_sha256, image), { code: "CONVERTER_INTEGRITY" });
  });
}
test("malformed or oversized camera headers cannot become unavailable fallbacks", () => {
  for (const header of ["", "not base64", "a".repeat(8193), Buffer.from("{}").toString("base64")])
    assert.throws(() => readSceneCameraHeader(header, camera.artifact_sha256, image), { code: "CONVERTER_INTEGRITY" });
});
test("one scene budget spans sequential stages and blocks late publication", async () => {
  const budget = new SceneBudget(80);
  await budget.run(() => delay(5));
  let published = false;
  await assert.rejects(budget.run(() => delay(100)), { code: "SCENE_TIMEOUT", serverOperationMayContinue: true });
  await assert.rejects(budget.run(async () => { published = true; }), { code: "SCENE_TIMEOUT" });
  assert.equal(published, false);
});
test("abandoning the HTTP request shares its signal with all remaining stages", async () => {
  const parent = new AbortController(), budget = new SceneBudget(1000, parent.signal);
  parent.abort();
  await assert.rejects(budget.run(async () => "must not run"), { code: "SCENE_CANCELLED" });
});

for (const saveMode of ["original-selection", "auto-correct-v4"]) {
  test(`${saveMode} camera survives actual handlers, shared receipt and replica release`, async () => {
    const f = createSceneIntegrationFixture({ camera: camera.recipe }), persons = await f.references();
    const common = { persons, contractVersion: "scene-save-v1", manifestVersion: "csp-scene-manifest-v1", saveMode,
      cameraContractVersion: "scene-camera-artifact-v1" };
    const response = await f.send({ ...common, prepare: true, artifactOnly: true });
    assert.equal(response.status, 200, await response.clone().text());
    const review = await response.json() as any;
    assert.equal(review.manifest.camera.status, "available");
    assert.equal(review.manifest.camera.artifactSha256, review.artifactSha256);
    assert.deepEqual(review.manifest.camera.recipe, camera.recipe);
    const saved = await f.send({ ...common, reviewVersion: review.reviewVersion,
      reviewKey: review.reviewKey, artifactSha256: review.artifactSha256 }, f.makeReplica());
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(saved.headers.get("X-Standin-Artifact-SHA256"), review.artifactSha256);
    const legacy = await f.send({ ...common, cameraContractVersion: undefined, prepare: true, artifactOnly: true });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json() as any).manifest.camera.status, "unavailable");
  });
}
test("route-wide timeout stops before source checks can start composition or publish a receipt", async () => {
  const f = createSceneIntegrationFixture({ timeoutMs: 10, sourceDelayMs: 30 });
  const persons = await f.references();
  const response = await f.send({ persons, contractVersion: "scene-save-v1", saveMode: "original-selection" });
  assert.equal(response.status, 504);
  assert.equal((await response.json() as any).error.code, "SCENE_TIMEOUT");
  await delay(40);
  assert.equal(f.state.composeCalls, 0);
  assert.equal(f.shared.size, 0);
});
test("resized observation dimensions cannot masquerade as a mapped original canvas", () => {
  const f = createSceneIntegrationFixture();
  f.job.inputWidth = 2000; f.job.inputHeight = 1536;
  const m = sceneManifest(f.job, "b".repeat(64), camera.artifact_sha256, "original-selection",
    scenePeople(f.job, [0, 1], []), camera);
  assert.equal(m.camera.status, "unavailable");
  assert.equal(m.camera.reason, "source_dimensions_unmapped");
});
