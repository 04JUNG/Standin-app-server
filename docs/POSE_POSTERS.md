# Canonical poster proxy and optional detail

Initial search cards use verified default-body posters instead of per-candidate PNG/GLB conversions. `GET /v1/pose-candidates/:poseId/poster?jobId=...&personIndex=...&candidateId=...&scope=...` requires an owned completed job, the current candidate and manual-priority output scope, a registered source BVH and matching source hash. It checks the job/candidate/scope again after reading the image. Source reads and PNG streams are bounded. The owned pose-presentation asset route also exposes `.../pose-previews/:candidateId/:sourceSha/poster` for library sources. Inline generated sources use the client's authenticated, hash-verified BVH reference renderer.

The proxy only reads inference's `/pose/:id/poster`. It validates PNG digest and source/character/scope/revision/projection/preview-only metadata, preserves those headers, and returns `private, no-store`. `Poster-Kind=default-body` means the approved canonical default mesh; `pose-only` explicitly means a joint reference. Neither claims the selected body, hands, search camera or export permission. Existing camera provenance headers remain exposed; two poster headers are added to CORS.

Mapping publishes poster URLs, while old owned history records can derive them. No Converter is invoked by the poster routes. Selected-body detail remains a separate explicit one-candidate operation, and optional 503/preemption failures do not invalidate static cards.

## Final export scheduling dependency

Cold framing requests for `format=fbx` use internal `purpose=export`, selecting `/convert-framed-export`; optional PNG/model previews continue to use `/convert-framed`. The protected alias must support both PNG and paired model/FBX formats. Deploy server PR [#108](https://github.com/04JUNG/Standin-server/pull/108) before enabling this BFF change. A missing protected endpoint fails explicitly; there is no fallback to optional work and no automatic retry loop. Existing conversion/cache identity and final source/body/hands/scope/ownership checks remain in place. An already validated paired review artifact can still be reused for final export.

The inference poster API and fully baked five-scope library are additional deployment prerequisites for mesh poster coverage. Absent assets are labeled pose-only references. This PR performs no merge, upload or deployment.

Validation: full BFF suite, including poster lineage/ownership/manual-scope/late-change checks and a cold final `format=fbx&previewType=model` route test that asserts protected export purpose and subsequent paired GLB reuse. DB-dependent integration tests remain explicitly skipped without their environment.
