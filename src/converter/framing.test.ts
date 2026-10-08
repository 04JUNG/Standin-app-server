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

function modelPayload(change: Record<string, unknown> = {}) {
  const meta = {
    version: "framed-mesh-v1",
    revision: "b".repeat(64),
    scope: "half",
    camera_rotation: null,
    coordinates: "Y-up-hips-origin",
    source_bvh_sha256: sha256Hex(bvhBytes),
    character_id: "standin-master-v2",
    character_sha256: "a".repeat(64),
    base_fbx_sha256: sha256Hex(fbx),
    ...change,
  };
  const json = JSON.stringify({ asset: { extras: meta } });
  const encoded = Buffer.from(
    json + " ".repeat((-Buffer.byteLength(json) >>> 0) % 4),
  );
  const header = Buffer.alloc(20),
    bin = Buffer.alloc(12);
  [0x46546c67, 2, 32 + encoded.length, encoded.length, 0x4e4f534a].forEach(
    (v, i) => header.writeUInt32LE(v, i * 4),
  );
  bin.writeUInt32LE(4, 0);
  bin.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, encoded, bin]);
  return {
    ...payload(),
    preview_format: "model",
    preview_model_revision: "b".repeat(64),
    preview_base64: glb.toString("base64"),
    preview_sha256: sha256Hex(glb),
  };
}
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

test("model transport checks the final FBX, camera and pinned exporter identity", async () => {
  const modelInput = {
    ...input,
    previewFormat: "model" as const,
    modelRevision: "b".repeat(64),
    characterSha256: "a".repeat(64),
  };
  const output = await convertFramed(modelInput, deps(modelPayload()));
  assert.equal(Buffer.from(output.preview).subarray(0, 4).toString(), "glTF");
  for (const field of [
    "scope",
    "character_id",
    "character_sha256",
    "revision",
    "source_bvh_sha256",
    "base_fbx_sha256",
    "camera_rotation",
  ])
    await assert.rejects(
      convertFramed(modelInput, deps(modelPayload({ [field]: "wrong" }))),
      { code: "CONVERTER_INTEGRITY" },
    );
  await assert.rejects(
    convertFramed(
      { ...modelInput, modelRevision: "c".repeat(64) },
      deps(modelPayload()),
    ),
    { code: "CONVERTER_INTEGRITY" },
  );
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

test("camera is forwarded and an older converter cannot silently drop it", async () => {
  const cameraRotation = [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ];
  const value = { ...payload(), camera_rotation: cameraRotation };
  let forwarded: FormData | undefined;
  const result = await convertFramed(
    { ...input, cameraRotation },
    {
      baseUrl: "https://converter.invalid",
      fetch: (async (_url, req) => {
        forwarded = req!.body as FormData;
        return new Response(JSON.stringify(value));
      }) as typeof fetch,
    },
  );
  assert.equal(
    forwarded!.get("camera_rotation"),
    JSON.stringify(cameraRotation),
  );
  assert.deepEqual(result.preview, preview);
  await assert.rejects(
    convertFramed({ ...input, cameraRotation }, deps(payload())),
    { code: "CONVERTER_INTEGRITY" },
  );
});
