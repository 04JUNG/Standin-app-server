import assert from "node:assert/strict";
import test from "node:test";
import {
  convertFramed,
  framingAvailable,
  FramedArtifactCache,
  FRAMING_VERSION,
} from "./framing.js";
import { EXPECTED_SOLVER_VERSION, sha256Hex } from "./client.js";

const bvhBytes = Buffer.from("HIERARCHY MOTION"),
  fbx = Buffer.from("Kaydara FBX Binary fixture");
const preview = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const input = {
  bvhBytes,
  scope: "half" as const,
  characterId: "standin-master-v2",
};
function payload() {
  return {
    solver_version: EXPECTED_SOLVER_VERSION,
    framing_version: FRAMING_VERSION,
    output_scope: "half",
    preview_view: "front",
    character_id: input.characterId,
    character_sha256: "a".repeat(64),
    conversion_id: "test",
    source_bvh_sha256: sha256Hex(bvhBytes),
    fbx_sha256: sha256Hex(fbx),
    preview_sha256: sha256Hex(preview),
    fbx_base64: fbx.toString("base64"),
    preview_base64: preview.toString("base64"),
  };
}
function deps(value: unknown, status = 200) {
  return {
    baseUrl: "https://converter.invalid",
    fetch: (async (_url, request) => {
      if (request?.method === "POST") {
        const body = request.body as FormData;
        assert.equal(body.get("output_scope"), "half");
        assert.equal(body.get("expected_bvh_sha256"), sha256Hex(bvhBytes));
      }
      return new Response(JSON.stringify(value), { status });
    }) as typeof fetch,
  };
}
test("paired response validates input, character, scope and both artifact hashes", async () => {
  const result = await convertFramed(input, deps(payload()));
  assert.deepEqual(result.fbx, fbx);
  assert.deepEqual(result.preview, preview);
});
for (const field of [
  "solver_version",
  "framing_version",
  "output_scope",
  "preview_view",
  "character_id",
  "source_bvh_sha256",
  "fbx_sha256",
  "preview_sha256",
  "fbx_base64",
  "preview_base64",
]) {
  test(`reject corrupted ${field}`, async () => {
    await assert.rejects(
      convertFramed(input, deps({ ...payload(), [field]: "wrong" })),
      { code: "CONVERTER_INTEGRITY" },
    );
  });
}
test("HTTP failure never becomes an artifact", async () => {
  await assert.rejects(convertFramed(input, deps({}, 503)), {
    code: "CONVERTER_UNAVAILABLE",
  });
});
test("capability requires healthy matching converter with all four scopes", async () => {
  const health = {
    ok: true,
    solver_version: EXPECTED_SOLVER_VERSION,
    framing_version: FRAMING_VERSION,
    output_scopes: ["full", "half", "bust", "head"],
  };
  assert.equal(await framingAvailable(deps(health)), true);
  assert.equal(
    await framingAvailable(deps({ ...health, output_scopes: ["full"] })),
    false,
  );
  assert.equal(await framingAvailable(deps({})), false);
  assert.equal(await framingAvailable(deps(health, 503)), false);
});
test("cache coalesces paired requests, isolates keys and evicts over budget", async () => {
  const result = {
    fbx,
    preview,
    conversionId: "id",
    artifactSha256: sha256Hex(fbx),
    sourceBvhSha256: sha256Hex(bvhBytes),
  };
  const cache = new FramedArtifactCache(fbx.length + preview.length);
  let calls = 0;
  const make = async () => {
    calls++;
    return result;
  };
  await Promise.all([cache.get("owner-a", make), cache.get("owner-a", make)]);
  assert.equal(calls, 1);
  await cache.get("owner-b", make);
  assert.equal(calls, 2);
  await cache.get("owner-a", make);
  assert.equal(calls, 3);
});
