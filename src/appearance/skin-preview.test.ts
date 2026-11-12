/** Bounded preview overlay validation with synthetic arrays/PNG, not visual evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { hash } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { context } from "./skin-fixture.js";
import { skinPreview, checkSkinPreviewModel, verifySkinPreviewAsset, skinUvVerificationRuns, type SkinPreview } from "./skin-preview.js";
import { checkSkinUv, type SkinUvPin } from "./skin-uv.js";
const triangles = [[0, 1, 2]], uv = [[0, 0], [1, 0], [0, 1]];
const source = context.asset.characterSha256;
const compressed = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));
const uvBytes = compressed({ uv, triangles, source_sha256: source });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const preview: SkinPreview = { ...skinPreview(context, "synthetic-current-model"),
  compatibility: { ...skinPreview(context, "synthetic-current-model").compatibility, vertices: 3, bones: 1, trianglesSha256: hash(triangles) },
  uv: { sha256: sha256Hex(uvBytes), bytes: uvBytes.length }, texture: { sha256: sha256Hex(png), bytes: png.length } };
/** Every rule of the former zod schema: strict keys, exact tuples, finite [0,1] corners, safe
 * non-negative indices below the pinned vertex count, corner count, source and topology hash. */
const violations = [{ uv, triangles, source_sha256: hash("other model") }, { uv: uv.slice(1), triangles, source_sha256: source },
  { uv: [[0, NaN], [1, 0], [0, 1]], triangles, source_sha256: source },
  { uv: [[0, 2], [1, 0], [0, 1]], triangles, source_sha256: source },
  { uv, triangles: [[0, 1, 3]], source_sha256: source }, { uv, triangles: [[0, 2, 1]], source_sha256: source },
  { uv, triangles, source_sha256: source, positions: [[0, 0, 0]] },
  { uv, triangles }, { triangles, source_sha256: source }, { uv, source_sha256: source }, [uv, triangles, source],
  { uv: [[0, 0, 0], [1, 0], [0, 1]], triangles, source_sha256: source }, { uv: [[0], [1, 0], [0, 1]], triangles, source_sha256: source },
  { uv: [["0", 0], [1, 0], [0, 1]], triangles, source_sha256: source }, { uv: [[-0.5, 0], [1, 0], [0, 1]], triangles, source_sha256: source },
  { uv: [...uv, [0, 0]], triangles, source_sha256: source }, { uv, triangles: [], source_sha256: source },
  { uv, triangles: [[0, 1]], source_sha256: source }, { uv, triangles: [[0, 1, 2, 0]], source_sha256: source },
  { uv, triangles: [[0, 1, 1.5]], source_sha256: source }, { uv, triangles: [[0, 1, -1]], source_sha256: source },
  { uv, triangles: [[0, 1, "2"]], source_sha256: source }, null, "uv"];
/** The removed per-request zod schema, kept as an oracle: the single-pass check must agree with it. */
function zodOracle(bytes: Uint8Array, pin: SkinUvPin) {
  try {
    const raw: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
    const value = z.object({ source_sha256: z.literal(pin.characterSha256),
      uv: z.array(z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)])).min(3).max(1000000),
      triangles: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])).min(1).max(333333),
    }).strict().parse(raw);
    return value.uv.length === value.triangles.length * 3 && hash(value.triangles) === pin.trianglesSha256 &&
      !value.triangles.some(t => t.some(i => i >= pin.vertices));
  } catch { return false; }
}
test("preview assets bind exact compressed UV source/corners/topology and separate bounded PNG", async () => {
  assert.equal(await verifySkinPreviewAsset(preview, preview.uv.sha256, uvBytes), "application/gzip");
  assert.equal(await verifySkinPreviewAsset(preview, preview.texture.sha256, png), "image/png");
  await assert.rejects(verifySkinPreviewAsset(preview, hash("unknown"), png), /SKIN_INTEGRITY_ERROR/);
  await assert.rejects(verifySkinPreviewAsset(preview, preview.uv.sha256, uvBytes.subarray(1)), /SKIN_INTEGRITY_ERROR/);
  const pinned = { characterSha256: source, vertices: 3, trianglesSha256: hash(triangles) };
  assert.doesNotThrow(() => checkSkinUv(uvBytes, pinned));
  assert.equal(zodOracle(uvBytes, pinned), true);
  for (const bad of violations) {
    const bytes = compressed(bad), pin = { ...preview, uv: { sha256: sha256Hex(bytes), bytes: bytes.length } };
    assert.equal(zodOracle(bytes, pinned), false, JSON.stringify(bad));
    assert.throws(() => checkSkinUv(bytes, pinned), Error, JSON.stringify(bad));
    await assert.rejects(verifySkinPreviewAsset(pin, pin.uv.sha256, bytes), /SKIN_INTEGRITY_ERROR/);
  }
  const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  const bombPin = { ...preview, uv: { sha256: sha256Hex(bomb), bytes: bomb.length } };
  await assert.rejects(verifySkinPreviewAsset(bombPin, bombPin.uv.sha256, bomb), /SKIN_INTEGRITY_ERROR/);
  const large = Buffer.from(png); large.writeUInt32BE(4096, 16);
  const largePin = { ...preview, texture: { sha256: sha256Hex(large), bytes: large.length } };
  await assert.rejects(verifySkinPreviewAsset(largePin, largePin.texture.sha256, large), /SKIN_INTEGRITY_ERROR/);
});
test("a production-sized UV is checked off the event loop, once per pinned digest", async () => {
  // Same shape as the approved 139,474-vertex male UV that held production's event loop ~10 s.
  const vertices = 139474, count = 278944;
  const big = { triangles: Array.from({ length: count }, (_, i) => [i % vertices, (i + 1) % vertices, (i + 2) % vertices]),
    uv: Array.from({ length: count * 3 }, (_, i) => [(i % 997) / 997 + 1e-9, (i % 991) / 991 + 1e-9]), source_sha256: source };
  const bytes = gzipSync(Buffer.from(JSON.stringify(big)), { level: 1 });
  const pin: SkinPreview = { ...preview, compatibility: { ...preview.compatibility, vertices, trianglesSha256: hash(big.triangles) },
    uv: { sha256: sha256Hex(bytes), bytes: bytes.length } };
  let started = performance.now();
  checkSkinUv(bytes, { characterSha256: source, vertices, trianglesSha256: pin.compatibility.trianglesSha256 });
  const inThreadMs = performance.now() - started;
  const runs = skinUvVerificationRuns();
  let last = performance.now(), maxGap = 0;
  const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
  try {
    started = performance.now();
    // Concurrent requests for one digest share a single worker run.
    assert.deepEqual(await Promise.all([1, 2, 3].map(() => verifySkinPreviewAsset(pin, pin.uv.sha256, bytes))),
      ["application/gzip", "application/gzip", "application/gzip"]);
  } finally { clearInterval(tick); }
  assert.equal(skinUvVerificationRuns(), runs + 1);
  assert.ok(maxGap < Math.max(inThreadMs / 2, 100), `event loop held ${maxGap.toFixed(0)} ms (in-thread check ${inThreadMs.toFixed(0)} ms)`);
  // Exact bytes again: length + SHA-256 only, no second structure check.
  assert.equal(await verifySkinPreviewAsset(pin, pin.uv.sha256, bytes), "application/gzip");
  assert.equal(skinUvVerificationRuns(), runs + 1);
  // Different bytes are never vouched for by the remembered verdict.
  const tampered = Buffer.from(bytes); tampered[tampered.length - 9] ^= 1;
  await assert.rejects(verifySkinPreviewAsset(pin, pin.uv.sha256, tampered), /SKIN_INTEGRITY_ERROR/);
  // A rejected digest is remembered as rejected, not re-checked.
  const bad = compressed(violations[0]), badPin = { ...preview, uv: { sha256: sha256Hex(bad), bytes: bad.length } };
  await assert.rejects(verifySkinPreviewAsset(badPin, badPin.uv.sha256, bad), /SKIN_INTEGRITY_ERROR/);
  const afterBad = skinUvVerificationRuns();
  await assert.rejects(verifySkinPreviewAsset(badPin, badPin.uv.sha256, bad), /SKIN_INTEGRITY_ERROR/);
  assert.equal(skinUvVerificationRuns(), afterBad);
});
test("preview topology verifies the approved mesh/index identity without altering any canonical geometry", () => {
  const model = { meshes: [{ name: "mesh_000", positions: [[9, 8, 7], [2, 3, 4], [5, 6, 7]], triangles }], bones: [{}] };
  const before = JSON.stringify(model);
  checkSkinPreviewModel(preview, model);
  assert.equal(JSON.stringify(model), before);
  for (const bad of [{ ...model, bones: [] }, { ...model, meshes: [] }, { ...model, meshes: [{ ...model.meshes[0], name: "other" }] },
    { ...model, meshes: [{ ...model.meshes[0], positions: [] }] }, { ...model, meshes: [{ ...model.meshes[0], triangles: [[0, 2, 1]] }] }])
    assert.throws(() => checkSkinPreviewModel(preview, bad), /SKIN_UV_INCOMPATIBLE/);
});
