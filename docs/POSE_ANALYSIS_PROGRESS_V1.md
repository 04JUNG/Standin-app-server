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

Multi-person payloads wait for final crop-retry/person ordering; stage updates still stream earlier. Single-person skeleton, observations and route can arrive earlier. Global completed means at least one person actually ran that stage; skipped on another person cannot conflict with completed. A mixed pose/description fixture and explicit overlap test cover this.

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
