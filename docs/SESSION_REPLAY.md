# Session replay v1 (2026-10-28)

Implementation baseline: `264da73294695da800345dc1e814d11fced7b20b` (`origin/develop`, fetched 2026-10-28).
The source checkout was dirty and left untouched. Implementation lives in branch
`codex/session-replay-bff-20261028` in a separate worktree.

The requested defaults supersede the old optional-quality-consent collection default **for replay only**.
`REPLAY_ENABLED`, `CAPTURE_REPLAY_ENABLED`, `CSP_RESULT_CAPTURE_ENABLED` default to `true`;
`REPLAY_CONSENT_MODE` defaults to `assumed`. They do not grant or modify quality consent,
create consent receipts, change historical metrics, or enable replay in production.

Machine contract: [replay-contract.v1.json](replay-contract.v1.json). IDs, error codes, units,
MIME allowlist, chunk/asset limits and samples are specified there. Client-generated replay IDs
are UUIDs; `windowInstanceId` is a bounded identifier. App/bar/capture use separate streams
(e.g. `${webviewId}_app`) within the shared app session clock.

## Local run (no PostgreSQL installation, AWS or user artwork)

```sh
npm ci
npm run build
npm run replay:local
```

The launcher starts the **real `src/index.ts` BFF**, substituting local PGlite for `pg.Pool`
and a private local object directory. Defaults: port `18080`, data `work/replay-local`.
Set `PORT` / `REPLAY_LOCAL_ROOT` to isolate concurrent runs. It writes generated local admin
credentials and a dashboard URL to `work/replay-local/connection.json` (mode 0600, ignored).
Use that URL to open the existing `/v1/admin/ops/dashboard`; **지표 → 관련 세션 리플레이**.
The query token is removed immediately using the existing dashboard behavior. A fresh HTTP
navigation/reload must use the generated dashboard URL again (existing dashboard auth contract).

The local-only `/__replay-fixture` records a small synthetic DOM with the **actual
`@rrweb/record` 2.2.0**, uploads through installation-authenticated replay routes, and opens
in the same dashboard. This checks transport and playback, and is not evidence of actual
Tauri/CSP operation. These fixture routes are registered only by the local launcher.

For the real desktop client, use the same server base URL and register through
`POST /v1/installations` with the existing required basic beta agreement. No new quality UI
or invented consent is needed for replay assumed eligibility. Normal analysis needs a local
inference server at `INFERENCE_BASE_URL`; the launcher does not create successful inference,
FBX or CSP-import outcomes when inference is unavailable.

```sh
npm run typecheck
npm run test:replay
npm test
```

## Authorization and environment

Installation ID/device token/client-version/basic-beta-consent checks are unchanged. Every
write locks the installation then recording and validates ownership. Admin reads use the
existing reviewer token and produce an audit row with the actual request ID, installation
and replay target. Assets and chunks never have public/presigned URLs; every byte is
proxied through the admin gate with `private, no-store` and hash verification.

`REPLAY_ENVIRONMENT` defaults to `NODE_ENV`, otherwise `development`. Assumed collection
**and all assumed reads** are limited to `development` / `staging`. Docker uses
`NODE_ENV=production` even in staging, so a future staging deployment must explicitly set
`REPLAY_ENVIRONMENT=staging`. Do not set that value on a production deployment.
Unknown environment names fail closed. Production defaults to rejection; a future explicit
mode checks actual current personal-data/content-license consent and its exact receipt ID.

Turning `REPLAY_ENABLED=false` rejects collection and reads, while replay deletion remains
available. `CAPTURE_REPLAY_ENABLED=false` rejects capture streams/background assets;
`CSP_RESULT_CAPTURE_ENABLED=false` rejects CSP result assets. No current environment,
AWS resource, installation, consent row, workflow or deployment was changed by this work.

Initial optional-quality fields of false are not a withdrawal: registration does not grant
quality consent or set a replay-withdrawal marker. An explicit quality-consent PUT denying
either purpose, or `DELETE /v1/replays`, sets a persistent `replay_withdrawn_at` marker and
removes recordings. Previous explicit withdrawals in consent receipts are also checked.
There is no assumed-mode regrant UI in this change.

## Storage, limits and ordering

PostgreSQL stores sessions, per-window streams, chunk descriptors, asset versions/bindings,
job links, indexes, persistent daily usage and a deletion outbox. JSON chunks and image/font
bytes live in `LocalReplayStorage` or the private `S3ReplayStorage` adapter, partitioned by
replay UUID. S3 puts use SSE-S3 and no ACL. No bucket/resources are created by the app.

The original UTF-8 events JSON is SHA-256 verified before decompression/storage acceptance.
Gzip output is capped at 1 MiB; ingestion HTTP bodies are capped before JSON parsing.
Limits: 1 MiB raw chunk, 8 MiB asset, 64 MiB session, 256 MiB/installation/UTC day,
100 recordings/installation/day, 16 streams, 4096 chunks/session, 512 unique assets,
10,000 events/chunk, 4-hour session clock. Daily usage survives recording deletion.

Identical sequence/hash/metadata retries succeed without double charging. Different
content at the same sequence conflicts. Out-of-order chunks are accepted, sorted and
reported as sequence gaps. Finish declares the last sequence for every stream, distinguishes
complete/incomplete, and seals the recording; a different finish conflicts. No finish is
shown as upload incomplete (not as user abandonment).

Assets are keyed by exact bytes and accept append-only semantic/version/job bindings, so
one image may represent multiple immutable snapshots. Same pose ID/new bytes is a different
asset. CSP assets require an owned job, final FBX hash and selection snapshot version.
The real export/framed/scene response path records a 14-day server artifact-hash receipt
before a matching CSP asset is accepted; unknown/job-mismatched hashes return
`REPLAY_ARTIFACT_UNVERIFIED`. A witness write failure never changes a successful FBX response.
The receipt proves which job produced those bytes, not that the user imported them. The
selection snapshot label is explicitly `client_reported`, while `artifactBinding=server_export_hash`.
A CSP picture is evidence of capture, never inferred `csp_import_succeeded`. Optional image
assessment is separate metadata; client assessment custom events remain separate observations.

## Retention and deletion

The maximum is 14 days from server creation. An earlier declared source expiration or
linked original-input 90-day expiration shortens the whole recording. Every read checks
expiration even before the sweep. A minute sweep deletes expired metadata and retries
object-prefix deletion from the durable outbox; the trigger queues deletion in the same
transaction as metadata deletion, including cascade deletion. Failed physical deletes stay
queued. API authorization is revoked immediately, so no previously issued asset URL stays
usable. There are no public/presigned URLs or application URL caches.

**Conservative deletion:** a history page can embed older jobs without complete per-node
provenance. Until all visible assets have reliable provenance, deleting any owned job purges
that installation's recordings. This deliberately over-deletes replay evidence rather than
leave an old rough/text in a DOM chunk; it does not delete other analysis jobs. Partial DOM
redaction is not claimed. Installation deletion and explicit withdrawal purge all recordings.
The object prefix includes chunks, snapshots, thumbnails and frames. A minimal UUID-only tombstone (no installation/content) prevents a stale offline create from resurrecting deleted recordings; it expires at the original expiry or one day after deletion, whichever is later. An interrupted object
put may leave an unindexed file under an existing session prefix; session expiry/deletion
removes the prefix. The proposed bucket lifecycle provides the maximum-lifetime backstop.

## Dashboard and playback isolation

The existing dashboard/journey/product/ops panels remain. Replay is part of its actual
metrics tab, with period, environment, installation, internal-test audience, OS/version,
surface, screen, feature, error and storage filters. Job detail/recent job rows link to
related sessions. Existing analytics remain authoritative; replay writes no duplicate
analytics events. Custom replay observations appear only as player annotations. Error
annotations seek five seconds before the recorded event. The timeline shares the native
app-session epoch across windows.

The pinned `rrweb-player` 2.2.0 and CSS are bundled locally at build time. The authenticated
bundle is loaded as trusted code in the admin realm. It builds the display in an outer
`sandbox="allow-same-origin"` iframe **without allow-scripts**, then rrweb creates a second
iframe with the same script prohibition. A strict CSP inherited by the nested document
blocks scripts, all external/network requests, navigation bases, forms, objects and media;
only local blob/data images, blob fonts and inline CSS are allowed. A page CSP independently
blocks external origins. `UNSAFE_replayCanvas` and plugins are disabled. Dangerous nodes,
handlers, links/forms/IPC targets and external URLs/CSS imports are removed before rebuild.
The DOM recording never receives the admin token and never runs recorded code. Same-origin
access is required by the trusted engine for reconstruction; scripts remain prohibited in
both display documents. Initial opaque-origin nesting was tested and rejected because
rrweb cannot access its document under inherited opaque-origin sandboxing.

Play/pause, speed, seek and skip-inactivity come from rrweb-player. Capture custom events
reconstruct background/cursor/selection in physical image coordinates. Only uploaded 3D
frame assets are shown; DOM replay is not a WebGL reenactment. Missing canvas, assets,
sequence gaps, unfinished upload, expiry, deletion and permission rejection are explicit.
Input rough, final image and CSP photo are displayed with their snapshot versions and any
assessment. No CDN script, runtime source URL, Tauri command or original app action is used.

## Evidence and remaining checks

See [SESSION_REPLAY_VALIDATION.md](SESSION_REPLAY_VALIDATION.md) for exact observations and
limitations. Production/AWS integration, actual macOS/Windows Tauri recordings, real CSP
window capture, native permissions, multi-monitor/DPI behavior and ON/OFF render/latency
measurements require their corresponding runtimes; a browser replay or synthetic fixture
does not establish those results. This PR is a Draft and must not be deployed or merged
as part of the current task.
