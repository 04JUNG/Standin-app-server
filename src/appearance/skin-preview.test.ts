/** Bounded preview overlay validation with synthetic arrays/PNG, not visual evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { hash } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { context } from "./skin-fixture.js";
import { skinPreview, checkSkinPreviewModel, verifySkinPreviewAsset, type SkinPreview } from "./skin-preview.js";
const triangles = [[0, 1, 2]], uv = [[0, 0], [1, 0], [0, 1]];
const source = context.asset.characterSha256;
const compressed = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)));
const uvBytes = compressed({ uv, triangles, source_sha256: source });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const preview: SkinPreview = { ...skinPreview(context, "synthetic-current-model"),
  compatibility: { ...skinPreview(context, "synthetic-current-model").compatibility, vertices: 3, bones: 1, trianglesSha256: hash(triangles) },
  uv: { sha256: sha256Hex(uvBytes), bytes: uvBytes.length }, texture: { sha256: sha256Hex(png), bytes: png.length } };
test("preview assets bind exact compressed UV source/corners/topology and separate bounded PNG", () => {
  assert.equal(verifySkinPreviewAsset(preview, preview.uv.sha256, uvBytes), "application/gzip");
  assert.equal(verifySkinPreviewAsset(preview, preview.texture.sha256, png), "image/png");
  assert.throws(() => verifySkinPreviewAsset(preview, hash("unknown"), png), /SKIN_INTEGRITY_ERROR/);
  assert.throws(() => verifySkinPreviewAsset(preview, preview.uv.sha256, uvBytes.subarray(1)), /SKIN_INTEGRITY_ERROR/);
  for (const bad of [{ uv, triangles, source_sha256: hash("other model") }, { uv: uv.slice(1), triangles, source_sha256: source },
    { uv: [[0, NaN], [1, 0], [0, 1]], triangles, source_sha256: source },
    { uv: [[0, 2], [1, 0], [0, 1]], triangles, source_sha256: source },
    { uv, triangles: [[0, 1, 3]], source_sha256: source }, { uv, triangles: [[0, 2, 1]], source_sha256: source },
    { uv, triangles, source_sha256: source, positions: [[0, 0, 0]] }]) {
    const bytes = compressed(bad), pin = { ...preview, uv: { sha256: sha256Hex(bytes), bytes: bytes.length } };
    assert.throws(() => verifySkinPreviewAsset(pin, pin.uv.sha256, bytes), /SKIN_INTEGRITY_ERROR/);
  }
  const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  const bombPin = { ...preview, uv: { sha256: sha256Hex(bomb), bytes: bomb.length } };
  assert.throws(() => verifySkinPreviewAsset(bombPin, bombPin.uv.sha256, bomb), /SKIN_INTEGRITY_ERROR/);
  const large = Buffer.from(png); large.writeUInt32BE(4096, 16);
  const largePin = { ...preview, texture: { sha256: sha256Hex(large), bytes: large.length } };
  assert.throws(() => verifySkinPreviewAsset(largePin, largePin.texture.sha256, large), /SKIN_INTEGRITY_ERROR/);
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
