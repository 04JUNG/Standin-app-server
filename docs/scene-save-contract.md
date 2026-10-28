# Scene save BFF/client contract — 2026-10-22 (develop + integration follow-up)

Endpoint: POST /v1/analysis/jobs/:jobId/scene; existing installation authentication.
This document is maintained alongside the BFF implementation. v4 remains default OFF. No worker readiness claim.

## Negotiation and capability
Job result capabilities adds `sceneSaveContract`:
```json
{"sceneExport":true,"sceneRefinement":true,"sceneSaveContract":{"version":"scene-save-v1","saveModes":["original-selection","auto-correct-v4"],"reviewVersion":"scene-review-v1","reviewTtlSeconds":900,"cancellation":{"httpRequest":true,"serverOperation":false}}}
```
`saveModes` includes only currently eligible modes (production correction requires a configured shared receipt bucket); `sceneRefinement` is configuration/input eligibility, not live worker readiness. `sceneSaveContract` exists even when modes are empty. Default legacy `{persons}` always uses original-selection even with v4 flag ON. Any prepare/review/preview request without the new explicit contract+mode is rejected, never silently reinterpreted. Unsupported supplied contract/version/mode fails.

## Requests
`persons` is the existing 1–8 reviewed FBX refs, including personIndex, candidateId, exportPath (pinned body/hand revisions/review key) and sha256. Keep the same refs throughout preparation and confirmation.
```json
{"contractVersion":"scene-save-v1","saveMode":"original-selection","persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<64 hex>"}]}
```
For partial scenes and versioned metadata, the [2026-10-28 manifest extension](csp-scene-manifest-v1.md) supersedes the direct-save guidance below: partial release requires a prepared snapshot confirmation. Full legacy requests remain compatible.

Original-selection returns a single binary FBX with `X-Standin-Scene-Version: rough-layout-v1`. No pose correction; existing rough relative layout composition remains. No scene prepare required. To return from correction, discard pending review and deliberately send this request using the original refs (refresh per-person reviews if stale).

Prepare:
```json
{"contractVersion":"scene-save-v1","saveMode":"auto-correct-v4","prepare":true,"artifactOnly":true,"persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<same confirmed 64 hex>"}]}
```
Response 200:
```json
{"contractVersion":"scene-save-v1","saveMode":"auto-correct-v4","version":"scene-refinement-v4","reviewVersion":"scene-review-v1","expiresAt":"<ISO UTC>","reviewKey":"<48 hex>","artifactContract":"verified-scene-fbx-v1","artifactSha256":"<64 hex>","previewSha256":"<64 hex>","previewBase64":"","personCount":1,"fileCount":1,"summary":[{"personIndex":0,"previousPoseId":"original","poseId":"final","previousOutputScope":"half","outputScope":"full","poseChanged":true,"outputScopeChanged":true,"previousDirection":null,"directionChanged":null,"direction":null,"interaction":null,"armGoalCount":0}]}
```
`previousPoseId`/`previousOutputScope` come from owned confirmed BFF selection; `poseId`/`outputScope` and optional direction/interaction/armGoalCount come from validated worker output. Null means not reported; do not claim direction unchanged or fabricate degrees/IK details. No inferred percentage progress. Direction is either null or `{torso_camera_yaw,torso_label,head_label,head_camera_yaw,head_relative_yaw,head_pitch_degrees}`. Numeric angles and bounded labels are whitelisted from worker output, absent values are null, worker notes are never exposed. `previousDirection` and `directionChanged` are always null because the confirmed BFF selection has no semantic baseline direction; camera rotation is not used to invent one. `interaction` is `preserve|restraining|reaching|null`; `armGoalCount` is a count or null when unreported, never an inferred per-joint progress/diff. `previousOutputScope` is the selected resolved scope, not a statement that the original drawing had that scope.
`artifactOnly:true` keeps current verified FBX readiness path; if false/omitted, existing paired PNG path remains. Request a preview of the pinned FBX with the confirmation body below plus `preview:true`; preview failure does not invalidate FBX review or trigger rebuild.

Confirm/save (or preview):
```json
{"contractVersion":"scene-save-v1","saveMode":"auto-correct-v4","reviewVersion":"scene-review-v1","reviewKey":"<received>","artifactSha256":"<received>","persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<same confirmed 64 hex>"}]}
```
Returns exact pinned bytes after ownership/candidate/source/body/hand/revision rechecks. Compare actual downloaded SHA with reviewed SHA and `X-Standin-Artifact-SHA256` before native save. Headers also carry person count, scene version and save mode/contract version. Never rebuild on save. Review expires after 900s (server authoritative; ISO expiresAt for UI). Keys are scoped to owner/job/source binding, with scene-specific S3 prefix `scene-receipts/`; they are not per-person shared review receipts. S3 shared storage survives replica changes. Receipt serialization v2 persists reviewVersion; old-format receipts fail closed and require preparation again. Publication failure returns SCENE_UNAVAILABLE before any reviewKey is exposed. Without shared storage, only local development can retain receipts in memory and another replica/restart returns reprepare-required; production preparation fails unavailable if bucket absent.

## Error envelope and recovery
Existing `{error:{code,message,requestId,details}}`. Scene errors add `details.recovery` (primary action), `details.allowedActions` and `details.serverOperationMayContinue` (true on timeout/disconnect; no stop guarantee). No automatic mode switch.

| Code | HTTP | recovery | Meaning |
|---|---|---|---|
| SCENE_CONTRACT_UNSUPPORTED |409| refresh_capabilities | unsupported/missing opt-in contract or mode/review version |
| SCENE_REVIEW_REQUIRED |409| prepare_again | missing/unknown key, including local process loss |
| SCENE_REVIEW_EXPIRED |409| prepare_again | expired known receipt |
| SCENE_SOURCE_CHANGED |409| review_selection | job/refs/body/hands/source changed |
| SCENE_UNSUPPORTED_BODY |409| change_selection | explicit calibrated body incompatibility |
| SCENE_UNAVAILABLE |503| retry_later | flag/config/original/shared storage/worker unavailable |
| SCENE_BUSY |503| retry_later | upstream 429 or exact current 503 `{detail:"scene worker busy"}` (no queue/progress claim) |
| SCENE_TIMEOUT |504| prepare_again | upstream deadline; worker operation may continue |
| SCENE_INTEGRITY |502| prepare_again | malformed lineage/SHA; never save bytes |
| SCENE_FAILED |502| retry_later | unclassified failure; do not invent worker reason |

`allowedActions` advertises primary recovery and can include `use_original_selection` for an explicit user action; it is never a server fallback. Existing per-person guard errors propagate unchanged (e.g. body/hand review/revision error): clear scene review and return to per-person selection/review. Existing INVALID_INPUT, GENERATED_INDIVIDUAL_ONLY, SCENE_OBSERVATION_MISSING remain.
Worker code was inspected read-only and its api.py/engine.py/plan.py blobs match remote develop 7a3713f7cbd1e78925f6e78704f5ff706b96bfa2 as of 2026-10-21. Map only transport status evidence (429, 503, 504), exact bounded 503 busy detail from api.py, and BFF validation. BFF can distinguish its own unsupported shape/calibration, including Converter's exact 409 `CHARACTER_SHA256_MISMATCH`. Do not classify all 409/422 as unsupported body. Current worker returns generic 422 for evidence rejection, expired plans, prepared pose/body lineage mismatch, and queue-full ValueError: those remain SCENE_FAILED until a typed worker error contract is agreed. Worker subprocess timeout can also surface as generic 500; BFF cannot promise SCENE_TIMEOUT for that case. Missing readiness endpoint and process-local private worker plan affinity remain worker-owner deployment concerns; a BFF shared scene receipt is created only after successful build.

## Cancel/state semantics
UI states: preparing → awaiting_confirmation → saving → completed; cancelled and failed separate. Cancel/leave aborts client HTTP wait (AbortController), discards scene review and ignores late responses; it does not promise cancellation of worker/Converter work. No server cancellation endpoint, no worker-stop acknowledgment, no cancellation failure event. Pending receipt expires naturally. A retry after timeout can create another operation. Native save cancellation remains client-side. No export_failed for user cancel.

## App/bar UX state contract
Both app and floating bar use the same scene confirmation workflow: announce selected N persons / 1 combined FBX; offer original-selection or auto-correct-v4; show preparing without fabricated progress; show confirmed source/selection and final summary; await explicit save or cancel/back; show saving only after confirm, then completed (1 file). A local selection/revision change must discard the pending scene key, preview and summary. On expiry, disable confirmation and prepare again. HTTP cancellation/late response must not return the UI from cancelled into saving/completed. Existing reference/person thumbnails and scene preview are comparison aids; no additional original-image rendering API is introduced.

## Validation boundary
Local fixture route/serialization/regression tests only. Real three-cut integration on latest installed Staging app remains pending worker readiness, both app/bar confirmation, worker asset availability, reviewed/downloaded SHA equality, and native save/import validation. No merge/deploy/default enable in this task.


## 2026-10-22 joined-route integration clarification

No request field, version, save mode or summary type changed. BFF develop #126 and client develop #148 already implement the negotiated contract. `armGoalCount` is worker goal count, not an observed count of changed joints. Keep semantic labels/hashes/IDs/versions for diagnostics and translate them into concise ordinary UI copy. Unreported baseline direction remains unknown.

A scene PNG is returned only after the final job ownership/confirmed selection/source/body/hand/scope/SHA guards run **after rendering**. A change during a slow render returns the same typed scene/person guard error used by save, rather than publishing the old image. Revalidation also runs when rendering fails, so an image-service error cannot mask a concurrent source/review invalidation. No automatic rebuild or mode change is added.

For scene preview requests, treat `SCENE_REVIEW_REQUIRED`, `SCENE_REVIEW_EXPIRED`, `SCENE_SOURCE_CHANGED`, and existing person stale/review errors as invalidation requiring re-confirmation. `PREVIEW_NOT_READY` from this endpoint is an important person-receipt invalidation: a changed Converter runtime changes the existing-only per-person cache identity, which can return HTTP 503 with that code before scene rendering. Return to person selection/review; merely retrying the PNG or retaining scene confirmation does not refresh those source receipts. Its 503 status alone does not mean an optional image failure. BFF keeps this existing code and does not pretend to know whether the missing receipt resulted from runtime change, expiry or eviction. Other person error statuses/codes remain unchanged. A rendering-only failure on the pinned file may offer retry and keep the stored scene review; it cannot silently build another FBX.

The sanitized local `bff-scene-wire-fixture.json` contains per-person ready/download responses with pinned references, original/legacy-original, prepare, preview, same-file confirmation across independent BFF route instances, late-body-change preview and changed-runtime preview responses, plus request refs, generatedAt and provenance. It is generated by `NODE_ENV=test BETA_DATA_BUCKET= node tools/export-scene-wire-fixture.mjs /explicit/output.json` after a build, through the real `createFramingRoutes`, `createSceneRoutes`, `prepareRefinedScene`, worker transport, composition and preview adapters. Repositories/worker/Converter, original image and FBX bytes are synthetic; installation credential validation, actual S3, native filesystem saving and real worker execution are not verified by it. A valid 1px PNG is used only as a transport asset. Freeze client test time to generatedAt to avoid treating this recorded 15-minute review as live. The compiled implementation hash records generator provenance. Do not call replaying this data an installed-app E2E result.

Read-only runtime readiness evidence is in coordination `runtime-readiness.md`: observed Staging task :86 runs BFF develop 8cc692d, but scene flags and worker URL/token are not configured in its explicit environment/secrets list. The ECS service list does not establish a separate scene worker. Calibrated asset SHA/readiness, authorized 3-cut jobs, runtime access and latest installed Staging app build have not been supplied. These are outstanding owner-provided integration prerequisites; this work does not deploy or enable them. Worker source at 5d547ed still has the prior scene v4 api.py/engine.py/plan.py blobs, generic 422 errors and private pending-plan affinity. Worker README's process-local BFF-receipt statement is stale relative to BFF #126's shared scene S3 store; the source README is not a readiness signal.

BFF implementation/fixture evidence for this follow-up is versioned in `docs/scene-integration-validation-2026-10-22.md`. No client native or real-worker completion is inferred from that record.
