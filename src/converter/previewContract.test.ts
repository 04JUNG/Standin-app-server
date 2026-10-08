import assert from "node:assert/strict";
import test from "node:test";
import { getPreviewModel } from "./previewModel.js";
import { getPreviewRuntime } from "./previewRuntime.js";
import { convertFramed, FRAMING_VERSION } from "./framing.js";
import { EXPECTED_SOLVER_VERSION, sha256Hex } from "./client.js";
const source = "a".repeat(64),
  character = "b".repeat(64),
  revision = "c".repeat(64),
  modelRevision = "d".repeat(64);
const expected = {
  characterSha256: character,
  previewRevision: revision,
  modelRevision,
};
function glb(overrides: Record<string, unknown> = {}) {
  const meta = {
    version: "posed-mesh-v1",
    revision: modelRevision,
    source_bvh_sha256: source,
    character_sha256: character,
    character_id: "registered-body",
    scope: "full",
    coordinates: "Y-up-hips-origin",
    ...overrides,
  };
  const text = JSON.stringify({ asset: { extras: meta } });
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4));
  const bytes = Buffer.alloc(28 + json.length);
  bytes.write("glTF");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(0, 20 + json.length);
  bytes.writeUInt32LE(0x004e4942, 24 + json.length);
  return bytes;
}
function fetchModel(bytes = glb(), headers: Record<string, string> = {}) {
  return (async (url) => {
    const u = new URL(String(url), "https://converter.invalid");
    assert.equal(u.searchParams.get("character_id"), "registered-body");
    assert.equal(u.searchParams.get("expected_character_sha256"), character);
    assert.equal(u.searchParams.get("expected_preview_revision"), revision);
    return new Response(bytes, {
      headers: {
        "Content-Type": "model/gltf-binary",
        "X-Standin-Model-Version": "posed-mesh-v1",
        "X-Standin-Character-SHA256": character,
        "X-Standin-Source-BVH-SHA256": source,
        "X-Standin-Preview-Revision": revision,
        "X-Standin-Model-Revision": modelRevision,
        "X-Standin-Artifact-SHA256": sha256Hex(bytes),
        ...headers,
      },
    });
  }) as typeof fetch;
}
test("GLB validates expected body/runtime in headers AND embedded identity", async () => {
  assert.deepEqual(
    await getPreviewModel(source, "registered-body", fetchModel(), expected),
    glb(),
  );
});
for (const header of [
  "X-Standin-Character-SHA256",
  "X-Standin-Source-BVH-SHA256",
  "X-Standin-Preview-Revision",
  "X-Standin-Model-Revision",
  "X-Standin-Artifact-SHA256",
])
  test(`reject wrong ${header}`, async () => {
    await assert.rejects(
      getPreviewModel(
        source,
        "registered-body",
        fetchModel(glb(), { [header]: "e".repeat(64) }),
        expected,
      ),
      { code: "CONVERTER_INTEGRITY" },
    );
  });
for (const field of [
  "version",
  "revision",
  "source_bvh_sha256",
  "character_sha256",
  "character_id",
  "scope",
  "coordinates",
])
  test(`reject wrong GLB ${field} even with matching HTTP checksum`, async () => {
    await assert.rejects(
      getPreviewModel(
        source,
        "registered-body",
        fetchModel(glb({ [field]: "wrong" })),
        expected,
      ),
      { code: "CONVERTER_INTEGRITY" },
    );
  });
test("missing GLB is explicit and never returns a default model", async () => {
  await assert.rejects(
    getPreviewModel(
      source,
      "registered-body",
      (async () => new Response(null, { status: 404 })) as typeof fetch,
      expected,
    ),
    { code: "PREVIEW_NOT_READY" },
  );
});
test("old converter without runtime headers cannot masquerade as supported", async () => {
  const fetcher = async (url: string | URL | Request) => {
    const r = await fetchModel()(url);
    r.headers.delete("X-Standin-Preview-Revision");
    return r;
  };
  await assert.rejects(
    getPreviewModel(
      source,
      "registered-body",
      fetcher as typeof fetch,
      expected,
    ),
    { code: "CONVERTER_INTEGRITY" },
  );
});
const contract = {
  schema_version: "body-preview-runtime.v1",
  preview_revision: revision,
  model_version: "posed-mesh-v1",
  model_revision: modelRevision,
  solver_version: EXPECTED_SOLVER_VERSION,
  framing_version: FRAMING_VERSION,
};
test("runtime contract is validated; unavailable/old/oversize responses fail closed", async () => {
  const fetcher = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), { status })) as typeof fetch;
  assert.equal(
    (await getPreviewRuntime(fetcher(contract))).previewRevision,
    revision,
  );
  for (const value of [
    {},
    { ...contract, model_revision: "bad" },
    { ...contract, solver_version: "old" },
    "x".repeat(8193),
  ])
    await assert.rejects(getPreviewRuntime(fetcher(value)), {
      code: "BODY_PREVIEW_UNAVAILABLE",
    });
  await assert.rejects(getPreviewRuntime(fetcher(contract, 503)), {
    code: "BODY_PREVIEW_UNAVAILABLE",
  });
});
test("PNG fallback forwards expected body/runtime and checks both after conversion", async () => {
  const bvhBytes = Buffer.from("unchanged BVH"),
    fbx = Buffer.from("Kaydara FBX Binary fixture"),
    png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const input = {
    bvhBytes,
    characterId: "registered-body",
    scope: "full" as const,
    expectedCharacterSha256: character,
    expectedPreviewRevision: revision,
  };
  const payload = {
    solver_version: EXPECTED_SOLVER_VERSION,
    framing_version: FRAMING_VERSION,
    preview_revision: revision,
    output_scope: "full",
    preview_view: "front",
    character_id: "registered-body",
    character_sha256: character,
    source_bvh_sha256: sha256Hex(bvhBytes),
    conversion_id: "test",
    fbx_sha256: sha256Hex(fbx),
    preview_sha256: sha256Hex(png),
    fbx_base64: fbx.toString("base64"),
    preview_base64: png.toString("base64"),
  };
  const run = (overrides: Record<string, unknown> = {}) =>
    convertFramed(input, {
      baseUrl: "https://converter.invalid",
      fetch: (async (_url, request) => {
        const form = request!.body as FormData;
        assert.equal(form.get("expected_character_sha256"), character);
        assert.equal(form.get("expected_preview_revision"), revision);
        return new Response(JSON.stringify({ ...payload, ...overrides }));
      }) as typeof fetch,
    });
  assert.deepEqual((await run()).preview, png);
  await assert.rejects(run({ character_sha256: "e".repeat(64) }), {
    code: "CONVERTER_INTEGRITY",
  });
  await assert.rejects(run({ preview_revision: undefined }), {
    code: "CONVERTER_INTEGRITY",
  });
  await assert.rejects(run({ preview_revision: "e".repeat(64) }), {
    code: "CONVERTER_INTEGRITY",
  });
});
