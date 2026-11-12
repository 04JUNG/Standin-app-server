/** Synthetic protocol fixtures only: no texture/Blender/CSP acceptance claim. */
import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { parseTexturedArtifact } from "./skin-proof.js";
import { bytes, op, context, selection, fixture } from "./skin-fixture.js";
const sha = hash("synthetic runtime");
test("textured proof retains base lineage and exact skin/asset/model/runtime/manifest binding", () => {
  const parsed = parseTexturedArtifact(fixture(), op, selection, context);
  assert.deepEqual(parsed.bytes, bytes);
  assert.equal(parsed.receipt.artifactSha256, sha256Hex(bytes));
  assert.equal(parsed.receipt.assetVersion, "synthetic-v1");
  assert.equal(parsed.receipt.compatibility.polygonIndicesSha256, context.asset.polygonIndicesSha256);
  for (const patch of [{ runtime_revision: hash("other") }, { source_artifact_sha256: sha }, { fbx_sha256: sha },
    { skin: { version: "fbx-skin-v1", id: "muscle" } }, { skin_sha256: sha }, { binding_sha256: sha },
    { character_id: "other" }, { character_sha256: sha }, { output_scope: "head" },
    { asset_manifest_sha256: sha }, { uv_sha256: sha }, { texture_sha256: sha }, { csp_certified: false },
    { file_verified: false }, { extra: "unrecognized" },
    { base: { ...fixture().receipt.base, approved_surface_changes_only: false } },
    { base: { ...fixture().receipt.base, maxWeightError: .000002 } },
    { base: { ...fixture().receipt.base, maxPositionErrorM: .0002 } },
    { base: { ...fixture().receipt.base, maxNormalError: .0002 } },
    { material: { ...fixture().receipt.material, embedded: false } },
    { material: { ...fixture().receipt.material, uv_verified: false } },
    { material: { ...fixture().receipt.material, image_verified: false } }])
    assert.throws(() => parseTexturedArtifact({ ...fixture(), receipt: { ...fixture().receipt, ...patch } }, op, selection, context), /SKIN_INTEGRITY_ERROR/);
  for (const changed of [{ ...op, installationId: "other" }, { ...op, jobId: "job_other" }, { ...op, personIndex: 1 },
    { ...op, revision: 2 }, { ...op, stateHash: sha }, { ...op, selectionHash: sha },
    { ...op, appearance: { version: "fbx-outline-v1" as const, width: 2 } },
    { ...op, receipt: { ...op.receipt, skin: { meshes: 1, bones: 51 } } }])
    assert.throws(() => parseTexturedArtifact(fixture(), changed, selection, context), /SKIN_INTEGRITY_ERROR/);
  for (const changed of [{ ...context, assetVersion: "other" }, { ...context, assetManifestSha256: sha },
    { ...context, approvalIdentity: sha }, { ...context, runtimeRevision: hash("replacement") },
    { ...context, asset: { ...context.asset, uvSha256: sha } },
    { ...context, asset: { ...context.asset, textures: { flesh: { sha256: sha, bytes: 10 } } } }])
    assert.throws(() => parseTexturedArtifact(fixture(), op, selection, changed), /SKIN_INTEGRITY_ERROR/);
});
test("claimed verification flags cannot hide malformed material manifest or wrong actual FBX bytes", () => {
  const m = fixture().receipt.material.manifest;
  for (const patch of [{ objects: {} }, { objects: { ...m.objects, "5": sha } }, { objects: { "1": sha, "2": sha, "3": sha } },
    { objects: { "9223372036854775808": sha, "2": hash(2), "3": hash(3) } }, { geometry: "2" },
    { connections: [sha, sha, sha] }, { removed_connections: [] }, { uv: m.uv_layer_link }, { meshes: 2 },
    { embedded: false }, { texture_sha256: sha }, { imageUrl: "https://untrusted.invalid" }])
    assert.throws(() => parseTexturedArtifact({ ...fixture(), receipt: { ...fixture().receipt,
      material: { ...fixture().receipt.material, manifest: { ...m, ...patch } } } }, op, selection, context), /SKIN_INTEGRITY_ERROR/);
  for (const patch of [{ fbx_sha256: sha }, { fbx_base64: bytes.toString("base64") + "\n" },
    { fbx_base64: Buffer.from("untextured bytes").toString("base64") }, { extra: true }])
    assert.throws(() => parseTexturedArtifact({ ...fixture(), ...patch }, op, selection, context), /SKIN_INTEGRITY_ERROR/);
});

test("current approved 54-bone anatomy retains exact base-rig validation", () => {
  const current = { ...context, asset: { ...context.asset, bones: 54 } };
  const currentOp = { ...op, receipt: { ...op.receipt!, skin: { meshes: 1, bones: 54 } } };
  assert.doesNotThrow(() => parseTexturedArtifact(fixture(), currentOp, selection, current));
  for (const bones of [52, 53, 55])
    assert.throws(() => parseTexturedArtifact(fixture(), { ...currentOp, receipt: { ...currentOp.receipt, skin: { meshes: 1, bones } } }, selection, current), /SKIN_INTEGRITY_ERROR/);
});
