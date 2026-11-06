# pose-analysis-progress.v1 — BFF implementation and local handoff

Shared contract: `/Users/dowon/.codex/worktrees/pose-search-film-loading/Standin-client/docs/POSE_ANALYSIS_PROGRESS_V1.md`.

- BFF: `/private/tmp/standin-pose-progress-bff`, branch `codex/pose-analysis-progress-v1`, base `origin/develop` at `37adaa6`.
- Producer: `/Users/dowon/.codex/worktrees/eef0/Standin-server`, branch `codex/pose-analysis-progress-producer`, base `f23dfdd0f`.
- Producer milestone details: sibling `Standin-server/docs/POSE_ANALYSIS_PROGRESS_V1.md`.
- Original dirty checkouts were not edited. No merge, deployment or production analysis was performed.

## What is connected

The existing authenticated owner-scoped Job status GET adds optional `progress` only while `status === running`. The final result endpoint and all existing select/refine/export capabilities are unchanged. Progress previews are never inserted into candidate/selection/refine tables.

`runAnalysisJob` requests NDJSON on the SAME `/analyze` call. New inference streams cumulative real milestones before completion. Older inference returns ordinary JSON and continues normally without any second analysis call. Malformed/unknown progress degrades to ordinary loading; malformed/incomplete terminal transport remains an analysis error. Stream errors retain the original status/detail used by existing failure/refund classification. Timeout covers the stream body too.

Only an explicit allowlist is persisted/public: original-image normalized COCO17 points, fixed Korean translations of explicit body observations, actual executed searchMode, exact final candidate IDs/ranks with existing static thumbnails. Internal prompt/reasoning/debug/trace/prose/scores are not copied. `/v1/pose-candidates/:id/thumbnail` proxies an existing bundle file; missing files return 404 and never render. Aligned/poster/lookup/converter URLs are rejected for progress.

Stage connection:

| Stage | Actual source | Limitation |
| --- | --- | --- |
| analyzing | existing initial VLM | no timer/percentage estimate |
| extracting | finalized validated pose mask after existing recovery | invalid/suspect joints absent; all face points null |
| understanding | existing description join, explicit body_observations | at most 4 fixed Korean body keywords currently; absent on unsupported/legacy description paths |
| searching | actual geometry/semantic submissions | combined/pose/description/upper_body; no mode for blocked/basic-model paths |
| refining | **not run by image analysis** | skipped; no before/after or running state. Selected-result `/refine` stays a separate user action |
| ranking | existing final person order and API asset binding | exact presentation IDs; missing static thumbnail => omitted preview |

Multi-person people payloads wait for final crop-retry/person ordering; stage updates and a temporary focus overlay now stream earlier (see the focus extension below). Single-person skeleton, observations and route can arrive earlier. Global completed means at least one person actually ran that stage; skipped on another person cannot conflict with completed. A mixed pose/description fixture and explicit overlap test cover this.

The producer itself buffers only its newest cumulative event; terminal cannot be overwritten by late progress. BFF storage also keeps at most one in-flight write and one newest pending snapshot per Job. No progress write is awaited at completion, and closing the writer drops pending telemetry. Job completion and result rows now publish together under the existing job lock.

## Persistence and concurrency

Idempotent `SCHEMA` migration adds `jobs.progress_json JSONB`, `progress_sequence`, `progress_source_sequence`, `progress_run_id`. These live on the existing owner/deletion-scoped row, so no new retention table or public callback endpoint is needed.

Each lease claim clears its run identity/source sequence but preserves the Job's public sequence. Updates atomically require matching run ID, increasing source sequence, running status and a live lease. Worker startup is fenced by owner+attempt; stale worker result/failure writes are fenced too. PostgreSQL assigns monotonically increasing public sequence across attempts. Lower/out-of-order source updates and updates after terminal/deletion/lease expiry are ignored. Storage failure is best effort and does not turn successful analysis into failure.

## Fixtures and checks

- `fixtures/analysis-progress/pipeline-v1.json`: OFFLINE mock-pipeline snapshots passed through the real BFF sanitizer; combined/description 1p/2p plus legacy mixed pose+description. Not production analysis evidence.
- `fixtures/analysis-progress/contract-cases-v1.json`: explicitly SYNTHETIC parser cases for all five refine outcomes; these are not emitted by the current producer and never trigger refinement.
- Producer raw allowlisted snapshots: sibling `Standin-server/tests/fixtures/analysis_progress/producer-v1.json`.
- `src/jobs/progress.test.ts`: schema/privacy/coordinate masks, original terminal/error contract, byte-split UTF8, old JSON compatibility/no duplicate request, bounded storage writes, real PostgreSQL SQL fences/lease retry/order, owner-scoped GET, terminal precedence and corrupt optional data.
- `scripts/check-progress-client.mts` loads the client's production parser read-only. All 39 snapshots currently pass, including mixed people, missing joints and all synthetic refine states.

```bash
npm ci
npm run test:progress
npm test
node --import tsx scripts/check-progress-client.mts \
  /Users/dowon/.codex/worktrees/pose-search-film-loading/Standin-client/src/features/pose-viewer/api/analysisProgress.ts
```

Regenerate pipeline fixtures from the producer worktree with `python -m scripts.analysis_progress_fixture /tmp/pose-progress-producer.json`, then here run `node --import tsx scripts/progress-fixture.mts /tmp/pose-progress-producer.json`. No remote model/render call is made by either fixture command.

Validated locally: BFF typecheck/build; full suite 983 passed / 2 existing opt-in skips; producer selected suite 121 passed / 3 existing Gemini adapter cases deselected because this local QA environment lacks google-genai. All new producer tests pass. No live-artwork/model accuracy claim is made.

## Local client integration

For HTTP/client work using this BFF's real routes/auth and an embedded local PostgreSQL:

1. Start this producer worktree's local API on `127.0.0.1:18000`. Its report above gives an explicit offline mock command; this mode does not produce real observation words or library thumbnails. To inspect actual model milestones, use your existing **local** model/library configuration with this producer instead.
2. In this BFF worktree: `BETA_DATA_BUCKET='' INFERENCE_BASE_URL=http://127.0.0.1:18000 PORT=18080 npm run replay:local`. Existing launcher uses PGlite/local state, real installation auth and inline Job execution; it sends no email, Slack or AWS queue traffic. Use fresh local `work/replay-local` state or another `REPLAY_LOCAL_ROOT`. It is not a deployment.
3. Set the client development API URL to `http://localhost:18080` using its existing local configuration and launch the app. It registers its local installation normally. Upload a local test image. Existing polling reads progress and terminal status. Do not add stage delays: quick mock analyses may complete before one poll, which is expected.
4. For the full visual sequence including refine variants, use the client's explicitly labelled DEV replay with the fixtures above. This is separate from actual inference integration.

Deployment order when separately authorized: migrate/start BFF normally (idempotent schema), roll producer/BFF independently; old JSON fallback remains compatible. Intermediaries must permit unbuffered NDJSON for actual live updates. A buffered proxy can collapse progress into the final response without affecting result correctness; no fake fallback stages are generated.


## Optional activeJoints extension (2026-11-06)

The previous BFF checkout under `eef0` was removed after the original handoff. This dedicated branch has been reopened at `/private/tmp/standin-pose-progress-bff`; the original dirty checkout remains untouched.

`ProgressPerson.refinement.activeJoints?: number[]` is now accepted from an explicit valid producer refinement record (`candidateId` + known `status`). Values must be unique COCO17 body indices 5..16, with at most 12 entries. The whole optional field is omitted when missing, malformed, duplicated, out of range, fractional or nonfinite; no filtering/deduplication guesses activity. An explicitly provided empty array is valid. Valid arrays are copied and retain producer order through storage/public projection. Private refinement fields remain stripped; before/after/thumbnail production remains unconnected.

The existing image analyze producer still skips auto-refine and emits no activeJoints. No new refinement, model call, rendering, timer, coordinate-delta inference or eligibility-derived declaration was added. Actual running metadata and changed before/after positions remain distinct concepts for the client.

Validation: `npm run test:progress` (12 passed), full `npm test` (985 passed, 2 existing opt-in skips), and the existing 39 snapshots accepted by the client's production parser. Existing fixture files were not changed. Client source and inference producer files were not changed by this extension.


## Early multi-person focus extension (2026-11-06)

Optional public shape:

```ts
focus?: {
  id: string; // temporary Job observation, NOT personIndex/candidateId
  skeleton: Overlay;
  observations?: { id: string; label: string }[];
  searchMode?: 'pose' | 'description' | 'combined' | 'upper_body';
}
```

Producer publishes one actual validated multi-person skeleton after existing crop/rescue/repair and before routing/search. It never assigns a provisional person index. Exact internal slot identity binds any already available explicit body observations and actual search mode; unknown association is omitted. No words/route from another slot are copied. Public allowlist strips internal IDs/prompts/debug and uses the existing fixed Korean translation and searchMode whitelist.

Focus requires a nonempty trimmed ID (max 160, no control characters), normalized COCO17 shape, and at least one valid body point after masking face/invalid coordinates. Missing/malformed/empty focus is omitted without failing analysis. Final nonempty people takes precedence and removes focus. Owner/sequence/lease/terminal predicates are unchanged; the real owned status GET test now round-trips focus and still rejects other owners/terminal progress.

`fixtures/analysis-progress/focus-v1.json` contains 39 new offline production-pipeline/sanitizer snapshots, including combined/description single/multi and mixed legacy paths. Fully rough/invalid multi-person cases correctly omit focus. Valid multi-person cases show extracting focus, then same-slot observation/search metadata, then sorted people without focus. `pipeline-v1.json` and `contract-cases-v1.json` retain the original 39 snapshots unchanged.

Regenerate separately to preserve the baseline: from the producer worktree, `python -m scripts.analysis_progress_fixture /tmp/pose-focus-producer.json`; then here `node --import tsx scripts/progress-fixture.mts /tmp/pose-focus-producer.json fixtures/analysis-progress/focus-v1.json`.

Validation: `npm run test:progress` includes 14 tests; full BFF suite 987 passed / 2 existing opt-in skips. `scripts/check-progress-client.mts` validates all 78 snapshots with the production client parser and checks that focus fields are retained, not stripped. Producer selected suite: 124 passed / 3 pre-existing Gemini cases excluded for missing google-genai. Its tests observe actual multi-person focus before search proceeds and verify final result and VLM/pose/search call-count equivalence. No client source, new refinement, model invocation, renderer, search or phase timer was added by this work.

## Original-VLM scene metadata extension (2026-11-06)

Root `scene?: { shot?: 'full_half'|'bust'|'face'; view?: 'front'|'side'|'back'|'three_quarter'; personCount?: number }` is now allowlisted. Fields are independently validated; personCount must be an integer in 0..20. Missing/invalid fields are omitted individually, and an empty scene is omitted. There are no fallback defaults or inference from focus/people. Valid zero is retained. The existing owned status GET and storage/public projection preserve scene; owner/lease/sequence/terminal behavior and final results/permissions are unchanged.

Producer enriches the existing snapshot immediately after original VLM analyze. It uses actual valid stated cut labels, not fallback control enums or representative-person view. A numeric original `num_people` must be an integer in 0..20 and match the parsed VLM analysis count; invalid/coerced/clamped/box-derived counts are omitted. Private/raw prompt, reasoning, dialogue and boxes never leave the allowlist. Scene stays cumulative as focus is replaced by final people. Auto-refine remains skipped.

New `fixtures/analysis-progress/scene-v1.json` has seven offline producer cases / 39 snapshots, run through the actual BFF sanitizer. Original `pipeline-v1.json`, `contract-cases-v1.json`, and `focus-v1.json` (78 snapshots) were not modified. Raw source fixture: `/Users/dowon/.codex/worktrees/eef0/Standin-server/tests/fixtures/analysis_progress/scene-producer-v1.json`.

Regenerate: in the producer worktree, `python -m scripts.analysis_scene_fixture /tmp/pose-scene-producer.json`; then in this BFF worktree `node --import tsx scripts/progress-fixture.mts /tmp/pose-scene-producer.json fixtures/analysis-progress/scene-v1.json`.

Validation: `npm run test:progress` 15 passed; `npm test` 988 passed / 2 existing opt-in skips. Selected producer suite 158 passed / 3 existing Gemini adapter cases excluded for unavailable google-genai. `node --import tsx scripts/check-progress-client.mts /Users/dowon/.codex/worktrees/pose-search-film-loading/Standin-client/src/features/pose-viewer/api/analysisProgress.ts` accepts all 117 snapshots and checks scene (and focus) deep equality against the production parser. Producer tests also verify delivery after VLM but before pose and unchanged final outputs/call counts. Client source was not modified in this session. Shared contract reporting is append-only.

## Live QA inline/PGlite completion fix (2026-11-06)

The root session's first actual QA analysis finished inference, but status polling remained running/ranking. Reproduced without touching the live process/DB: PGlite SELECT returns `rows.length=1` with `affectedRows=0`; the local launcher's nullish fallback exposed `rowCount=0`. `persistAnalysisRecords` treated that as a missing/obsolete Job and returned before recording any people/result/terminal state; the runner then logged completed unconditionally.

The local adapter now prefers returned rows, matching pg SELECT rowCount. The persistence guard checks actual `rows.length` rather than the affected-row count and returns an explicit false when a deleted/replaced Job is ignored. The runner only logs completed after a successful persistence path; ignored lease/result writes produce JOB_NOT_CURRENT instead. Status/result/record publication remains atomic under the existing owner/lease lock. Quota, candidates, refinement and selection permissions are unchanged.

New `src/jobs/runner.test.ts` runs the actual inline runner + PGlite + a fully mocked inference response (three people, zero candidates), through both the legacy zero-SELECT-rowCount and corrected adapter semantics. It verifies completed_at/result/people rows, owned status GET immediately completed, no terminal progress and no completed log from an obsolete worker. `test:progress` now includes this regression. No external inference/model call, live database mutation, server restart or browser action was made in this fix session. The root session alone controls the remaining authorized image run.

The first Job may have no stored result/people because of the early return. Do not synthesize a result or silently resubmit its image: recover only from an authentic captured terminal response, otherwise preserve it as failed integration evidence. The root session owns any state repair decision.


## Latest develop integration validation (2026-11-06)

Prepared a separate worktree `/private/tmp/standin-pose-progress-bff-develop` on `codex/pose-analysis-progress-bff-develop`, rebased onto `origin/develop` at `36c6e49`. The live QA checkout `/private/tmp/standin-pose-progress-bff` remains at its original branch/commit. Conflict resolution keeps the latest interactive-state/history/static imports, the complete existing test list, and the progress plus inline completion regression suites. No dependencies or lockfile changed.

Validation after rebase: full `npm test` builds successfully and reports **1,061 passed, 0 failed, 2 existing opt-in skips** (1,063 total). The current client production parser from `/Users/dowon/.codex/worktrees/pose-search-loading-client/Standin-client/src/features/pose-viewer/api/analysisProgress.ts` accepts all **117** public snapshots and retains optional scene/focus fields. `git diff --check origin/develop...HEAD` passes. No real model requests, live database reads/writes, server restart or browser activity occurred in this validation.

The original session remains the sole owner of actual OpenAI QA and any retry decision. Backend branches have not been pushed and PR creation remains contingent on that session's actual integration findings. The upstream raw CutResult/fullbody report is not durably captured by BFF: stored reduced results, refinement contexts and consent-gated quality signals do not constitute a complete replay source for candidates excluded by asset validation. Never invent missing candidates or permissions to repair the live evidence.
