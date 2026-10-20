import assert from "node:assert/strict";
import test from "node:test";
import { FramedArtifactCache, type FramedArtifact } from "./framing.js";
import { sha256Hex } from "./client.js";
import { encodeFramedPair, decodeFramedPair, framedObjectKey, type FramedPairStore } from "./framedStorage.js";

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
