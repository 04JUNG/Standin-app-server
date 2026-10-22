# Scene integration validation — 2026-10-22

Baseline BFF develop: `8cc692d638de1d08844260b9530f60e087bf8ad6` (#126).
Client coordination baseline: `234fb196ff41fdec2ba15e911e675783708ba21e` (#148).
The mode/version/expiry/summary/shared-receipt implementation from those PRs is
retained. Request/response schemas remain [scene-save-v1](scene-save-contract.md).

## Fixed release boundary

The scene route used to reauthorize sources before calling the optional final PNG
renderer, then return its result without another check. A regression changing the
job during rendering returned HTTP 200 instead of 409 on the original develop.
A second regression showed that a render error could also mask a simultaneous
selection change as generic HTTP 502.

The final owned-job, confirmed candidate and original per-person export/SHA checks
now run after rendering, including a failed render. Stale body, hands, scope and
job state keep their existing typed errors. The BFF never releases the stale PNG,
never changes save mode, and never rebuilds a reviewed FBX. A rendering-only
failure still permits a valid receipt's exact stored file to be saved.

## Joined-handler local regression

`src/pose/sceneIntegration.test.ts` starts with the real per-person
`createFramingRoutes` ready/download handlers, producing source references bound
to selected body, hands, scope, source BVH, character and runtime. It then executes
`createSceneRoutes`, `prepareRefinedScene`, private worker transport decoding,
composition and final preview adapters. A second scene-route instance loads the
serialized shared receipt and returns exactly the reviewed FBX.

| Case | Observed contract |
|---|---|
| Legacy `{persons}` with correction eligible | Original integrated FBX; no worker plan/build |
| Explicit original-selection | `rough-layout-v1`, selected person count, one binary file |
| Prepare correction | `scene-review-v1`, expiresAt, two person summaries, fileCount=1 |
| Confirm from a second BFF route instance | Serialized receipt loaded once; exact reviewed SHA/bytes; no second plan/build |
| Body/hand/scope changes during PNG | 409 BODY_PREVIEW_STALE / HANDS_CHANGED / OUTPUT_SCOPE_CHANGED |
| Job change during PNG | 409 SCENE_SOURCE_CHANGED |
| PNG failure plus body change | 409 BODY_PREVIEW_STALE; rendering failure cannot hide invalidation |
| Changed candidate/source/confirmation/ownership | Person/scene guards reject preview and save |
| Changed source runtime | 503 PREVIEW_NOT_READY from the existing-only person receipt; return to person review |
| Rendering-only failure | 502 scene image failure; same valid scene receipt can still download exact FBX |
| Webview transport | Actual production CORS exposes SHA/person-count/contract/mode headers |

External repositories, worker/Converter responses, original image and FBX payloads
are synthetic. The PNG is a valid 1px transport asset with verified chunk CRCs.
Installation credential validation is replaced by a fixture identity header.
The shared store is a serialized in-memory fixture, not live S3; independent
scene handler caches are used. Geometry, native FBX import, real model execution
and installed app behavior are not established by these tests.

Export the same wire data for a client adapter/hook/app/bar replay:

```sh
npm run build
NODE_ENV=test BETA_DATA_BUCKET= node tools/export-scene-wire-fixture.mjs /explicit/output.json
```

The export includes individual ready/download replies, original/legacy-original,
prepare JSON, preview, confirmation and invalidated body/runtime preview replies,
request refs, generatedAt and an implementation SHA over the executed compiled
handlers. Client tests should freeze time to generatedAt; these are recorded
15-minute receipts, not reusable live credentials. The exporter refuses a configured
bucket or production NODE_ENV. Replay is a local fixture, never Staging E2E.

## Verification performed

- `npm run typecheck`: passed.
- `npm test` (includes build): 756 tests, 754 passed, 2 existing skips, zero failures.
- `npm audit --omit=dev --audit-level=high`: passed; the existing Hono moderate
  advisory remains, with no high/critical finding at this threshold.
- Worker `api.py`, `engine.py`, `plan.py` in the provided read-only 5d547ed checkout
  have the same blobs as remote develop on 2026-10-22. No worker source is changed.

## Required real integration remains pending

Coordination's read-only Staging runtime inspection found BFF task :86 running
8cc692d, but no explicit scene export/refinement enable values, scene worker URL
or scene token entry in its environment/secrets names. The inspected ECS service
list only establishes BFF/analysis-worker/Converter/inference; it does not prove
that a scene worker exists elsewhere. Calibrated body SHA/assets, real scene
runtime access, authorized owned three-cut jobs and the latest installed Staging
app build are not confirmed.

A compatible Converter alone is not evidence that the scene plan/build worker is
ready. Current private worker generic 422/500 failures and pending-plan replica
affinity remain its owner's integration contract. Its README's old process-local
BFF-receipt description is stale relative to BFF #126's shared scene S3 store.
The separate refine v3 design is not scene v4 deployment readiness.

With the prepared runtime and installed app, verify the original three cuts in
both app and floating bar: mode choice, final comparison/confirmation/cancel,
review expiry and selection changes, displayed N persons / 1 FBX, reviewed versus
downloaded/native-file SHA, and native save/import. No merge, deployment or
operational flag activation is part of this change.
