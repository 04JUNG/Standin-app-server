# Individual FBX appearance contract (2026-11-05)

This companion change prepares the BFF boundary for final FBX appearance. **Nonzero output is unavailable.** Actual CSP 5.1.1 automatic-import probes rejected `skinned-inverted-hull-fbx-culling-v1`: the hull became a black surface. No environment flag, upstream certification boolean or successful Blender file proof can enable this rejected expression. A separately reviewed representation/version with actual automatic CSP import, deformation and save/reopen evidence is required. The separate unregistered CSP license also blocks `.clip` save/reopen. These changes are not a completed CSP feature or a deployment.

## Public API

The installation-authenticated interactive-state routes retain their owned completed job, confirmed candidate, release/quarantine, source/refine lineage, body/shape/hands/scope/runtime, expiry, latest revision and worker lease checks. No inference endpoint changes or extra analysis calls are involved.

Optional prepare field:

```json
{"appearance":{"version":"fbx-outline-v1","width":1}}
```

The field is strict: finite JSON number 0..2, exact version, no color/alpha/path/extra fields. It is logical UI width, not millimetres or a guarantee of identical screen pixels. Missing appearance and width=0 normalize to omission before request/selection hashing. The existing operation, packet, base receipt and file bytes are preserved for zero; no postprocess or added geometry is requested.

Nonzero prepare first verifies support before replacing the last successful operation. It persists appearance on the immutable operation and hashes it together with the complete current server selection. Each changed appearance needs a new revision/mutation under the existing compare-and-swap rules. Identical mutation/request replays and repeated exports reuse the same operation/result. Appearance cannot be changed on an export/file URL or appended to the export body.

Owned head recovery adds:

```json
{"appearanceExport":{"version":"fbx-outline-v1","available":false}}
```

`GET .../interactive-state?candidateId=...&appearance=<URL-encoded JSON>` recovers only a matching appearance head. With omission/zero it recovers only the legacy zero head. `currentRevision/currentStateHash` still expose the monotonic head for a new compare-and-swap even if no matching operation exists. `available` is false for disabled/unavailable/uncertified/unsupported capabilities; candidate SHA dictionaries alone never mean support.

`POST .../{operationId}/export` preserves old bodyless requests and validates current-client `{revision,stateHash}` bodies. Unknown fields or appearance overrides return 400; stale expected snapshots return 409.

If a future accepted representation is implemented, the ready public receipt retains its original `interactive-fbx-receipt-v1` envelope and adds `appearance` plus `outline`:

```text
outline = {
  artifactSha256, artifactBytes, bindingSha256, appearance,
  sourceArtifactSha256, runtimeRevision, expression, mapping,
  proof: <strict outlined-fbx-receipt-v1 Converter proof>
}
```

Top-level `artifactSha256/artifactBytes` and the file response SHA describe the final bytes, while the base packet/model/runtime proof remains separate and unchanged. Nonzero file headers use `X-Standin-Artifact-Contract: outlined-fbx-v1`. Zero keeps the original header and receipt. A ready file URL requires both base and final proofs. HTTP delivery never claims native persistence or CSP save success.

Legacy `/framed`, `/export` (including BVH), scene and scene-person requests reject nonzero appearance instead of returning an unoutlined file. Malformed/unknown appearance fields return 400. Zero on these existing paths retains their behavior. Personal model Draft and CSP-native VRM ZIP capabilities are not enabled by this change.

## Private Converter and storage

`OUTLINE_EXPORT_ENABLED=false` is the BFF default. Interactive availability, private storage, the service credential and the exact Converter `/outline-contract` are also required. The current expression is explicitly denied in BFF code even if all flags and upstream certification booleans are true.

The existing base packet/receipt and independently hashed FBX are verified first. Only then may `/outline-fbx` receive multipart `fbx`, `source_artifact_sha256`, strict `appearance`, `output_scope`, `character_id`, `character_sha256`, `binding_sha256`, and `stature_m`. The credential uses the existing private interactive bearer token, never a URL/public response/log.

The BFF binding includes installation/job/person, operation/revision/candidate, selection and canonical state hashes, snapshot proof, source artifact SHA, appearance, character bytes, scope, physical stature, expression/mapping and runtime. Height comes from the server-resolved approved `body-shape.v1` centimetre control/default. The only fixed-source stature fallback is 1.75m for the two exact SHA values published in the Converter contract; model names, camera distance and posed/cropped bounds do not determine height. Unknown source metadata fails closed.

Successful postprocess responses require the exact published version, source/final/settings/binding/character/scope/stature/runtime hashes, independent file/skin/physical displacement checks (at most 1e-6m imported displacement error), unchanged typed base FBX values, bounded manifest and original body tolerances, and actual CSP certification. Candidate CLI proofs with `csp_certified=false` are refused. Byte signature, canonical base64, length and SHA are independently checked. Snapshot mesh validation is not widened to permit arbitrary additional meshes.

Verified response bytes/proof use immutable private keys under `installations/{installation}/jobs/{job}/interactive-outline/{person}/{binding}.json`, within existing owned-job retention. Cache publication uses first-writer-wins. Downloads preserve the base Converter snapshot/expiry/file fence and revalidate capability/runtime, binding, complete stored proof and exact bytes, then recheck SQL ownership/current selection/revision after reading. Expired/missing artifacts revoke readiness; cancellation or late workers cannot publish the current ready pointer. Storage publication without a SQL ready pointer grants no download authority.

## Validation and limits

- `npm run typecheck`, `npm run build`, `npm test` and `npm run test:interactive`.
- SQL/Hono operation tests use PGlite and controlled synthetic Converter/postprocess fixtures. They cover width tampering, zero identity, repeated saves, late responses, cancel, changed body/hands/refine/source and download races. PGlite skips PostgreSQL advisory-lock implementation, not the operation SQL.
- Proof tests use synthetic binary-signature bytes and a structurally valid hypothetical proof to test binding rejection. Their parser success is not representation acceptance; the production capability gate rejects that expression even with a claimed certificate.
- Live local test: actual TCP HTTP → Hono/PGlite → current private Converter/Blender → independent export/import → exact downloaded FBX. Source/selection/edge authentication were controlled fixtures using an existing allowed BVH. This did not test production installation auth, PostgreSQL advisory locking, S3 replicas or native disk/CSP persistence.
- One local zero sample: 1,822,556 bytes, SHA256 `ebd6ffee2136c8078e1afc3abfcefa31e5310e5e36320520c90201e89cb10188`; solve 7.74s, verified export plus HTTP download 8.49s; base position/matrix/normal/weight error maxima all zero. No production performance claim.
- Width .5/1/2 on the live uncertified contract returned 503 before replacing the prior zero operation; old zero bytes remained identical and no outlined cache object was published. Actual cancellation denied bytes. Private postprocess missing credential returned 401; authenticated unsupported source returned 422.

Local launch/reproduction harnesses and sanitized evidence are recorded in the shared `bff-status.md`. No private model/BVH/packet/token is committed. CSP screenshots and actual UI evidence belong to the client/CSP companion work. No nonzero product file, production/staging deployment, global activation, merge or paid analysis is claimed.
