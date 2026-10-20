# Verified FBX readiness (2026-10-21)

`GET /v1/pose-candidates/:id/framed?format=ready` prepares a `verified-fbx-v1` artifact without PNG/GLB work. The response has an empty body and `X-Standin-Artifact-Contract`, review key, FBX SHA256, source SHA256, character SHA256, scope, and applicable body/hand revision headers. This is an artifact receipt, not evidence that a user saw an image.

The BFF checks ownership, current selected/confirmed candidate, manual/generated permissions, registered/quarantined source, refined BVH, character/runtime, shape authoring source, both hands and scope before and after preparation. Existing manual release exceptions remain manual exceptions: no candidate is promoted and no failed screen status is rewritten.

Downloads and follow-up PNGs send `artifactReceipt=<review key>` and `reviewKey=<review key>` with the original selection parameters. Downloads use existing-only cache lookup. PNGs render the persisted FBX through `/render-final-preview`; they never re-convert BVH. A missing receipt fails closed; no download falls back to a new render. Old paired PNG/GLB endpoints remain supported.

Person artifacts use the immutable private S3 store with an explicit artifact contract and a separate cache key. Concurrent replicas return the first committed artifact. Aborted subscribers leave shared work running only while another subscriber needs it; the final subscriber's departure aborts the converter request. Optional images run below final FBX preparation in the converter queue.

Scene refinement opts in with `{prepare:true, artifactOnly:true}`. Full-person reconstruction and final scene build skip output renders, while geometry/camera checks and explicit acceptance of model-driven scene changes remain. Scene receipts are persisted privately under the existing owned-job S3 prefix, expire after 15 minutes, and are re-authorized on every preview/download. Legacy clients omitting `artifactOnly` keep the paired PNG contract. The new client caches a prepared scene receipt for re-downloads of the same source revisions.

Validation: `npm test` covers ready/cache/download without any image, image-only failures, verification failures, source/quarantine/selection/runtime changes, manual semantic and generated candidates, shared cancellation, scene preview failures, scene receipt serialization, and all existing scene/BVH paths. Production S3 replicas were not exercised live; storage publication and integrity are tested with local store fixtures. Existing beta bucket read/write grants and job/installation-prefix deletion cover the new scene prefix.

Deploy the server PR (Converter and scene worker), then BFF, then client. No migrations or `/analyze` policy changes are needed. No installed-app E2E or paid scene-model call was run.
