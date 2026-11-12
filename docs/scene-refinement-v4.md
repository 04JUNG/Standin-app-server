# Native parts v4 in the scene save flow — 2026-10-30

This BFF implements the server contract in [Standin-server #153](https://github.com/04JUNG/Standin-server/pull/153), inspected at
`e12ab015f481417bb34dc8b6870d2c62fff3a5f6`. The matching
[server HTTP contract](https://github.com/04JUNG/Standin-server/blob/e12ab015f481417bb34dc8b6870d2c62fff3a5f6/docs/REFINE_V4_PARTS_HTTP.md)
and `src/refine_v4/service.py` are the wire source of truth. The PR was open,
unmerged and undeployed when inspected. Server develop `121684a1a` alone does
not expose the parts API. BFF base is develop `08ea45f`.

## Actual call path

`POST /v1/analysis/jobs/:jobId/scene` with negotiated `auto-correct-v4` and an
explicit `parts` selection:

1. Authorize owned completed job, confirmed candidate and existing reviewed FBX
   through protected local export dispatch. Check exact bytes/SHA and the existing
   body/shape/hand/output-scope/review/runtime guards.
2. Authenticated `GET /parts/capabilities` on `SCENE_REFINEMENT_BASE_URL` using
   `SCENE_REFINEMENT_TOKEN`. Require `refine-v4-parts-http-v1`,
   `refine-v4-parts.1`, live availability, explicit-intent/review requirements,
   supported operation and the same catalog SHA the client selected.
3. `POST /parts/refine`, once per explicitly selected person, with that person's
   **current reviewed full FBX bytes**. `review_reference` hashes the owned job,
   job revision, persisted confirmed-selection timestamp, exact reviewed ref
   (including body/hand revisions) and BFF request.
   Context binds owned job/person/candidate/original input SHA, stored original VLM
   description and the separately confirmed user instruction. No raw URL, local
   path, donor, free rotation or Python code is sent.
4. Verify engine actually executed, request ID/request SHA/context SHA, catalog,
   original/current/output SHA, exact intent/operation, applied limbs and saved
   matrix/surface verification. `applied` must change bytes; `retained` must return
   the exact current input bytes. Unknown statuses, `not_attempted`, old engine,
   missing evidence or contradictory receipts cannot create a review.
5. Send the returned per-person FBXs to existing Converter `/compose-scene` for
   rough layout composition. Other selected people retain their current FBXs.
   Keep each native input/output SHA in `parts`; bind that lineage to the separate
   final composed artifact SHA in the manifest/review.
6. Publish the final FBX in the existing immutable owner/job receipt store. Recheck
   source/body/hands/scope/selection, stored description and live capability after
   asynchronous work, including receipt publication. Preview uses
   `/render-final-preview` with **that stored final FBX**, and download returns
   those same bytes without rerunning parts or rebuilding BVH.

Production does not call legacy `/scene/plan` or `/scene/build` for correction.
`sceneLegacyRefinement.fixture.ts` and the older joined harness retain historical
plan/build regression fixtures only; they are not production dispatch or native
execution evidence. New native protocol/handler tests are `sceneParts.test.ts`.

## Scope and policies

Default flags are unchanged. `SCENE_EXPORT_ENABLED`, `FBX_EXPORT_ENABLED`,
`SCENE_REFINEMENT_ENABLED`, existing worker URL/token and production shared
receipt storage must be configured. Both server scene-worker and Converter images
must contain #153; the worker additionally requires `SCENE_PARTS_ENABLED=1` and
an approved pinned catalog for recipes. This BFF task does not enable or deploy
any of them. The current develop pause of integrated FBX export remains in force.

Configuration-only job capabilities never imply a ready worker. The new owned
`GET /v1/analysis/jobs/:jobId/scene/parts` performs live discovery and exposes
supported operations plus explicit selection/review requirements. Live service
support is still not request-specific skin/rig acceptance or successful correction.

This is a separate, versioned explicit parts contract for already authorized
reviewed assets. Existing candidate/person `refineAllowed=false`, release policy,
hand-skin/export guards and generated-candidate restrictions are unchanged. The
server validates native geometry and skin/contact nonregression per request.
A retained skin rejection is displayed as retained, never applied or improved.

Only edited persons whose current resolved output scope is `full` are supported.
A cropped FBX fails `SCENE_PARTS_SCOPE_UNSUPPORTED`; the BFF does not make a new
full FBX from an earlier BVH or silently change output scope. Native final-FBX
cropping for other scopes requires a separate server contract. Body/shape/hand
variations are sent exactly as reviewed, with server acceptance still required.

The server does **not** extract parts/left-right/crossing targets automatically
from the image. The client must show and confirm the explicit operation or the
exact reviewed recipe sentence. Missing intent fails `PARTS_EXPLICIT_INTENT_REQUIRED`.
No IK, natural-language side inference or invented relation defaults are added.
The wire contract has no separate structured relation object: recipe descriptions
and operation fields are preserved exactly, and unsupported relation fields are
not invented or sent to the server.

## Original description and provenance limits

The BFF reads existing `analysis_people.person_tags_json.poseDescription` only for
the owned job under its still-current quality consent, preserving `bodyDetails`
and `searchText` exactly in a labelled JSON string in `context.vlm_description`.
`context.user_instruction` and `intent.source=user_confirmed` remain separate.
A declined/withdrawn/missing original description is sent as null, never replaced
with a short title, fabricated text or a previous evaluation baseline. Receipt
provenance distinguishes `stored_analysis` from `not_recorded` and preserves
request/context hashes. Changed/withdrawn source text invalidates prior reviews.

This cannot reconstruct text absent from older jobs or restore the original text
before existing analysis capture limits (4000 characters per stored text field).
The two stored texts must fit the server's 4096-character context limit without
truncation; otherwise correction fails explicitly. Full raw VLM preservation
beyond those existing capture limits needs an agreed consent/retention and server
context expansion; it is not claimed complete by this adapter. No new prompt,
rough image, VLM text or user instruction logging/storage lifecycle is introduced.

Python server hashes use `json.dumps(sort_keys=True, allow_nan=False)` including
ASCII escaping and separator spaces. BFF validation matches that representation;
checked-in Python-produced vectors cover Korean, surrogate pairs, DEL and small
exponents. Raw HTTP JSON serialization alone is not the server receipt hash.

## Cache, errors and cancellation

The review binding includes a new execution-binding version, public save/review
versions, expected parts contract/engine, owner/job/input identity, observed
person/candidate/camera/scope data, exact reviewed FBX refs/revisions, confirmed-selection timestamps, exclusions,
explicit operations/instructions/provenance, original stored description and catalog
SHA. Prior legacy receipts and changed selections cannot match this binding.
Engine/catalog capability is checked again on release; a disabled, missing or old
worker cannot release a correction review. Receipt decode rechecks native metadata
and its final-manifest binding on another replica. Preview and download never
share another owner's receipt or regenerate an acknowledged file.

Typed server error codes are allowlisted with their exact HTTP status; private
message/path/traceback fields are discarded. Errors include BFF requestId, jobId,
stage, retryable, recovery/allowedActions and serverOperationMayContinue. Existing
per-person guard envelopes are preserved. Timeout and HTTP cancellation are
separate codes (`SCENE_TIMEOUT`, `SCENE_CANCELLED`); neither claims the worker has
stopped. No automatic retry is made. A late storage operation can leave an
unacknowledged expiring object, but no review key/cache success is returned and a
new prepare has new request IDs and an independent review. Selection changes
while computing/rendering/publishing invalidate release. Original-selection save
remains an explicit separate recovery request.

## Validation boundary

`npm run test:scene` exercises real BFF handlers/transports/receipt serialization
against synthetic worker/Converter/FBX fixtures. It includes applied/retained,
engine and SHA mismatch, policy/intent/recipe rejection, unavailable/old worker,
late worker/storage response, cancel, timeout, retry, scope/body/hand/candidate
invalidation, consent/description changes, final-preview SHA and replica download.
It is **not** actual native Blender execution or installed-app staging validation.

Pending after server #153 merge and deployment: arm and leg each applied through
the installed app, BFF/inference/worker versions, request/job IDs, native input/
output and final download SHA, screenshots, native download and FBX reopen/import.
T002/T018 are regressions, not promised accepted examples. No new quality score,
score uplift or 50-cut evaluation was performed. Server PR's local native proof
and pre-10/30 legacy scene-save proof are not BFF staging-app evidence.
