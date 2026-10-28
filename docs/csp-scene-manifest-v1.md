# CSP scene metadata and partial-save contract (2026-10-28)

Implemented on top of `scene-save-v1` and `scene-review-v1`; no binary response replacement or new inference/layout solver. Flags remain default false. This is BFF integration, not CSP framing validation.

## Capability and selected artifacts

`GET /v1/analysis/jobs/:id/result` keeps `sceneExport`, `sceneRefinement`, and `sceneSaveContract`. New `sceneAvailability.version=scene-availability-v1` separates `originalSelection`, `autoCorrectV4`, and `manifest`: each has `available` and `reasons`. `autoCorrectV4.readiness=configuration_only` does not establish worker health. Reasons:

| Reason | Observed prerequisite |
| --- | --- |
| `feature_disabled` | scene flag off |
| `fbx_export_disabled` | FBX flag off |
| `converter_unavailable` | Converter URL absent (not a live health claim) |
| `observation_missing` | completed image observation absent |
| `semantic_input` | text input cannot compose rough layout |
| `receipt_storage_unavailable` | production shared receipt store absent |
| `refinement_disabled` | v4 flag off |
| `refinement_unavailable` | v4 URL/token configuration incomplete |
| `source_image_unavailable` | v4 original image storage key absent |

`candidateEligibility[]` reports candidate IDs with `generated_individual_only` / `observation_missing`. It is a preliminary check, not final body/hand/selection approval. An unselected generation alternative no longer disables the whole job. A selected generation candidate still fails `409 GENERATED_INDIVIDUAL_ONLY`; no generation approval, quarantine, or existing per-person export guard is bypassed.

## Versioned prepare, read, release

Use the same authenticated `POST /v1/analysis/jobs/:jobId/scene` and existing final per-person `persons` refs. For **either** save mode:

```json
{
  "contractVersion": "scene-save-v1",
  "saveMode": "original-selection",
  "manifestVersion": "csp-scene-manifest-v1",
  "prepare": true,
  "excludedPersonIds": [],
  "persons": ["existing verified FBX refs, not strings in the real request"]
}
```

The response preserves existing review fields and adds `manifest`. Original prepare uses verified FBX without a PNG, empty `previewBase64`/`summary`, and no v4 calls. A configured shared store is required in production. Existing v4 prepare also returns a manifest, even if manifestVersion was omitted.

- `manifest.version`, `jobId`, `snapshotSha256`.
- `sourceImage`: `identity=jobId:input`, `originalName`, actual upload `sha256`, width/height, and `captureMapping:{status:unavailable,reason:not_recorded}`. Unavailable historical name/SHA are null. New uploads persist a basename in `jobs.input_original_name`; no names enter logs. Result exposes the same sourceImage so history reopen can use the job's name. The client must use a neutral jobId fallback when null.
- `artifact`: final FBX SHA, saveMode, layoutVersion (`rough-layout-v1` / `scene-refinement-v4`), fileCount=1.
- `people`: detectedIds, requestedIds, includedIds, missing `[{personIndex,reason}]`, partial, confirmationRequired. Detection means BFF-observed persons only. The count-checked Converter contract verifies requested inclusion; BFF does not invent undetected people or inspect CSP import results.
- `camera`: described below.

Release sends the same refs, saveMode, excludedPersonIds and versions plus `reviewKey`, `reviewVersion`, `artifactSha256`. It returns the exact pinned FBX binary. `metadataOnly:true` on that request returns `{manifest,partialConfirmed,expiresAt}` through the same ownership/revision/expiry/SHA guards. Metadata read does not confirm a save. `partialConfirmed` describes the confirmation submitted on this request, not durable save/download completion.

Review TTL is 900 seconds. Both metadata and binary are `private, no-store`. The snapshot includes owner, job revision, complete per-person refs (including pinned body/hand/scope/review parameters and SHA), save mode, and exclusions. Revalidation runs before and after asynchronous artifact work. Receipt bytes and manifest are checked against SHA and current owned source identity; changing body, hand, scope, candidate, confirmation, owner, source SHA, runtime or expiry invalidates access. A new receipt binding invalidates reviews created by the old implementation; prepare again.

Binary headers, exposed by CORS:

- Existing artifact SHA, person count, scene contract, save mode and layout version.
- `X-Standin-Scene-Manifest-Version`, `X-Standin-Scene-Snapshot-SHA256`, `X-Standin-File-Count`.

Clients must match response SHA/snapshot/mode/layout/count to the prepared manifest before persisting metadata with the file. Metadata must not be reused for another job or expired receipt. Full legacy binary saves remain available; obtaining metadata requires the negotiated prepare path.

## Partial-save confirmation

Omissions are classified without guessing user intent:

| Reason | Meaning |
| --- | --- |
| `no_candidates` | Automatically omitted person has no candidates |
| `user_excluded` | Candidate-bearing, unrequested person explicitly named in excludedPersonIds |
| `not_requested` | Candidate-bearing person not requested; exclusion intent unobserved |

Invalid or unapproved **requested** exports fail with existing errors; they never silently become omitted successful people. Unknown, duplicate, requested, or candidate-less excluded IDs are rejected, so a no-candidate failure cannot be relabeled user exclusion.

Prepare a partial scene, display detected/requested/included/missing counts and reasons, then send `partialConfirmation:{snapshotSha256:manifest.snapshotSha256}` on release. Missing/mismatched confirmation returns `409 SCENE_PARTIAL_CONFIRMATION_REQUIRED`, recovery `confirm_partial`. A partial legacy direct call also fails closed. A selection/body/hand change requires new per-person review and prepare; old confirmation cannot authorize a new snapshot. A full original legacy call is preserved. BFF cannot establish a user's confirmation click from the token alone; the client is responsible for displaying and collecting that intent. Individual per-person endpoints retain their existing semantics; client aggregate individual-file saves need the same partial-save UX.

## Camera and Converter dependency

Current verified `/compose-scene` binary response provides bytes, artifact/input SHA, person count, and layout version; it does **not** provide the complete camera recipe. Current v4 public response does not provide an artifact-bound recipe either. Therefore this implementation returns:

```json
{"version":"scene-camera-v1","status":"unavailable","reason":"converter_recipe_not_provided","recipe":null,"applicationRequired":true,"automaticApplication":"unsupported","cspValidation":"unverified"}
```

No camera values are calculated by the BFF. `scene-camera-v1` in Standin-server commit `612be944d387c3dd2543ee2eed6ae95183c101bb`, `converter/scene_camera.py`, defines the upstream full recipe: source_dimensions; projection; horizontal_fov_degrees; vertical_fov_degrees; principal_pixels; csp.coordinate_system/camera_position/focal_point_position/roll_degrees/perspective/perspective_ui_value/link_camera_advancing_retreating/adapt_view_to_object; requires_camera_application; automatic_import_framing_verified; csp_recipe_application_verified; preconditions; formula_source. Position, focal point and roll must travel together. Aspect ratio is represented by source_dimensions; viewport/canvas mapping is a separate contract.

**Upstream follow-up:** negotiate a versioned metadata transport from compose and v4 build containing that whole recipe, bound to the exact artifact SHA, input image SHA, selected IDs, count, layout version and capture/canvas mapping. Converter must validate that recipe after final FBX serialization. BFF must whitelist/validate it before enabling an available recipe state. That available transport is not implemented or claimed here. Missing camera fields must remain unavailable; a sidecar is not evidence that CSP applied them. Automatic CSP connection and actual import verification remain separate client/server integration tasks.

## Failure and observability

Polling keeps `error` and adds `failure`; history keeps `errorCode` and adds the identical failure contract. `failure={code,phase:analysis,recovery:explicit_retry,serverOperationMayContinue}`; a local analysis timeout/abandoned operation does not establish upstream cancellation. Scene errors add `error.details.phase=scene_prepare` and preserve existing recovery/allowedActions. `SCENE_TIMEOUT` means scene preparation, not analysis. No request time limits are increased and no automatic retries are added.

Structured `scene_capability`, `scene_save_result`, `scene_save_failed`, and `analysis_job` logs include job/request correlation, observed path, selected/included/missing IDs and coded reasons, mode, file/person counts, and duration. They contain no image bytes, original names, export URLs, credentials, camera values, or source prompts. BFF response issuance is not proof of client disk saving.

## Validation

`npm run typecheck`, `npm test`, `npm run test:scene`; original-mode v4-off prepare/metadata/release, shared serialized receipts across replicas, partial confirmation, unselected/selected generation, existing ownership/selection/body/hand/scope/hash/runtime/expiry guards, input identity persistence with actual PostgreSQL schema via PGlite, and CORS exposure.

Generate actual local wire examples after build:

```sh
NODE_ENV=test BETA_DATA_BUCKET= node tools/export-csp-scene-contract.mjs /explicit/output.json
```

The fixture runs real BFF handlers with synthetic repositories, Converter, original image and FBX bytes. It does not verify real S3, installation credentials, native save, worker execution or CSP import. Real source five images/FBX evidence was not supplied. See `csp-runtime-readiness-2026-10-28.md` for separate read-only runtime observations and configuration proposal.
