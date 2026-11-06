/** Structural protocol tests use synthetic bytes; actual CSP evidence is recorded separately. */
import test from "node:test";
import assert from "node:assert/strict";
import { OUTLINE_EXPRESSION, OUTLINE_MAPPING, OUTLINE_SUPPORT } from "./support.js";
import { checkContract, outlineBinding, parseOutlinedArtifact, type OutlineContract } from "./contract.js";
import { outlineObjectKey } from "./storage.js";
import { hash, type Operation } from "../interactive-state/model.js";
import { fixtureSelection } from "../interactive-state/fixture.js";
import { sha256Hex } from "../converter/client.js";
import { resolvedStature, createOutlineArtifacts } from "../converter/outline.js";
const sha = "a".repeat(64), bytes = Buffer.from("Kaydara FBX Binary  \0\x1a\0synthetic-proof-only");
const baseSelection = fixtureSelection(hash("selection"));
const selection = { ...baseSelection, characterId: "female-default80-v0-3-9-p1",
  body: { ...baseSelection.body, resolvedBody: { ...baseSelection.body.resolvedBody!,
    characterId: "female-default80-v0-3-9-p1", assetSha256: OUTLINE_SUPPORT["female-default80-v0-3-9-p1"].sha256 } } };
const contract: OutlineContract = { version: "fbx-outline-v1", enabled: true, expression: OUTLINE_EXPRESSION,
  mapping: OUTLINE_MAPPING, acceptance_scope: "posed-fbx-import",
  supported_targets: [{ character_id: selection.characterId, character_sha256: selection.body.resolvedBody.assetSha256,
    output_scope: "full", width: { min: 0, max: 2, min_exclusive: true } }], runtime_revision: sha, csp_certified: true,
  certified_expressions: [OUTLINE_EXPRESSION], supported_characters: [selection.characterId],
  supported_scopes: ["full"], candidate_characters: { [selection.characterId]: selection.body.resolvedBody!.assetSha256 },
  width: { min: 0, max: 2 }, zero: "legacy-byte-preserving" };
const op: Operation = { previewState: "authoritative", exportState: "building", eventSequence: 1,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString(),
  mutationId: "fixture-mutation", requestHash: sha, errorCode: null, snapshotId: "fixture", poster: null,
  installationId: "inst_test", jobId: "job_test", personIndex: 0, operationId: "op_test", revision: 1,
  candidateId: "candidate", selectionHash: selection.selectionHash, stateHash: sha,
  snapshotProof: { identityHash: sha, modelSha256: sha, runtimeRevision: sha },
  appearance: { version: "fbx-outline-v1", width: 2 }, receipt: { artifactSha256: hash("source"), skin: { meshes: 1, bones: 1 } } };
function fixture() {
  return { artifact_contract: "outlined-fbx-v1", fbx_base64: bytes.toString("base64"), fbx_sha256: sha256Hex(bytes),
    receipt: { version: "outlined-fbx-receipt-v1", expression: contract.expression, mapping: contract.mapping,
      runtime_revision: sha, blender_version: "synthetic", source_artifact_sha256: op.receipt!.artifactSha256,
      fbx_sha256: sha256Hex(bytes), appearance: op.appearance!, appearance_sha256: hash(op.appearance),
      binding_sha256: outlineBinding(op, selection, 1.75, contract), character_id: selection.characterId,
      character_sha256: selection.body.resolvedBody!.assetSha256, output_scope: "full", stature_m: 1.75,
      thickness_m: .002625, culling: "CullingOff", base: { typed_fbx_values_preserved: true,
        maxPositionErrorM: 0, maxMatrixError: 0, maxWeightError: 0, maxNormalError: 0 },
      outline: { manifest: { objects: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i + 1), hash(i)])), connections: [sha], culling: "CullingOff", surface: "outward-transparent", meshes: 1 },
        skin_verified: true, displacement_verified: true, max_displacement_error_m: 0, blender_import_backface_culling: [false] }, file_verified: true,
      csp_certified: true, verification_seconds: 0 } };
}
test("only evidence-pinned native v2/model/width tuples pass; claimed v1 certification never enables it", async () => {
  assert.equal(checkContract(contract, selection).expression, OUTLINE_EXPRESSION);
  const rejected = { ...contract, expression: "skinned-inverted-hull-fbx-culling-v1", mapping: "stature-relative-v1-experimental",
    certified_expressions: ["skinned-inverted-hull-fbx-culling-v1"] };
  for (const c of [rejected, { ...contract, enabled: false }, { ...contract, csp_certified: false },
    { ...contract, expression: "invented-expression" }, { ...contract, mapping: "stature-relative-v1-experimental" },
    { ...contract, candidate_characters: {} }])
    assert.throws(() => checkContract(c, selection), /OUTLINE_/);
  assert.throws(() => checkContract({ ...contract, supported_scopes: ["head", "full"] }, { ...selection, scope: "head" }, .65), /OUTLINE_UNSUPPORTED/);
  assert.equal(checkContract(contract, selection, .65).expression, OUTLINE_EXPRESSION);
  assert.throws(() => checkContract({ ...contract, supported_targets: [] }, selection, 1), /OUTLINE_UNSUPPORTED/);
  assert.throws(() => checkContract({ ...contract, supported_targets: [...contract.supported_targets, ...contract.supported_targets] }, selection, 1), /OUTLINE_UNSUPPORTED/);
  const cropContract = { ...contract, supported_scopes: ["head"], supported_targets: [{ ...contract.supported_targets[0], output_scope: "head", width: { min: 2, max: 2, min_exclusive: false } }] };
  assert.equal(checkContract(cropContract, { ...selection, scope: "head" }, 2).expression, OUTLINE_EXPRESSION);
  assert.throws(() => checkContract(cropContract, { ...selection, scope: "head" }, 1), /OUTLINE_UNSUPPORTED/);
  assert.throws(() => checkContract(contract, { ...selection, body: { ...selection.body, resolvedBody: { ...selection.body.resolvedBody, assetSha256: sha } } }), /OUTLINE_UNSUPPORTED/);
  const calls: string[] = [];
  const adapter = createOutlineArtifacts({ enabled: () => true, baseUrl: "http://converter.invalid",
    token: "synthetic-private-service-token-32-characters", stature: () => 1.75,
    fetch: (async input => { calls.push(String(input)); return Response.json(rejected); }) as typeof fetch });
  await assert.rejects(adapter.check(selection), /OUTLINE_NOT_CSP_CERTIFIED/);
  await assert.rejects(adapter.prepare(op, selection, bytes, new AbortController().signal), /OUTLINE_NOT_CSP_CERTIFIED/);
  assert.ok(calls.every(path => path.endsWith("/outline-contract")), "no bake or storage after rejected v1 capability");
});
test("proof parser binds exact bytes/settings and separate immutable body proof, independently of product gate", () => {
  const parsed = parseOutlinedArtifact(fixture(), op, selection, 1.75, contract);
  assert.deepEqual(parsed.bytes, bytes);
  assert.equal(parsed.receipt.artifactSha256, sha256Hex(bytes));
  assert.equal(hash(op.appearance), "4396270491be9d88f58ed0531d9a72fcfd97b065f5be97e987e5a32076cf15ab");
  for (const patch of [{ fbx_sha256: sha }, { source_artifact_sha256: sha }, { binding_sha256: sha },
    { appearance: { version: "fbx-outline-v1", width: 1 } }, { appearance_sha256: sha },
    { character_id: "other" }, { character_sha256: sha }, { output_scope: "head" }, { stature_m: 1.8 },
    { thickness_m: .002 }, { runtime_revision: "b".repeat(64) }, { mapping: "unknown" },
    { file_verified: false }, { csp_certified: false }, { culling: "CullingOnCCW" },
    { base: { ...fixture().receipt.base, typed_fbx_values_preserved: false } },
    { base: { ...fixture().receipt.base, maxWeightError: .00001 } },
    { outline: { ...fixture().receipt.outline, skin_verified: false } },
    { outline: { ...fixture().receipt.outline, displacement_verified: false } },
    { outline: { ...fixture().receipt.outline, max_displacement_error_m: .000002 } },
    { outline: { ...fixture().receipt.outline, manifest: { ...fixture().receipt.outline.manifest, objects: {} } } },
    { extraUnsupported: true }])
    assert.throws(() => parseOutlinedArtifact({ ...fixture(), receipt: { ...fixture().receipt, ...patch } }, op, selection, 1.75, contract), /OUTLINE_INTEGRITY_ERROR/);
  for (const patched of [{ ...fixture(), fbx_base64: bytes.subarray(1).toString("base64") },
    { ...fixture(), fbx_base64: bytes.toString("base64") + "\n" }, { ...fixture(), fbx_sha256: sha }])
    assert.throws(() => parseOutlinedArtifact(patched, op, selection, 1.75, contract), /OUTLINE_INTEGRITY_ERROR/);
  for (const changed of [{ ...op, personIndex: 1 }, { ...op, installationId: "other" }, { ...op, jobId: "job_other" },
    { ...op, revision: 2 }, { ...op, stateHash: hash("other") }, { ...op, selectionHash: hash("new hands/refine/shape") }])
    assert.throws(() => parseOutlinedArtifact(fixture(), changed, selection, 1.75, contract), /OUTLINE_INTEGRITY_ERROR/);
});
test("owned cache identity separates people/installations and rejects paths; stature is pinned to approved source bytes", () => {
  const binding = outlineBinding(op, selection, 1.75, contract);
  assert.notEqual(outlineObjectKey(op, binding), outlineObjectKey({ ...op, personIndex: 1 }, binding));
  assert.notEqual(outlineObjectKey(op, binding), outlineObjectKey({ ...op, installationId: "other" }, binding));
  assert.throws(() => outlineObjectKey({ ...op, installationId: "../other" }, binding));
  assert.throws(() => outlineObjectKey(op, "../invalid"));
  for (const digest of ["809a131510434089888429605bf7cd2e3bc75b63109e4ac5c9734b211ee52365", "e6947d8e2aeb1014e9505a61d2f42e6bd9d34965cc7bb3a6c2fcd2722d4f280a"])
    assert.equal(resolvedStature({ ...selection, scope: "head", body: { ...selection.body, resolvedBody: { ...selection.body.resolvedBody!, assetSha256: digest } } }), 1.75);
  assert.equal(resolvedStature(selection), 1.75);
  assert.equal(resolvedStature({ ...selection, characterId: "male-default83-v0-7-6-p1", body: { ...selection.body, resolvedBody: { ...selection.body.resolvedBody, assetSha256: OUTLINE_SUPPORT["male-default83-v0-7-6-p1"].sha256 } } }), 1.78);
  assert.throws(() => resolvedStature(baseSelection), /OUTLINE_UNSUPPORTED/);
});
test("outline transport bounds streams/length and never requests disabled transport", async () => {
  let calls = 0;
  const deps = { baseUrl: "http://converter.invalid", token: "synthetic-private-service-token-32-characters",
    fetch: (async () => { calls++; return Response.json(contract); }) as typeof fetch };
  await assert.rejects(createOutlineArtifacts({ ...deps, enabled: () => false }).check(selection), /OUTLINE_DISABLED/);
  assert.equal(calls, 0);
  await assert.rejects(createOutlineArtifacts({ ...deps, enabled: () => true,
    fetch: (async () => new Response("{}", { headers: { "Content-Length": "99" } })) as typeof fetch }).check(selection), /OUTLINE_INTEGRITY_ERROR/);
  let pulls = 0;
  await assert.rejects(createOutlineArtifacts({ ...deps, enabled: () => true,
    fetch: (async () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(8192)); } }))) as typeof fetch }).check(selection), /OUTLINE_INTEGRITY_ERROR/);
  assert.ok(pulls < 6);
});


test("real outline adapter validates multipart, reuses owned cache and rejects corruption/runtime changes", async () => {
  const stored = new Map<string, unknown>(); let exports = 0, currentRuntime = sha;
  const adapter = createOutlineArtifacts({ enabled: () => true, baseUrl: "http://converter.invalid",
    token: "synthetic-private-service-token-32-characters", stature: () => 1.75,
    storage: { load: async (o, key) => stored.get(outlineObjectKey(o, key)) ?? null,
      publish: async (o, key, raw) => { stored.set(outlineObjectKey(o, key), raw); return raw; } },
    fetch: (async (input, init) => {
      if (String(input).endsWith("/outline-contract")) return Response.json({ ...contract, runtime_revision: currentRuntime });
      exports++; const body = init!.body as FormData;
      assert.equal(body.get("appearance"), JSON.stringify(op.appearance));
      assert.equal(body.get("binding_sha256"), outlineBinding(op, selection, 1.75, contract));
      assert.equal(body.get("stature_m"), "1.75");
      return Response.json(fixture());
    }) as typeof fetch });
  const source = Buffer.from("Kaydara FBX Binary  \0\x1a\0synthetic-source");
  const localOp = { ...op, receipt: { ...op.receipt, artifactSha256: sha256Hex(source) } };
  // Response fixtures must bind the actual source hash used by this request.
  const originalSource = op.receipt!.artifactSha256;
  op.receipt!.artifactSha256 = localOp.receipt.artifactSha256;
  try {
    const receipt = await adapter.prepare(op, selection, source, new AbortController().signal);
    const ready = { ...op, outlineReceipt: receipt };
    assert.deepEqual(await adapter.file(ready, selection), bytes);
    await adapter.prepare(op, selection, source, new AbortController().signal);
    assert.equal(exports, 1);
    const key = [...stored.keys()][0]!;
    stored.set(key, { ...fixture(), fbx_sha256: sha });
    await assert.rejects(adapter.file(ready, selection), /OUTLINE_INTEGRITY_ERROR/);
    currentRuntime = "b".repeat(64);
    await assert.rejects(adapter.file(ready, selection), /OUTLINE_BINDING_MISMATCH/);
  } finally { op.receipt!.artifactSha256 = originalSource; }
});

test("skin cache namespace cannot collide with outline or other owner/person bindings", async () => {
  const { skinObjectKey } = await import("./storage.js");
  const binding = hash("approved material identity");
  assert.notEqual(skinObjectKey(op, binding), outlineObjectKey(op, binding));
  assert.notEqual(skinObjectKey(op, binding), skinObjectKey({ ...op, personIndex: 1 }, binding));
  assert.notEqual(skinObjectKey(op, binding), skinObjectKey({ ...op, installationId: "other" }, binding));
  assert.throws(() => skinObjectKey({ ...op, jobId: "../other" }, binding), /SKIN_BINDING_MISMATCH/);
  assert.throws(() => skinObjectKey(op, "../manifest"), /SKIN_BINDING_MISMATCH/);
});
