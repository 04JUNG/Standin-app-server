# Individual FBX appearance contract (2026-11-06)

The BFF accepts the **native v2** representation for pre-posed individual FBX export → automatic CSP import within the exact current-model matrix below. Current male/female default FBXs imported in CSP 5.1.1 with the pose/grey body and black contours retained. Exact-final male horizontal orbit and male foot-tap/female crouch imports are observed. The previous opaque inverted-hull v1 failure remains a regression rejection; it is not the current v2 result.

The user clarified that `.clip` saving and CSP-internal joint remapping/editing are outside this product's current scope. Neither is a present acceptance blocker. This change does not deploy, merge, or enable a global flag. Fine dotted calf/knee/shin occlusion lines remain visible in some views; there is no arbitrary-angle artifact-free, exact pixel-width, Basic/Realistic-mode or other-viewer guarantee. CSP native-outline renderer dependence is explicit.

## Accepted target matrix

Expression `skinned-outward-transparent-native-outline-v2`; mapping `csp-native-scope-stature-v2-experimental`; FBX culling `CullingOff`; guide manifest `surface:"outward-transparent"`.

| Current approved character | Exact asset SHA256 | Plain full stature |
| --- | --- | --- |
| male-default83-v0-7-6-p1 | 085dd9c65a3a66035f7e0ce9e0a9171b9abb0e33dada92194676d92e00c8b026 | 1.78m |
| female-default80-v0-3-9-p1 | 712ac75e58efd4d6ccded0b1e931590900015de023327f1320cf6d7d94026ffc | 1.75m |

For both exact assets, full supports **continuous 0 < width ≤ 2**, including .65; cropped half/bust/shoulder_head/head support **exact width2**. Zero retains the original path and bytes. No rounding, snapping or fallback to another width/body/format occurs. Other cropped widths, preserved baseline assets, personal models, scene FBX and VRM ZIP are unsupported for nonzero.

BFF independently pins expression/mapping/character SHA/scope/width in code. It also requires the live Converter to report enabled, certified expression, matching runtime/character summaries, `acceptance_scope:"posed-fbx-import"`, and exactly one matching `supported_targets` row:

```text
{character_id, character_sha256, output_scope,
 width:{min,max,min_exclusive}}
```

Summary model/scope lists alone are not support: the requested width must satisfy the exact target interval and the independent BFF matrix. Full interpolation is based on the versioned linear mapping, actual CSP .5/1/2 samples, additional .65 HTTP-output CSP observations and independent file checks; it does not claim every slider value was separately photographed.

## Public operation contract

The installation-authenticated routes retain owned completed job, confirmed candidate, release/quarantine, source/refine lineage, body/shape/hands/scope/runtime, expiry, latest revision and worker lease checks. No inference endpoint changes or additional analysis calls are involved.

Prepare accepts strict optional `appearance:{version:"fbx-outline-v1",width:0..2}`. Values must be finite numbers, exact version, no color/alpha/path/extra fields. Width is logical UI width, not millimetres or a constant-pixel promise. Missing appearance and width0 normalize to omission before request/selection hashing, preserving the legacy operation identity and no-postprocess path.

Nonzero support preflight occurs before replacing a prior good operation. Appearance is immutable on the per-person operation and hashed with the complete current server selection. Changed appearance needs a new revision/mutation under existing compare-and-swap rules. Identical mutation/request replays and repeated exports reuse the current result.

Owned head recovery preserves `appearanceExport:{version:"fbx-outline-v1",available:boolean}`. Optional URL-encoded appearance JSON matches only that head and evaluates support for that desired width. Without appearance, availability means this target has at least one accepted nonzero width; it does not widen cropped-width support. `currentRevision/currentStateHash` still recover the monotonic head even if there is no matching operation. No new fields break the client's strict capability parser.

Export accepts old bodyless requests or strict `{revision,stateHash}`. Unknown fields/appearance overrides on export/file URLs are rejected, never silently dropped. Stale expected snapshots return409. The ready public envelope remains `interactive-fbx-receipt-v1`; nonzero adds appearance and normalized outline proof:

```text
outline = {artifactSha256,artifactBytes,bindingSha256,appearance,
 sourceArtifactSha256,runtimeRevision,expression,mapping,
 proof:<strict outlined-fbx-receipt-v1>}
```

Top-level artifact SHA/length and file headers describe the final outlined bytes; the base packet/model/runtime proof remains separate. A ready URL requires both proofs. Nonzero file headers use `outlined-fbx-v1`; zero preserves the old header. HTTP delivery does not claim native persistence or a CSP save event. Legacy framed/export (including BVH) and scene/person requests refuse nonzero appearance rather than silently emit an unoutlined file; valid zero preserves their behavior.

## Private verification and storage

`OUTLINE_EXPORT_ENABLED=false` remains the BFF default. Interactive availability, private storage, service credential and exact live capability are also required. Local test adapters use explicitly isolated opt-in settings, not a production activation.

Existing base packet/receipt and independently hashed FBX are verified before multipart `/outline-fbx`. BFF authors the binding from installation/job/person, operation/revision/candidate, selection/state/snapshot proof, source FBX SHA, appearance, character bytes, scope, stature, acceptance scope and expression/mapping/runtime. The token is the existing private interactive bearer token, never a URL/public response/log value.

Stature comes from server-resolved approved centimetre controls/defaults, or exact manifest SHA-pinned plain stature. It is never inferred from posed/cropped bounds. v2 physical guide distance is width/2 × full stature ×0.0015 × scope factor (full1, half.60, bust.35, shoulder_head.27, head.15). Only the independently allowed target/width is accepted. Base geometry/material/UV/morph/bone/skin identity, bounded exact additional-object fingerprints and original tolerances remain mandatory. Independent imported displacement error must be ≤1e-6m. The v2 transparent guide is separate; the original body is not made transparent.

Private immutable response objects live under installation/job/person/binding keys. Downloads recheck live capability/runtime/target, original Converter snapshot expiry/base bytes, complete stored proof and final SHA/length/signature, then revalidate SQL ownership/current selection/revision. Late responses and cancellation cannot publish the current ready pointer. Storage without a fenced ready SQL pointer grants no download authority.

The real selection resolver now hashes only installationId/jobId/personIndex for ownerBinding. Revalidation passes an Operation containing additional metadata; those fields must not silently alter ownership identity. Regression tests enforce both operation stability and different owner/job separation.

## Evidence and reproducibility

Actual CSP canvas-only photos and exact input hashes are in the converter companion [QA evidence](https://github.com/04JUNG/Standin-server/tree/1d743e901c90a0f95b56e575d4bc58f7992d23c0/docs/qa/outline-fbx-csp-20261106). These show automatic import of final posed FBX, not joint editing inside CSP. Raw private UI/screens/models/tokens are not committed here.

![Actual CSP posed FBX controls and v2 outlines](https://raw.githubusercontent.com/04JUNG/Standin-server/1d743e901c90a0f95b56e575d4bc58f7992d23c0/docs/qa/outline-fbx-csp-20261106/csp-posed.png)

- Run `npm run typecheck`, `npm test`, and existing workflow policy tests. Synthetic protocol/SQL tests cover exact support matrix/.65, forged v1 certification, wrong target/width/runtime/proof, cache corruption/reuse, cancellation, stale selection and late replies. They are not actual CSP evidence.
- Real BFF postprocess adapter → live private Converter HTTP → fresh Blender exporter/verifier → actual final bytes/normalized receipt/SHA → immutable cache read/reuse passed for male/female full.65, male foot-tap2, female crouch2 and male head2. These exact output hashes match the corresponding CSP-tested files. It uses controlled recorded-source operation metadata and memory storage; it does not claim a complete base BVH/SQL/native transaction.
- The full actual Hono/PGlite/production-selection-resolver/base-worker run exposed the ownerBinding defect (fixed here) and a current-default plain-import incompatibility (`missing_required:[head]`). Converter companion commit `70b8a6f37d748d5a81801e0c1d632f7c512ba517` fixes that using the existing full importer for only the exact two current model ID/SHA pairs, preserving frozen solver/gates and restoring the importer. Fresh metadata and actual BVH states were acquired; no previous runtime/receipt was relabelled.
- Actual TCP Hono → real installation middleware and production selection resolver → owned PGlite operation/confirmation/body SQL → fresh base BVH solve/packet/export → live native-v2 postprocess → strict final receipt/SHA download passed at full.65. The committed [HTTP evidence](qa/outline-fbx-csp-20261106/bff-http.json) separates controlled authentication/storage drivers from real computation. Further late-response/width/zero outcomes are in the shared local run record.
- Zero means the current original base file is delivered without outline work, and repeated identical requests retain the same operation/artifact. Across a newly created operation, the legacy FBX exporter can regenerate timestamps/FileId: those unrelated metadata bytes need not match an earlier operation. The zero restoration check compares exact current base bytes, identical canonical body-model digest, and no outline request.

Shared bff-status.md records exact harness/receipt/file paths, current head/CI and outcomes. PGlite substitutes advisory-lock execution and test drivers supply installation authentication/source data/private memory storage. Production PostgreSQL locks, S3 replicas, arbitrary CSP modes/views, app native saving and broader formats are separate proof categories. No production/staging deployment, merge, global activation, paid inference or unsupported `.clip` requirement is added.
