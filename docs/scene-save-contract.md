# Scene save BFF/client contract — 2026-10-30

`POST /v1/analysis/jobs/:jobId/scene`, existing installation authentication.
Default flags and the current integrated-export pause remain unchanged.
Native execution depends on [server #153](https://github.com/04JUNG/Standin-server/pull/153)
(`e12ab015f481417bb34dc8b6870d2c62fff3a5f6`), `refine-v4-parts-http-v1` /
`refine-v4-parts.1`. See [implementation, policies and validation limits](scene-refinement-v4.md).

## Configuration and live discovery

Job `capabilities.sceneAvailability.autoCorrectV4` retains
`readiness=configuration_only` and now exposes `configured` separately. Its
`available=false` and reasons `parts_discovery_required`, `explicit_intent_required`
do not declare the worker ready or an input accepted. `parts` exposes required
contract/engine, explicit intent, no automatic image extraction and a discoveryPath.
`capabilities.sceneRefinement=false` and job saveModes do not advertise execution
from URL/token configuration. Original-selection availability remains independent.

New authenticated, owned-job discovery:

```http
GET /v1/analysis/jobs/:jobId/scene/parts
```

It calls the private worker's authenticated `GET /parts/capabilities`, validates
versions and strips unexpected fields. On success it returns:

```json
{
  "capability": {
    "contract_version":"refine-v4-parts-http-v1",
    "engine_version":"refine-v4-parts.1",
    "available":true,
    "operations":["advance_foot"],
    "catalog_sha256":null,
    "recipes":[],
    "automatic_image_extraction":false,
    "requires_explicit_intent":true,
    "requires_artifact_review":true
  },
  "sceneSaveContract": {
    "version":"scene-save-v1",
    "saveModes":["original-selection","auto-correct-v4"],
    "partsDiscoveryRequired":true,
    "manifestVersion":"csp-scene-manifest-v1",
    "reviewVersion":"scene-review-v1",
    "reviewTtlSeconds":900,
    "cancellation":{"httpRequest":true,"serverOperation":false}
  },
  "supportedCurrentAssetScopes":["full"],
  "requestEligibility":"requires_explicit_selection",
  "executionStatus":"not_attempted"
}
```

A configured, booted worker can still reject a particular rig/skin/operation. A
missing/old/disabled worker is an error, not fabricated availability. Never display
this discovery or a `not_attempted` state as applied or as a quality improvement.

## Original selection

Existing `{persons}` remains original selection even with refinement flags ON.
Explicit original request:

```json
{"contractVersion":"scene-save-v1","saveMode":"original-selection","persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<current reviewed FBX SHA>"}]}
```

It returns one rough-layout FBX, without correction. Do not include `parts`.
Following any failed correction, this is a separate user-selected recovery action.
Partial saving and manifest confirmation follow [the existing manifest contract](csp-scene-manifest-v1.md).

## Explicit parts preparation

Client change is required. Keep the reviewed current full FBX refs (including
body/shape/hand/output-scope revision query fields) and add `parts` to every
correction prepare, preview, metadata and final save request:

```json
{
  "contractVersion":"scene-save-v1",
  "saveMode":"auto-correct-v4",
  "manifestVersion":"csp-scene-manifest-v1",
  "prepare":true,
  "artifactOnly":true,
  "persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<current reviewed FBX SHA>"}],
  "parts":{
    "contractVersion":"refine-v4-parts-http-v1",
    "engineVersion":"refine-v4-parts.1",
    "catalogSha256":null,
    "edits":[{
      "personIndex":0,
      "intent":{"source":"user_confirmed","reference":"user_edit_1","description":"왼발을 인물 앞쪽으로 5cm 더 내민다"},
      "operation":{"type":"advance_foot","side":"left","distance_m":0.05}
    }]
  }
}
```

`intent.reference` is a 1–128 character opaque alphanumeric/underscore/hyphen
client edit ID. `description` is the exact confirmed instruction (1–4096
characters). BFF derives the original VLM context from owned stored evidence;
the client cannot supply or override it. A missing description remains null.
A new edit/reference invalidates the old review, even when the instruction looks
similar. One edit per person, 1–8 edits, all drawn from the authorized persons.
Unedited included persons retain their current reviewed FBX.

A reviewed recipe uses `operation:{"type":"recipe","recipe_id":"<discovered ID>"}`,
the discovered catalog SHA, and **exactly** its discovered description. Anatomical
left/right is explicitly chosen, never inferred by BFF from the screen or text.
There is no automatic VLM-to-operation mapping. Edited current assets must have
resolved scope `full`; other scopes fail rather than being regenerated from BVH.

Preparation returns the existing `reviewKey`, `reviewVersion=scene-review-v1`,
900-second `expiresAt`, final `artifactSha256`, `artifactContract=verified-scene-fbx-v1`,
`personCount`, `fileCount=1`, `requestId`, `jobId`, manifest and `parts` receipts.
`version=rough-layout-v1` describes final composition, **not** the parts engine.
`summary=[]` is retained for response compatibility; legacy pose/direction goals
are not inferred for native parts. The final manifest includes `artifact.parts`
with each native input/output SHA, linking native lineage to `artifact.sha256`.

Applied receipt example (hash/ID placeholders must be replaced by returned values):

```json
{"personIndex":0,"candidateId":"pick","contractVersion":"refine-v4-parts-http-v1","engineVersion":"refine-v4-parts.1","engineExecuted":true,"status":"applied","applied":true,"reason":null,"adjustedLimbs":["left_leg"],"inputSha256":"<current FBX SHA>","artifactSha256":"<native output SHA>","requestId":"<worker request ID>","requestSha256":"<server request SHA>","contextSha256":"<server context SHA>","catalogSha256":null,"scoreStatus":"not_scored","bffRequestId":"<BFF request ID>","savedVerification":{"matrixError":0.000001,"surfaceErrorM":0.000001},"provenance":{"vlmDescription":"stored_analysis","userInstruction":"user_confirmed"}}
```

Retained uses the same fields with `status=retained`, `applied=false`,
`reason=PARTS_REJECTED|PARTS_UNCHANGED`, `adjustedLimbs=[]`,
`inputSha256=artifactSha256`, `savedVerification=null`. Input/output **bytes** are
also checked. This is “검사 후 현재 포즈 유지”, not successful correction or score uplift.
`provenance.vlmDescription=not_recorded` means original text was unavailable; no
replacement text was generated. The server does not expose a separate receipt ID;
its request ID plus request/context hashes identify the execution receipt.

## Preview and final save

Keep `persons`, `parts`, contract/saveMode and manifest version unchanged. Remove
`prepare`/`artifactOnly`; supply `reviewKey`, `reviewVersion`, `artifactSha256` from
the response. Add `preview:true` for a PNG rendered from the persisted final FBX,
or `metadataOnly:true` for manifest/parts metadata. Without those flags, the same
request downloads the pinned final bytes. Client must compare downloaded file SHA
with review and `X-Standin-Artifact-SHA256` before native saving.

Native prepare always uses artifact readiness with empty `previewBase64` and the
empty-content `previewSha256`; request the optional final-FBX preview separately.
Omitting `artifactOnly` does not restore the old plan/build or paired-preview path.
`X-Standin-Scene-Version=refine-v4-parts-http-v1` identifies the native download
path; `parts[].engineVersion` and validated execution evidence identify actual
parts execution. Existing final-camera negotiation remains opt-in. Camera recipes
are bound to the final composed SHA; automatic CSP camera application is unverified.

Shared S3 scene receipts remain immutable, owner/job scoped and 15 minutes long.
Memory loss can load the same receipt on another replica; local development without
shared storage must reprepare after replica loss. Production requires shared storage.
New binding versions invalidate earlier legacy reviews. Changing input, candidate,
body/shape/hands/scope/camera, persisted confirmed-selection timestamp (including
reconfirmation of the same candidate), instruction/recipe/catalog/description or engine/request
contract invalidates the review. Check again after render and receipt publication.
There is no correction, original substitution or BVH rebuild on download.

## Errors and state

Envelope: `{error:{code,message,requestId,details:{phase,stage,jobId,retryable,recovery,allowedActions,serverOperationMayContinue}}}`.
`phase=scene_prepare` remains compatible; stage identifies source validation,
capability/refine, preview, receipt publication or release. Existing protected
per-person errors propagate unchanged. No internal upstream message, path or traceback.

| Code | HTTP | Action |
|---|---|---|
| PARTS_CONTRACT_UNSUPPORTED / PARTS_RECIPE_UNAVAILABLE | 409 | Refresh available corrections; unsupported, no applied result |
| PARTS_EXPLICIT_INTENT_REQUIRED / PARTS_INTENT_MISMATCH | 409 | Review and explicitly confirm the correction |
| SCENE_PARTS_SCOPE_UNSUPPORTED | 409 | Choose/review a full-body output before preparing |
| PARTS_INVALID_INPUT | 422 | Review input; do not truncate or guess missing intent |
| PARTS_DISABLED / PARTS_UNAVAILABLE | 503 | Retry later after service readiness |
| PARTS_RELEASE_CHANGED | 503 | Rediscover catalog and prepare again |
| PARTS_TIMEOUT / SCENE_TIMEOUT | 504 | Prepare again; prior computation may continue |
| PARTS_WORKER_FAILED / SCENE_FAILED | 502 | Explicit retry; no result saved as a correction |
| PARTS_INTEGRITY / SCENE_INTEGRITY | 502 | Discard result; prepare again |
| SCENE_CANCELLED | 409 | Local cancelled state; do not auto-retry |
| SCENE_REVIEW_REQUIRED / SCENE_REVIEW_EXPIRED | 409 | Prepare again |
| SCENE_SOURCE_CHANGED | 409 | Return to current person/selection review |
| SCENE_UNAVAILABLE / SCENE_BUSY | 503 | Service/configuration unavailable or shared worker slot busy |

`retryable` is true for transient availability/busy/timeout/worker failures, not
unsupported versions, invalid input, cancellation or integrity failures.
`allowedActions` may offer `use_original_selection`, always an explicit separate
request. User cancellation aborts HTTP waiting; no server stop acknowledgment or
automatic retry exists. Ignore late responses using the client's current selection/
request identity. Preparing → reviewing → saving → completed are distinct from
cancelled/failed. Retained results use a neutral “현재 포즈 유지” state.

Client UI should show “보정할 동작 선택” with the reviewed recipe label/exact sentence,
explicit confirmation, “보정됨”, “검사 후 현재 포즈 유지”, “지원하지 않는 보정”, or
“보정하지 못했습니다”. Keep protocol names, hashes and worker terms in diagnostics.
This needs app and floating-bar changes; an old auto-correct button without the
new explicit selection cannot execute native parts.

## Verification status

Contract, asset binding, privacy/consent, cache invalidation and failure/retry/cancel
are local fixture tests. No actual BFF→deployed-worker/staging-app run, arm/leg
application, native download/reopen, quality score or 50-cut reevaluation is claimed.
The historical wire-fixture exporter remains a synthetic legacy regression tool;
its old plan/build examples are not the new client request contract. Native examples
and regression tests above are authoritative for this change.
