/** Real parser/adapter with synthetic bytes and injected policy, not CSP certification. */
import test from "node:test";
import assert from "node:assert/strict";
import { context as seed, op as seedOp, selection, fixture, bytes } from "./skin-fixture.js";
import { hash } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { SKIN_EXPRESSION, skinBinding } from "./skin-proof.js";
import { checkSkinContract, type SkinPolicy } from "./skin-contract.js";
import { createSkinArtifacts } from "../converter/skin.js";
import { skinObjectKey } from "./storage.js";
const a = seed.asset;
const policy: SkinPolicy = { assetManifestSha256: seed.assetManifestSha256, assetVersion: seed.assetVersion,
  models: { [selection.characterId]: a }, certifiedTargets: [{ characterId: selection.characterId, characterSha256: a.characterSha256,
    scope: "full", skinId: "flesh", minOutlineWidth: 0, maxOutlineWidth: 2 }] };
const contract = { version: "fbx-skin-v1", expression: SKIN_EXPRESSION, enabled: true, assets_available: true,
  csp_certified: true, acceptance_scope: "posed-fbx-import", runtime_revision: seed.runtimeRevision,
  asset_manifest_sha256: seed.assetManifestSha256, asset_version: seed.assetVersion, skins: ["default", "flesh"],
  supported_targets: [{ character_id: selection.characterId, character_sha256: a.characterSha256, output_scope: "full", skin_ids: ["flesh"] }],
  candidate_models: { [selection.characterId]: { character_sha256: a.characterSha256, vertices: a.vertices, bones: a.bones,
    polygon_indices_sha256: a.polygonIndicesSha256, weights_sha256: a.weightsSha256, preview_mesh: a.previewMesh, triangles_sha256: a.trianglesSha256, preview_resolution: 2048 } },
  assets: [{ character_id: selection.characterId, kind: "preview-texture", skin_id: "flesh", sha256: a.previewTextures.flesh!.sha256, bytes: a.previewTextures.flesh!.bytes, url: `/skin-assets/${a.previewTextures.flesh!.sha256}` }, { character_id: selection.characterId, kind: "uv", skin_id: null, sha256: a.uvSha256, bytes: a.uvBytes, url: `/skin-assets/${a.uvSha256}` },
    { character_id: selection.characterId, kind: "texture", skin_id: "flesh", sha256: a.textures.flesh!.sha256, bytes: a.textures.flesh!.bytes, url: `/skin-assets/${a.textures.flesh!.sha256}` }],
  zero: "default-legacy-byte-preserving", order: ["skin", "outline"] };
test("live booleans never override independent exact model/UV/asset/composition pins", () => {
  const result = checkSkinContract(contract, selection, seed.skin, undefined, policy);
  assert.deepEqual(result.approval.supportedIds, ["default", "flesh"]);
  assert.throws(() => checkSkinContract(contract, selection, seed.skin, undefined, { ...policy, certifiedTargets: [] }), /SKIN_UNSUPPORTED/);
  assert.throws(() => checkSkinContract(contract, selection, seed.skin, { version: "fbx-outline-v1", width: .65 },
    { ...policy, certifiedTargets: [{ ...policy.certifiedTargets[0], minOutlineWidth: 0, maxOutlineWidth: 0 }] }), /SKIN_UNSUPPORTED/);
  assert.throws(() => checkSkinContract(contract, { ...selection, scope: "head" }, seed.skin, undefined, policy), /SKIN_UNSUPPORTED/);
  for (const patch of [{ enabled: false }, { assets_available: false }, { csp_certified: false }, { expression: "invented" },
    { asset_manifest_sha256: hash("replacement") }, { asset_version: "other" }, { supported_targets: [] },
    { supported_targets: [...contract.supported_targets, ...contract.supported_targets] },
    { candidate_models: {} }, { assets: contract.assets.slice(1) },
    { assets: [...contract.assets, contract.assets[0]] },
    { assets: contract.assets.map(t => ({ ...t, url: "https://untrusted.invalid/asset" })) },
    { assets: contract.assets.map(t => ({ ...t, sha256: hash("replacement") })) }])
    assert.throws(() => checkSkinContract({ ...contract, ...patch }, selection, seed.skin, undefined, policy), /SKIN_/);
});
test("skin transport strictly binds multipart, verifies immutable cache and fences changed contract/receipt", async () => {
  const source = Buffer.from("Kaydara FBX Binary  \0\x1a\0synthetic-original"), op = { ...seedOp,
    receipt: { ...seedOp.receipt, artifactSha256: sha256Hex(source) } };
  const stored = new Map<string, unknown>(); let posts = 0, current = structuredClone(contract);
  const adapter = createSkinArtifacts({ enabled: () => true, baseUrl: "http://synthetic.invalid", token: "synthetic-service-token-at-least-32-characters", policy,
    storage: { load: async (o, b) => stored.get(skinObjectKey(o, b)) ?? null,
      publish: async (o, b, raw) => { const key = skinObjectKey(o, b); if (!stored.has(key)) stored.set(key, raw); return stored.get(key); } },
    fetch: (async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-service-token-at-least-32-characters");
      if (String(url).endsWith("/skin-contract")) return Response.json(current);
      posts++;
      const form = init!.body as FormData;
      assert.equal(form.get("skin"), JSON.stringify(op.skin)); assert.equal(form.get("source_artifact_sha256"), sha256Hex(source));
      assert.equal(form.get("character_id"), selection.characterId); assert.equal(form.get("output_scope"), "full");
      assert.deepEqual(Buffer.from(await (form.get("fbx") as Blob).arrayBuffer()), source);
      const approved = checkSkinContract(current, selection, op.skin, op.appearance, policy);
      assert.equal(form.get("binding_sha256"), skinBinding(op, selection, approved.context));
      const raw = fixture(); return Response.json({ ...raw, receipt: { ...raw.receipt,
        source_artifact_sha256: sha256Hex(source), binding_sha256: skinBinding(op, selection, approved.context) } });
    }) as typeof fetch });
  await adapter.check(selection, op.skin);
  const proof = await adapter.prepare(op, selection, source, new AbortController().signal), ready = { ...op, skinReceipt: proof };
  assert.deepEqual(await adapter.file(ready, selection), bytes);
  await adapter.prepare(op, selection, source, new AbortController().signal); assert.equal(posts, 1);
  const key = [...stored.keys()][0], original = stored.get(key);
  stored.set(key, { ...(original as Record<string, unknown>), fbx_sha256: hash("bad bytes") });
  await assert.rejects(adapter.file(ready, selection), /SKIN_INTEGRITY_ERROR/); stored.set(key, original);
  await assert.rejects(adapter.file({ ...ready, skinReceipt: { ...proof, assetVersion: "forged" } }, selection), /SKIN_INTEGRITY_ERROR/);
  current = { ...contract, runtime_revision: hash("new runtime") };
  await assert.rejects(adapter.file(ready, selection), /SKIN_BINDING_MISMATCH/);
  current = { ...contract, supported_targets: [] };
  await assert.rejects(adapter.file(ready, selection), /SKIN_UNSUPPORTED/);
});
test("skin HTTP stream/body bounds and disabled transport fail before file preparation", async () => {
  let calls = 0;
  const deps = { policy, baseUrl: "http://synthetic.invalid", token: "synthetic-service-token-at-least-32-characters",
    fetch: (async () => { calls++; return Response.json(contract); }) as typeof fetch };
  await assert.rejects(createSkinArtifacts({ ...deps, enabled: () => false }).check(selection, seed.skin), /SKIN_DISABLED/);
  assert.equal(calls, 0);
  await assert.rejects(createSkinArtifacts({ ...deps, enabled: () => true,
    fetch: (async () => new Response("{}", { headers: { "Content-Length": "99" } })) as typeof fetch }).check(selection, seed.skin), /SKIN_INTEGRITY_ERROR/);
  let pulls = 0;
  await assert.rejects(createSkinArtifacts({ ...deps, enabled: () => true,
    fetch: (async () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(16384)); } }))) as typeof fetch }).check(selection, seed.skin), /SKIN_INTEGRITY_ERROR/);
  assert.ok(pulls <= 10);
});
