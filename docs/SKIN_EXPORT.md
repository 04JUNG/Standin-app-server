# Final individual FBX skins

The optional `skin` choice is separate from the unchanged strict `appearance:{version:"fbx-outline-v1",width}`. Requests accept only:

```json
{"version":"fbx-skin-v1","id":"flesh-guide"}
```

IDs are `default`, `gray-guide`, `flesh`, `flesh-guide`, `muscle`. Unknown IDs, versions, properties, image URLs and filesystem paths are rejected. Omitted/default skin normalizes away **before** mutation/request and selection hashing. Omitted/zero outline plus default skin preserves the original operation identity and unmodified base download path. Outline-only clients retain their existing identity/proof format.

The existing installation-authenticated interactive prepare and owned head accept `skin` (URL-encoded JSON for head). Head adds `skinExport:{version:"fbx-skin-v1",available:boolean,supportedIds:string[]}`. An unavailable capability returns default-only IDs; it never grants a nondefault prepare. When `available` is false, head also returns a sibling `skinUnavailable:{code,outputScope?}` (2026-11-13). `skinExport` keeps exactly its three keys because clients up to 2.10.4 parse it strictly; those clients ignore the sibling. `code` is one of `SKIN_UNSUPPORTED`, `SKIN_UV_INCOMPATIBLE`, `SKIN_DISABLED`, `SKIN_NOT_CSP_CERTIFIED`, `SKIN_ASSETS_UNAVAILABLE`, `SKIN_UNAVAILABLE` or `SKIN_INTEGRITY_ERROR`; any other failure (transport reset, abort) reads as `SKIN_UNAVAILABLE`. A person whose resolved output scope is not `full` gets `{code:"SKIN_UNSUPPORTED",outputScope:"half"|"bust"|"shoulder_head"|"head"}` without a Converter call: the Converter crops those meshes (`framing.py::crop_meshes`), so they never match the pinned full-mesh UV. Clients use `outputScope` to offer the default skin instead of a retry that cannot succeed. Per-operation export/file URLs cannot override skin, appearance or outline settings. Legacy individual BVH/FBX, scenes and other unproved save formats explicitly refuse nondefault skins. Default is accepted without changing their original file behavior.

Nondefault selection identity includes the full original server source/pose/body/shape/hands/refine/scope selection, optional nonzero outline, skin ID and the approved asset identity digest. That digest binds immutable asset version/manifest, exact character SHA, neutral UV/texture/topology compatibility, runtime and certified target. The same asset identity is resolved again during operation/model/export/file revalidation. Changes or revocation prevent stale delivery; skin never changes the frozen canonical model or solver tolerances.

Files are prepared in this order: independently verified base FBX → skin materials/UV/embedded texture → optional native v2 outline. Skin cannot recolor the outline guide because it runs first. The base `Operation.receipt` and packet/snapshot proof are retained. `skinReceipt` is a separate normalized proof; the public operation includes `skin` and `exportReceipt.skinProof`. For combined exports the existing `exportReceipt.outline` remains separate. The base SHA must equal skin source SHA and skin final SHA must equal outline source SHA. The public top-level artifact SHA/byte count and HTTP SHA header always identify the final file. Header contract is `textured-fbx-v1` for skin-only, `outlined-fbx-v1` for combined, and unchanged `interactive-fbx-receipt-v1` for default/zero.

Current SQL head/revision/lease and selection checks fence every asynchronous stage, including between skin and outline. A superseded/cancelled/late result cannot publish ready or return download bytes. The download path revalidates the original Converter handle and base bytes, private cached material proof/file and optional outline proof/file, then checks current SQL selection again. Corrupt cache, changed manifest/runtime, cross-person/installation access, confirmation withdrawal and missing source remain failures. No fallback to default skin is reported as a successful requested skin.

`SKIN_EXPORT_ENABLED=false` is the default. Interactive transport, private storage/token, actual immutable assets and exact certified target checks must also pass. No deployment, global activation or merge is part of this change. New PR is stacked on unmerged outline BFF #161 head54f14a1; retarget to develop only after that dependency merges.

## Approved support and verification

Immutable manifest `1fb0fa382d4fa7d27233b6139cba9c5f1ec575c6b8f86b7deac2a3dc4d447386`, asset version `current-neutral-uv-20261106-v1`, expression `neutral-uv-embedded-basecolor-v1` are pinned independently. Four nondefault styles are supported for the exact current #168 male/female model SHA in `src/appearance/skin-pins.ts`, full individual FBX only. Skin-only uses outline0/omission; combined skin uses **exact width2**. Intermediate combined widths remain unavailable. Default-skin outline-only support remains unchanged: full continuous0<width<=2, approved crop width2. Previous/personal models, scene/VRM and nondefault cropped skin are refused; crop/cap UV lineage is not approximated by nearest positions.

Actual CSP evidence includes neutral8 skin-only +8 combined-width2 imports, plus representative male/female crouch flesh-guide+outline2. These import bytes retained pose and visible texture/black silhouette from FBX-only source folders without manual PNG locators/sidecars. Other6 posed styles have independent writer/import checks; they were not each visually imported. CSP lighting/specular highlights can make some lines faint; exact colors/pixels under every mode/angle are not promised. `.clip` and CSP-internal posing are outside this save scope.

The private skin adapter checks strict live candidate/model/UV/texture/preview metadata, intersects exact certified target rows with independent BFF composition pins, and binds runtime/asset identity on every phase. Its fresh skin proof requires source/final byte hashes, exact approved asset version/manifest/UV/final-texture hashes, approved surface changes only and existing strict geometry/normal/matrix/weight bounds. Material manifest requires exactly three added objects, three connections, one removed body-material connection, geometry ID, UV/Layer fingerprints and embedded image hash. No Boolean alone establishes support.

Actual local GET asset verification passed for all nine unique compressed-UV/2048-preview-PNG assets (male/female flesh PNG shares bytes). Actual full-wire HTTP validation passed thirteen results: default/current-base identity, skin-only and combined male/female downloads, owned preview assets, same-state reuse, late file/postprocess response fences, cross-person/installation credentials, confirmation withdrawal, default restoration and unsupported partial refusal. Seven actual solves/exports, five skin calls and two outline calls were made. See [recorded BFF evidence](qa/skin-fbx-csp-20261106/bff-http.json). Synthetic protocol tests are separate from these real file checks. Production PostgreSQL/S3 and native disk save remain separate validation boundaries.

## Owned preview overlay

The canonical solved pose packet is unchanged. Nondefault active authoritative operations add `skinPreview`:

```json
{
  "schema":"skin-preview-v1",
  "skin":{"version":"fbx-skin-v1","id":"flesh-guide"},
  "assetVersion":"current-neutral-uv-20261106-v1",
  "assetManifestSha256":"<approved SHA>",
  "compatibility":{
    "characterId":"<approved model>","characterSha256":"<approved SHA>",
    "previewMesh":"mesh_000","vertices":24988,"bones":52,
    "polygonIndicesSha256":"<SHA>","weightsSha256":"<SHA>","trianglesSha256":"<SHA>"
  },
  "uv":{"sha256":"<compressed SHA>","bytes":1420163,"url":"<owned operation>/skin-assets/<SHA>"},
  "texture":{"sha256":"<2048-preview SHA>","bytes":280324,"url":"<owned operation>/skin-assets/<SHA>"}
}
```

URLs are BFF-owned paths requiring the same installation headers. Only that operation's approved UV and selected **preview** texture digest are served. A digest/URL is never permission by itself. Skin changes, cancelled/superseded states, other people/installations, source revocation or asset replacement invalidate these paths. Preview metadata is included in durable prepare and revalidated against current approval. Solve/model responses verify mesh name, vertex/bone count and compact triangle-index SHA without editing source positions/normals/weights or canonical packet bytes.

UV response is `application/gzip` with **no Content-Encoding**; verify compressed SHA before bounded decompression into `{uv,triangles,source_sha256}`. PNG response is `image/png`. Both expose exact `Content-Length`, `X-Skin-Asset-SHA256`, revision/state headers and private/no-store. BFF checks SHA/bytes, <=2048 PNG dimensions, <=16MiB inflated JSON, finite UV0..1, exact source/triangle hash and corner count. A bounded eight-entry immutable byte cache reduces repeat reads but never bypasses authorization/current-state checks. Every response re-checks length and SHA against the current pin. The UV structure check (`src/appearance/skin-uv.ts`, same rules as the former schema) runs in a worker thread, at most one at a time, once per pinned digest. Bytes are cached once verified, before the post-read approval fence. Idempotent Converter reads (`/skin-contract`, `/skin-assets/:sha`) reconnect once after a transport reset (`skin_converter_read_retry`). Before 2026-11-13 this check ran on the HTTP event loop for every request. The 139k-vertex male UV held the 0.5 vCPU production BFF for ~10 s, the Converter's 5 s keep-alive closed the pooled socket, and the fence read failed with ECONNRESET → `SKIN_UNAVAILABLE`. Client overlays UV by exact triangle vertex/corner identity and preserves the original pose/camera.

Preview uses prebuilt2048 LANCZOS derivatives from approved final4096 textures, with independent hashes in the same immutable manifest. No texture bake occurs on save. The normalized `skinProof` includes `assetVersion` and `compatibility:{characterId,characterSha256,vertices,bones,polygonIndicesSha256,weightsSha256,previewMesh,trianglesSha256}` alongside final4096 `textureSha256`; preview PNG SHA must not be confused with the final FBX image SHA.

Validation: typecheck/build and1,035 tests (1,033pass, existing2skip,0fail). Separate asset/proof/model/state/cache tests cover forged certificates/pins, malformed manifests, wrong hashes/settings, bounded streaming/inflation, UV topology mismatch, stale/cancel/asset changes and legacy compatibility. No global activation or deployment.
