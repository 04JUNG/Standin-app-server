# Replay validation — 2026-10-28

Baseline: `264da73294695da800345dc1e814d11fced7b20b`, isolated branch
`codex/session-replay-bff-20261028`. No deploy, merge, release, live database, consent
or AWS/environment mutation. Feature-branch pushes do not match the deploy workflow's
`main`/`develop` branch triggers.

## Automated checks

- `npm run typecheck`: passed.
- `npm test`: **872 passed, 0 failed, 2 pre-existing conditional skips** (874 total).
- Replay-specific **13 integration/security tests**, all passed, execute the actual PostgreSQL
  schema twice in PGlite and actual Hono routes. They cover installation/admin boundaries,
  unchanged consent/receipts, local byte storage/read/hash, duplicate and conflicting chunks,
  reordered/missing/final chunks, gzip output limits, unsafe content, MIME validation,
  CSP job/artifact requirements and actual export witness, asset multi-bindings, shorter source expiry, 30-day expiry (readable through day 30 minus 1 ms, denied at day 30),
  unchanged stored expiry on create retries, 20-day CSP receipt acceptance and 30-day receipt rejection/purge,
  explicit OFF/production denial, current and legacy withdrawal, job/installation purge,
  durable object-deletion queue, anti-resurrection tombstones, quota survival after deletion, stable equal-time pagination,
  existing admin router/audit request IDs and replay targets, bundle presence and dashboard script parsing.
- Existing retention/job-history tests also passed after the new replay deletion path.

These are PostgreSQL engine tests through PGlite, not a claim of live RDS or AWS testing.

## Browser playback (actual dashboard, not a standalone sample)

A local launcher ran the real `src/index.ts` BFF with local PostgreSQL/objects.
The existing `/v1/admin/ops/dashboard` retained journey/product/ops panels and showed
replay in its metrics tab. The official `@rrweb/record` 2.2.0 recorded a synthetic UI,
then installation-authenticated HTTP uploaded chunks/assets and sealed the session.
Dashboard list → manifest → bundled rrweb player → play/pause/end/seek worked; capture
background, cursor and selection were reconstructed at the recorded endpoint.

The actual client agent additionally recorded its real React app: home → text-search
input → floating bar → real CaptureOverlayPage (owned synthetic image) → crop → home.
Its source BFF on `localhost:18081` accepted **143,764 JSON-wire bytes**, with zero reported
client queue gaps and no app page errors. Source recording:
`bc81fb8a-16bd-4696-955e-dad682f3ebc9`, app version `0.2.3`, assumed authorization.
The manifest has **app: 3 chunks, bar: 2 chunks, capture: 3 chunks, 2 immutable images**.
It stores **405,981 bytes** including images and raw decoded chunks.

To avoid restarting or mutating another chat's process/worktree while its old dashboard
HTML was loaded, this chat fetched that recording through the source BFF's authenticated
manifest/chunk/asset APIs and revalidated it into a separate local test store. It preserves
the event data, hashes, clock, asset bytes and unfinished state. Minimal copied job contexts
are explicitly labeled local-copy context, not successful inference or export. The latest
real BFF/dashboard on `localhost:18082` successfully played the **actual client app and
floating-bar DOM** and the **custom-only capture stream** with play/seek controls, showing
restricted black background + owned crop + aligned selection rectangle. Browser error/warning
log was empty. No clone or modification of client source was used.

The original recorder did not send finish, so all three windows correctly show
`upload_incomplete`. The local inference endpoint was unavailable: the recorded analysis
failure is not a successful inference/export/CSP claim. No observation gap is interpreted
as abandonment. Screenshots are delivered with the task output; no artwork or generated
local credentials are committed as fixtures.

## Performance evidence supplied by client integration

Client's measured fixture: headless Chrome on macOS, owned rotating synthetic WebGL sphere,
actual recorder/canvas module + real BFF, six seconds per mode. This is **not** a native
Tauri WebView or production model benchmark and is too short to establish steady-state memory.

| Metric | OFF | ON |
|---|---:|---:|
| Frame rate | 59.91 fps | 60.37 fps |
| Frame p95 | 17.5 ms | 17.6 ms |
| Synthetic click to next RAF p95 | 9.3 ms | 12.2 ms |
| Capture synchronous p95 / max | 0.1 / 0.1 ms | 0.1 / 4.4 ms |
| Heap delta during sample (GC-sensitive) | -745,812 B | +297,227 B |
| Uploaded JSON-wire bytes | 0 | 122,860 B |
| Estimated wire bytes/min (short-sample extrapolation) | 0 | 1,225,944 B |

BFF provides per-request route/status/duration through the existing metrics logger, raw byte
counts in manifest chunk descriptors and session totals, sequence/gap/finish state and
asset MIME/version/hash. No second product-event stream is inferred by the recorder.
For a release decision repeat ON/OFF with the real native model/capture workflow on both OSes,
longer warm/cold samples, peak resident memory and actual upload wire accounting.

## Isolation evidence and limits

Both display iframes use `sandbox=allow-same-origin` **without allow-scripts**; the trusted
bundle runs outside recorded DOM. The outer strict CSP is inherited by the rrweb display
frame and blocks external requests, script, forms, objects and navigation bases. Parent-page
CSP independently restricts external origins. Unsafe canvas replay and plugins are disabled;
source DOM gets URL/node/handler/CSS sanitization before reconstruction. Browser verification
confirmed normal playback still works under those restrictions.

S3 adapter and unapplied IAM/bucket-lifecycle proposal are included, but no real bucket,
RDS, S3 permissions, backup erasure or multi-replica PostgreSQL lock stress was exercised.
Production assumed eligibility is rejected by policy tests; a deployed production test was
not run. Job deletion conservatively purges the installation's recordings because history
views lack complete node provenance. That over-deletion is intentional and documented.

Still unverified here: actual macOS/Windows native Tauri operation, OS permissions, real CSP
window capture + real FBX version, minimized/closed CSP windows, multiple native monitors/DPI,
large production DOM sessions and long-duration memory/latency. The client agent owns native
adapter testing. The BFF requires owned job + artifact hash + snapshot version for CSP assets;
its PNG storage/read contract is tested, but a real CSP picture was not produced in this chat.
