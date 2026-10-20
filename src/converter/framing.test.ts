import assert from "node:assert/strict";
import test from "node:test";
import {
  convertFramed,
  framingAvailable,
  FramedArtifactCache,
  FRAMING_VERSION,
  type FramedArtifact,
} from "./framing.js";
import { ConverterError, EXPECTED_SOLVER_VERSION, sha256Hex } from "./client.js";

import { encodeFramedPair, decodeFramedPair, framedObjectKey, type FramedPairStore } from "./framedStorage.js";

const bvhBytes = Buffer.from("HIERARCHY MOTION"),
  fbx = Buffer.from("Kaydara FBX Binary  \0\x1a\0fixture");
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

const source = { rules: "standin-body-0.7.1", blendSha256: "1".repeat(64), controllerSha256: "2".repeat(64) };
const lineage = (over: Record<string, unknown> = {}) => ({
  rules: source.rules,
  blend_sha256: source.blendSha256,
  controller_sha256: source.controllerSha256,
  ...over,
});

test("shape controls are forwarded and a converter ignoring their digest is rejected", async () => {
  const shape = { schemaVersion: "body-shape.v1" as const, controls: { muscle: 1.5 }, shapeSha256: "d".repeat(64) };
  let calls = 0;
  const run = (hash: string | null) => convertFramed({ ...input, shape, shapeSource: source }, {
    baseUrl: "https://converter.invalid",
    fetch: (async (_url, request) => {
      calls++;
      const form = request!.body as FormData;
      assert.deepEqual(JSON.parse(form.get("shape") as string), shape);
      assert.deepEqual(JSON.parse(form.get("expected_shape_source") as string), source);
      return Response.json({ ...payload(), shape_sha256: hash, shape_bake: lineage({ shape_sha256: hash }) });
    }) as typeof fetch,
  });
  await assert.rejects(run(null), /integrity/);
  await assert.rejects(run("e".repeat(64)), /integrity/);
  await run(shape.shapeSha256);
  assert.equal(calls, 3);
});

test("a shaped body is baked only from the source the catalog promised", async () => {
  const shape = { schemaVersion: "body-shape.v1" as const, controls: { muscle: 1.5 }, shapeSha256: "d".repeat(64) };
  const respond = (bake: unknown) => deps({ ...payload(), shape_sha256: shape.shapeSha256, shape_bake: bake });
  // No source → never call the converter with a shape it could bake from any version.
  await assert.rejects(convertFramed({ ...input, shape }, respond(lineage())), { code: "CONVERTER_INTEGRITY" });
  for (const bad of [undefined, null, lineage({ rules: "standin-body-0.7.0" }), lineage({ blend_sha256: "9".repeat(64) }), lineage({ controller_sha256: "9".repeat(64) })])
    await assert.rejects(convertFramed({ ...input, shape, shapeSource: source }, respond(bad)), { code: "CONVERTER_INTEGRITY" });
  await convertFramed({ ...input, shape, shapeSource: source }, respond(lineage()));
});

test("shaped GLB must bind its embedded shape digest as well as the response", async () => {
  const shape = { schemaVersion: "body-shape.v1" as const, controls: { muscle: 1 }, shapeSha256: "d".repeat(64) };
  const shaped = { ...input, shape, shapeSource: source, previewFormat: "model" as const, modelRevision: "b".repeat(64), characterSha256: "a".repeat(64) };
  await assert.rejects(convertFramed(shaped, deps({ ...modelPayload(), shape_sha256: shape.shapeSha256, shape_bake: lineage() })), { code: "CONVERTER_INTEGRITY" });
  await convertFramed(shaped, deps({ ...modelPayload({ shape_sha256: shape.shapeSha256 }), shape_sha256: shape.shapeSha256, shape_bake: lineage() }));
});

test("current converter framing works for health and paired artifacts; old/unknown versions fail closed", async () => {
  const health = { ok: true, solver_version: EXPECTED_SOLVER_VERSION,
    framing_version: "skin-regions-v2-shoulder-head",
    output_scopes: ["full", "half", "bust", "shoulder_head", "head"] };
  assert.equal(await framingAvailable(deps(health)), true);
  await convertFramed(input, deps({ ...payload(), framing_version: health.framing_version }));
  for (const framing_version of ["skin-regions-v1", "skin-regions-v99", null]) {
    assert.equal(await framingAvailable(deps({ ...health, framing_version })), false);
    await assert.rejects(convertFramed(input, deps({ ...payload(), framing_version })), { code: "CONVERTER_INTEGRITY" });
  }
});

test("requested hands are transmitted and mismatched bake receipts cannot be exported", async () => {
  const hands = { left: "fist", right: "open", library_version: "hand-library-v1", library_sha256: "a".repeat(64), revision: 1 };
  const receipt = { left: "fist", right: "open", library_version: "hand-library-v1", version: "hand-bake-v1" };
  const overrides = deps({ ...payload(), hands: receipt });
  const fetcher = overrides.fetch;
  overrides.fetch = (async (url, init) => {
    assert.equal((init!.body as FormData).get("hand_left"), "fist");
    assert.equal((init!.body as FormData).get("hand_right"), "open");
    return fetcher(url, init);
  }) as typeof fetch;
  await convertFramed({ ...input, hands }, overrides);
  for (const bad of [null, { ...receipt, left: "relaxed" }, { ...receipt, library_version: "old" }, { ...receipt, version: "unknown" }])
    await assert.rejects(convertFramed({ ...input, hands }, deps({ ...payload(), hands: bad })), { code: "CONVERTER_INTEGRITY" });
});

test("protected export purpose selects the normal converter endpoint; missing support never falls back", async () => {
  const paths: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    paths.push(String(url));
    return new Response("missing",{status:404});
  }) as typeof fetch;
  await assert.rejects(convertFramed({...input,purpose:"export"},{baseUrl:"http://converter",fetch:fetcher}),
    (error:unknown)=>error instanceof ConverterError && error.code === "CONVERTER_UNAVAILABLE");
  assert.deepEqual(paths,["http://converter/convert-framed-export"]);
});

// Shared review-pair regressions: replicas, restart, races, and integrity.
const location = { installationId: "inst_owner", jobId: "job_one" };
function pair(suffix: string): FramedArtifact {
  const fbx = Buffer.from("FBX metadata " + suffix), preview = Buffer.from("PNG " + suffix);
  return { fbx, preview, conversionId: suffix, artifactSha256: sha256Hex(fbx),
    sourceBvhSha256: "a".repeat(64), characterSha256: "b".repeat(64), previewRevision: "c".repeat(64) };
}
function memoryStore() {
  const data = new Map<string, Buffer>();
  const store: FramedPairStore = {
    async load(owner, key) {
      const body = data.get(framedObjectKey(owner, key));
      return body ? decodeFramedPair(key, body) : null;
    },
    async publish(owner, key, result) {
      const path = framedObjectKey(owner, key);
      if (!data.has(path)) data.set(path, encodeFramedPair(key, result));
      return decodeFramedPair(key, data.get(path)!);
    },
  };
  return { store, data };
}
test("replica B and a restarted replica reuse the exact reviewed pair without rendering", async () => {
  const { store } = memoryStore();
  const first = new FramedArtifactCache(undefined, undefined, undefined, store);
  const second = new FramedArtifactCache(undefined, undefined, undefined, store);
  const preview = await first.get("revision-1", async () => pair("preview replica"), location);
  let renders = 0;
  const download = await second.get("revision-1", async () => { renders++; return pair("export replica"); }, location);
  const restarted = await new FramedArtifactCache(undefined, undefined, undefined, store)
    .get("revision-1", async () => { renders++; return pair("restart"); }, location);
  assert.equal(renders, 0);
  assert.equal(download.artifactSha256, preview.artifactSha256);
  assert.deepEqual(download.fbx, preview.fbx);
  assert.deepEqual(restarted.preview, preview.preview);
});
test("simultaneous different renders converge on the first published PNG and FBX", async () => {
  const { store } = memoryStore();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const create = async (suffix: string) => {
    if (++started === 2) release();
    await gate;
    return pair(suffix);
  };
  const [a, b] = await Promise.all(["a", "b"].map(suffix =>
    new FramedArtifactCache(undefined, undefined, undefined, store)
      .get("same-revision", () => create(suffix), location)));
  assert.equal(started, 2);
  assert.deepEqual(a, b);
});
test("owner, job, and revision changes cannot reuse a different reviewed artifact", async () => {
  const { store, data } = memoryStore();
  const cache = new FramedArtifactCache(undefined, undefined, undefined, store);
  for (const [owner, key] of [[location, "rev-1"], [location, "rev-2"],
    [{ ...location, jobId: "job_two" }, "rev-1"], [{ ...location, installationId: "inst_other" }, "rev-1"]] as const) {
    await cache.get(key, async () => pair(key), owner);
  }
  assert.equal(data.size, 4);
  assert.throws(() => framedObjectKey({ ...location, jobId: "../../other" }, "rev"));
});
test("storage failure never exposes an unpersisted receipt or silently rerenders on corruption", async () => {
  let renders = 0;
  const failed: FramedPairStore = { async load() { throw Error("storage unavailable"); }, async publish() { throw Error("write"); } };
  await assert.rejects(new FramedArtifactCache(undefined, undefined, undefined, failed)
    .get("rev", async () => { renders++; return pair("wrong"); }, location));
  assert.equal(renders, 0);
  const writeFailed: FramedPairStore = { async load() { return null; }, async publish() { throw Error("write"); } };
  await assert.rejects(new FramedArtifactCache(undefined, undefined, undefined, writeFailed)
    .get("rev", async () => pair("unsaved"), location));
});
test("stored envelope validates key, both byte hashes, and lineage", () => {
  const bytes = encodeFramedPair("key", pair("one"));
  assert.deepEqual(decodeFramedPair("key", bytes), pair("one"));
  assert.throws(() => decodeFramedPair("other-key", bytes));
  for (const field of ["fbx", "preview", "sourceBvhSha256", "characterSha256", "previewRevision", "artifactSha256"]) {
    const value = JSON.parse(bytes.toString()); value[field] = "corrupted";
    assert.throws(() => decodeFramedPair("key", Buffer.from(JSON.stringify(value))));
  }
});

test("manual export requires the already reviewed file and never renders on a missing receipt", async () => {
  const { store, data } = memoryStore();
  let renders = 0;
  const render = async () => { renders++; return pair("reviewed"); };
  const first = new FramedArtifactCache(undefined, undefined, undefined, store);
  const second = new FramedArtifactCache(undefined, undefined, undefined, store);
  await assert.rejects(first.get("not-reviewed", render, location, true), /reviewed artifact expired/);
  assert.equal(renders, 0);
  const preview = await first.get("reviewed", render, location);
  const download = await second.get("reviewed", render, location, true);
  assert.deepEqual(download.fbx, preview.fbx); assert.equal(renders, 1);
  data.clear();
  await assert.rejects(new FramedArtifactCache(undefined, undefined, undefined, store)
    .get("reviewed", render, location, true), /reviewed artifact expired/);
  assert.equal(renders, 1);
});

test("artifact-only contract validates FBX lineage and persists without any image", async () => {
  const value = { ...payload(), artifact_contract: "verified-fbx-v1", preview_format: "none" };
  delete (value as Partial<typeof value>).preview_base64;
  delete (value as Partial<typeof value>).preview_sha256;
  const result = await convertFramed({ ...input, previewFormat: "none" }, deps(value));
  assert.equal(result.preview.length, 0);
  assert.equal(result.artifactContract, "verified-fbx-v1");
  assert.deepEqual(decodeFramedPair("ready", encodeFramedPair("ready", result)), result);
  for (const change of [{ artifact_contract: "old" }, { fbx_sha256: "a".repeat(64) }, { output_scope: "head" }, { source_bvh_sha256: "b".repeat(64) }])
    await assert.rejects(convertFramed({ ...input, previewFormat: "none" }, deps({ ...value, ...change })), { code: "CONVERTER_INTEGRITY" });
});

test("shared preparation cancels only when every subscriber leaves, then retries cleanly", async () => {
  const cache = new FramedArtifactCache();
  const a = new AbortController(), b = new AbortController();
  let workSignal!: AbortSignal, finish!: (value: FramedArtifact) => void;
  const create = (signal: AbortSignal) => {
    workSignal = signal;
    return new Promise<FramedArtifact>((resolve, reject) => {
      finish = resolve; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const first = cache.get("shared", create, undefined, false, a.signal);
  const second = cache.get("shared", create, undefined, false, b.signal);
  a.abort();
  await assert.rejects(first);
  assert.equal(workSignal.aborted, false);
  b.abort();
  await assert.rejects(second);
  assert.equal(workSignal.aborted, true);
  const next = cache.get("shared", create);
  await new Promise((resolve) => setImmediate(resolve));
  finish({ fbx, preview, conversionId: "new", artifactSha256: sha256Hex(fbx), sourceBvhSha256: sha256Hex(bvhBytes) });
  assert.equal((await next).conversionId, "new");
});
