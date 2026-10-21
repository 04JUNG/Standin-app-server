# v4 scene preparation in the save flow

Default off. Requires `FBX_EXPORT_ENABLED=true`, `SCENE_EXPORT_ENABLED=true`,
`SCENE_REFINEMENT_ENABLED=true`, and a private `SCENE_REFINEMENT_BASE_URL` plus
`SCENE_REFINEMENT_TOKEN` (32+ characters). No flag defaults are changed here.
The separate worker is `Standin-server/src/scene_refinement`; keep it internal.
Its BFF HTTP request budget is `SCENE_REFINEMENT_TIMEOUT_MS` (default 900000);
`/analyze` is unchanged. Capability eligibility does not claim worker readiness.

The public contract is [scene-save-v1](scene-save-contract.md). Legacy `{persons}`
and explicit `original-selection` always compose the existing rough integrated
FBX. Only negotiated `auto-correct-v4` enters prepare/review/save. Missing worker,
original, or review never silently falls back to the original-selection mode.

Preparation reuses ownership, confirmed selection, per-person export routes,
body/hand revisions, registered BVH gates and SHA checks. It reads the owned
original, asks the worker for a plan, converts authorized full sources with the
selected body/shape/hands, and builds the final scene. Unsupported calibration
fails; no master-body substitution. Public summary is derived from the owned
baseline and validated worker results, strips private notes and paths, and never
invents a baseline direction. Final source checks still run after preparation.

The pinned final FBX/summary is published under a random 15-minute scene review
key. `sceneStorage.ts` uses immutable S3 objects at
`installations/:owner/jobs/:job/scene-receipts/:key.json`. This is separate from
`converter/framedStorage.ts` per-person shared receipts. Current develop already
had scene S3 publication; this change scopes the memory cache to a route instance,
persists the review contract version, and tests a second instance loading the
stored file. S3 publication must finish before the key reaches the client.
Production without a bucket fails preparation. Development without a bucket can
use memory but loses reviews on replica changes/restarts and requests preparation
again. Memory eviction never regenerates an acknowledged file.

Save and optional preview require the exact review version and artifact SHA as
well as the same owner/job/source binding. The BFF rechecks person guards and
returns the stored bytes; it never repeats worker preparation after confirmation.
The client must hash downloaded bytes before native save. Optional preview failure
does not invalidate the final file. Existing per-person guard errors propagate.
Receipt schema v2 rejects earlier or corrupted stored receipts; prepare again.

HTTP cancellation stops client waiting; no API promises worker/Blender operation
cancellation. Timeout/disconnect may leave computation running. A discarded review
expires naturally. Treat user cancellation as a separate UX state, not export
failure. Worker generic 422 errors and private plan affinity/readiness remain
explicit integration gaps described in the public contract.

Validation in this change uses local job/export/worker/storage fixtures. It is not
an installed-app or Staging E2E result. Real three-cut integration with a prepared
worker, app and floating bar, native save and matching SHA remains pending. CSP
camera adoption and exact absolute screen framing are separate validation steps.
