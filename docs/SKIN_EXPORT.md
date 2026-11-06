# Final individual FBX skins

The optional `skin` choice is separate from the unchanged strict `appearance:{version:"fbx-outline-v1",width}`. Requests accept only:

```json
{"version":"fbx-skin-v1","id":"flesh-guide"}
```

IDs are `default`, `gray-guide`, `flesh`, `flesh-guide`, `muscle`. Unknown IDs, versions, properties, image URLs and filesystem paths are rejected. Omitted/default skin normalizes away **before** mutation/request and selection hashing. Omitted/zero outline plus default skin preserves the original operation identity and unmodified base download path. Outline-only clients retain their existing identity/proof format.

The existing installation-authenticated interactive prepare and owned head accept `skin` (URL-encoded JSON for head). Head adds `skinExport:{version:"fbx-skin-v1",available:boolean,supportedIds:string[]}`. An unavailable capability returns default-only IDs; it never grants a nondefault prepare. Per-operation export/file URLs cannot override skin, appearance or outline settings. Legacy individual BVH/FBX, scenes and other unproved save formats explicitly refuse nondefault skins. Default is accepted without changing their original file behavior.

Nondefault selection identity includes the full original server source/pose/body/shape/hands/refine/scope selection, optional nonzero outline, skin ID and the approved asset identity digest. That digest binds immutable asset version/manifest, exact character SHA, neutral UV/texture/topology compatibility, runtime and certified target. The same asset identity is resolved again during operation/model/export/file revalidation. Changes or revocation prevent stale delivery; skin never changes the frozen canonical model or solver tolerances.

Files are prepared in this order: independently verified base FBX → skin materials/UV/embedded texture → optional native v2 outline. Skin cannot recolor the outline guide because it runs first. The base `Operation.receipt` and packet/snapshot proof are retained. `skinReceipt` is a separate normalized proof; the public operation includes `skin` and `exportReceipt.skinProof`. For combined exports the existing `exportReceipt.outline` remains separate. The base SHA must equal skin source SHA and skin final SHA must equal outline source SHA. The public top-level artifact SHA/byte count and HTTP SHA header always identify the final file. Header contract is `textured-fbx-v1` for skin-only, `outlined-fbx-v1` for combined, and unchanged `interactive-fbx-receipt-v1` for default/zero.

Current SQL head/revision/lease and selection checks fence every asynchronous stage, including between skin and outline. A superseded/cancelled/late result cannot publish ready or return download bytes. The download path revalidates the original Converter handle and base bytes, private cached material proof/file and optional outline proof/file, then checks current SQL selection again. Corrupt cache, changed manifest/runtime, cross-person/installation access, confirmation withdrawal and missing source remain failures. No fallback to default skin is reported as a successful requested skin.

`SKIN_EXPORT_ENABLED=false` is the default. Interactive transport, private storage/token, actual immutable assets and exact certified target checks must also pass. No deployment, global activation or merge is part of this change. New PR is stacked on unmerged outline BFF #161 head54f14a1; retarget to develop only after that dependency merges.

## Implementation and validation status

State/receipt sequencing and controlled Hono/SQL tests are implemented. Converter material/UV manifest and exact schema/pins are being finalized in the companion skin branch. Real final-file HTTP/CSP acceptance is not yet recorded. Synthetic tests do not certify textures, UVs, geometry preservation, embedded transport, CSP appearance, production PostgreSQL/S3 or native disk persistence.

Candidate support starts with the current #168 male/female default full individual FBX. Cropped/interpolated cap UV lineage is unproved and must not be guessed by nearest positions. Previous/personal models, scenes and VRM are unsupported until explicit independent proof. Actual support must be narrowed to the approved manifest and measured CSP matrix. `.clip` and CSP-internal posing are outside this product save scope.
