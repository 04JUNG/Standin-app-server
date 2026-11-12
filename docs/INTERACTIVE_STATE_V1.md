# Interactive pose operations — real-model integration

The BFF now uses a private authenticated Converter HTTP adapter. `INTERACTIVE_STATE_ENABLED=false` remains the default; enabling it requires `CONVERTER_BASE_URL`, `CONVERTER_INTERACTIVE_TOKEN` and the matching opt-in Converter service/private volume. Existing installation authentication, owned job/candidate/confirmed selection, release/quarantine, current source/body/shape/hand/runtime, lease/revision/expiry checks remain authoritative. No inference or pose solving is implemented in BFF.

## Public operation lifecycle

`/v1/analysis/jobs/{jobId}/people/{personIndex}/interactive-state` supports head recovery, idempotent prepare, polling, cancel, model, background export, verified file and auxiliary client-canvas frame delivery. The original contract remains additive. A model packet is display authority; a verified current receipt controls file readiness. HTTP download is distinct from native disk persistence. The BFF never reports background file preparation as an export-completed/save event.

The private adapter sends the exact base/refined BVH bytes, server-resolved selection and immutable BFF expiry. Converter retention is bounded to that same deadline (maximum one hour). Missing/expired handles revoke durable ready state; Client retry recovers the head and creates a fresh revision. Converter rechecks bytes, registry character SHA, shape recipe/source/controls, hand library and frozen runtime. It returns an opaque snapshot ID and typed canonical packet. BFF verifies canonical hashes and full identity and persists only bounded proofs/operation state. On file delivery it checks the independently reimported receipt, exact state/revision/model/runtime, file length and SHA, then rechecks current selection and ownership.

Refine now persists bounded actual inference provenance (`interactive_lineage` JSONB: version, config SHA, base SHA). It never stores keypoints/prompts in this metadata. Refined interactive preparations without that provenance fail closed; legacy export compatibility is unchanged. Old cached refine rows must be regenerated before using the new interactive path. Solver/gates and inference request policy are unchanged.

## Top5 assets

Result negotiation batches static resolution from an offline Converter store. The returned `interactivePreview` capability appears only if every returned candidate has a complete source/approved-character/scope asset. Static file routes are installation-owned and recheck current body, candidate source/quarantine, SHA and ownership. Missing coverage retains legacy previews and never triggers a per-card Blender job. No whole-library coverage is claimed from the five-candidate local test.

Public GLB URL:

`GET /v1/analysis/jobs/{jobId}/people/{personIndex}/interactive-static/{candidateId}/{sha256}`

## Prepared hands

`GET .../interactive-state/{operationId}/variants` is available only for a current ready operation. It returns bounded owner-bound exact hand variants previously certified against their final FBXs, with atlas/state/revision headers. Each new hand selection still requires a fresh current receipt for download. Local combinations are prediction-only; no arbitrary personal FBX/CS3C capability or universal 79-preset cache is advertised. Unknown/uncached combinations wait for solve. Client preparation has aggregate memory/queue budgets.

## Converter transport and deployment boundary

Internal paths are versioned `/interactive/v1/solve`, `/snapshots/{id}/{model,file,variants}`, `/snapshots/{id}/export`, `/cancel` and read-only `/static/resolve`, `/static/{sha}`. Every request carries the configured service bearer token; snapshot bytes also carry opaque `X-Standin-Owner`. No token is placed in a URL, response, operation identity or log. Responses are streamed under a 64MiB cap and status/length failures return bounded protocol errors without upstream private text.

The v2 adapter freezes a private FBX once after refine/shape/hands/crop, establishes the display packet from its import, and uses those same immutable bytes for independently verified export. This avoids repeated FBX split-normal quantization without weakening the comparison. Exact search rotation and normalized projection plus fixed server scope framing are included in the packet. Initial/intermediate FBX dependencies remain.

Converter's local private store is single-instance with TTL/capacity/byte budgets and restart revocation. This is not a distributed artifact backend. Production PostgreSQL, replicated workers and native OS/CSP import remain deployment acceptance checks. Flags remain off by default; these PRs do not deploy or merge.

## Binary solved state (standin-binary-f64le-v2)

Why: the typed-JSON v1 state (`{"$f64": ...}` per float) of a production body is ~51.7MB, and the
BFF spent 15–33s of its 0.5 vCPU parsing and validating it (`artifact_packet_validation`), which also
stalled status polling. The binary encoding has the same logical content (lossless) and is defined
by the Converter in `Standin-server/docs/INTERACTIVE_STATE_BINARY_V2.md`.

Negotiation (per operation, decided at prepare and stored as `requestedStateEncoding` in the operation row):

| Client header `X-Standin-Interactive-Protocol` | `INTERACTIVE_BINARY_STATE` | Operation encoding |
|---|---|---|
| `pose-body-only-v1` (today's clients) | any | `typed-f64be-json-v1` |
| `pose-body-only-v1, solved-state-binary-v2` | `1` (default) | `standin-binary-f64le-v2` requested |
| `pose-body-only-v1, solved-state-binary-v2` | `0` | `typed-f64be-json-v1` |

The encoding actually published is stored as `stateEncoding` in the same update as `stateHash` and
never changes. A missing `stateEncoding` means v1: operations from before this change, and states
published by an older BFF replica during a rolling deploy or rollback (it solves without the header
and does not know the field). A missing `requestedStateEncoding` also means v1. The public operation
JSON is unchanged; clients choose a decoder from the `/model` `Content-Type`.

Rollout safety for clients: a BFF older than this change accepts only the exact header value
`pose-body-only-v1` and answers 426 to a token list. The analysis job result therefore advertises
`capabilities.solvedStateBinary = {protocolToken: "solved-state-binary-v2", mediaType, available}`
(only when `interactiveState.available`; a separate key because clients parse `interactiveState`
strictly). A client that adds the token only after seeing this key, and only on the interactive
routes that use it (prepare and `/model`), stays working if the BFF is rolled back.

Preview tick for a binary operation:

1. `POST /interactive/v1/solve` with `X-Standin-State-Encoding: standin-binary-f64le-v2`. Without it the
   request is byte-identical to before. The switch is checked again here, so `0` also stops queued work.
2. If the packet's `canonicalEncoding` is `typed-f64be-json-v1` (older Converter, or the Converter's own
   `CONVERTER_INTERACTIVE_BINARY_STATE=0`), the unchanged v1 validation runs and the operation is
   recorded as v1 (`artifact_state_encoding_fallback` metric). An echoed `X-Standin-State-Encoding`
   that contradicts the packet fails closed.
3. Otherwise the metadata packet is strict: `{schema, operation, revision, stateHash, previewState,
   exportState, canonicalEncoding, stateBytes, modelSha256}` with no `canonicalState`, bound to the
   operation id and revision like v1.
4. `GET /snapshots/{id}/model` must answer `application/vnd.standin.solved-pose-state-v2` with exactly
   `stateBytes` bytes. The vendored `readSolvedStateV2` verifies `SHA256(bytes) == stateHash`, decodes
   canonically and validates geometry (bone hierarchy, bounds, indexes, strictly increasing skin bone
   ids, normalized weights, zero padding, no trailing bytes). The BFF then runs the same identity schema
   and `checkIdentity` as v1, the v1 200-character name bounds, and the skin pin (mesh name, vertex
   count, bone count, `SHA256(triangleIndexJson(triangles))` = the existing `trianglesSha256`).
5. `snapshotProof = {identityHash, modelSha256, runtimeRevision}` where `modelSha256` is the decoded
   v2 model digest and must equal the packet's `modelSha256`. Export receipts keep the existing check
   `packetModelSha256 == snapshotProof.modelSha256`.

Hash definitions (binary): `stateHash = SHA256(all state bytes)`; `modelSha256 = packetModelSha256 =
SHA256(bytes from the "STNDMDL2" magic to the end)`. v1 is unchanged: `stateHash = SHA256(canonicalState
ASCII)`, `modelSha256 = SHA256(canonical typed-JSON model)`. A v1 receipt never matches a v2 proof.

Client delivery: `GET .../interactive-state/{operationId}/model` for a binary operation returns the
Converter bytes after re-checking `SHA256(bytes) == stateHash` (no decoding), with
`Content-Type: application/vnd.standin.solved-pose-state-v2` and the same `X-Standin-State-Hash`,
`X-Standin-Revision` and `Cache-Control: private, no-store` headers. A request without the
`solved-state-binary-v2` token gets `426 INTERACTIVE_PROTOCOL_REQUIRED` instead of bytes it cannot read.
v1 operations keep `application/vnd.standin.solved-pose-state-v1+json`.

Hand variants: the Converter has no v1 hand atlas for binary states and answers 409
`VARIANTS_UNAVAILABLE`; the v1 atlas was already always 409 for production bodies (60MB budget). For a
binary operation the BFF answers the same `409 CONVERTER_INTEGRITY` that clients already receive,
after the usual ready/ownership/selection checks and without calling the Converter.
`POST .../selection-preview` stays v1.

Operator switch: `INTERACTIVE_BINARY_STATE` (default `1`; only `0`/`1`/`true`/`false`, otherwise
startup fails). `0` makes new and still-solving operations v1; already published binary operations
keep serving their bytes. The Converter has its own `CONVERTER_INTERACTIVE_BINARY_STATE`.

Vendored reader: `src/interactive-state/shared/interactive_pose_v2.mjs` is the Converter's
`converter/shared/interactive_pose_v2.mjs` byte-for-byte (`PROVENANCE.txt` pins its SHA256;
`scripts/copy-vendored.mjs` refuses to build on a mismatch and copies it into `dist`).
`interactive_pose_v2.d.mts` is the BFF's own type declaration.

## Validation

- Existing BFF full regression plus private transport credential/owner/revision/path/stream-size/length tests.
- Binary state (`packetV2.test.ts`, `service.test.ts`, `protocol.test.ts`, `converter/interactive.test.ts`): vendored reader SHA, the Converter's lossless v2 re-encoding of the v1 fixture (same identity proof, v2 model digest, same skin triangle digest), tampering (hash, length, model digest, operation/revision, identity, geometry, trailing bytes, skin pin), v2 receipt binding, Converter v1 fallback, operator switch, pre-existing operations, `/model` headers/426, variants 409, header token parsing. Fixture only; not a real Blender/production measurement.
- Real client HTTP → Hono routes/PGlite SQL queue → live private Converter → authoritative packet → independent export/reimport → receipt/SHA download → cancel denial. PGlite does not emulate PostgreSQL advisory locking.
- Actual recorded v2.5.4 refine and hand change match final FBX exactly; 13 male/female/scope/extreme/mirror cases have zero joint/vertex/skin/normal error.
- Actual five Top5 GLBs prebuilt and hash-verified. Cached hand input-to-GPU-complete p95 19.6ms, 40 warm samples in one local Chrome run; excludes server/network/display presentation. This is not an uncached export latency improvement claim.
- No licensed source/output asset, source controller, secret or private observation bytes are included in git.

## Staging activation (2026-11-07)

Staging uses a dedicated Secrets Manager `standin/staging/converter-interactive-token`
reference as `CONVERTER_INTERACTIVE_TOKEN` on both BFF and Converter. Each staging
execution role has GetSecretValue for that exact ARN only. Converter additionally
requires `CONVERTER_INTERACTIVE_ENABLED=true` and a private writable
`CONVERTER_INTERACTIVE_ROOT=/tmp/standin-interactive-private`. Its local snapshots
are intentionally revoked on task restart; no shared volume or distributed worker
claim is made. Enable BFF `INTERACTIVE_STATE_ENABLED=true` only after provisioning
the Converter. Static Top5 assets remain optional; selection preview solves on demand.

The BFF staging deployment preserves task secret wiring and, when environment variable
`INTERACTIVE_STATE_ENABLED` is explicitly configured, validates private URL/secret
wiring before setting the flag. An absent variable preserves the current task flag.
The Converter workflow also inherits its live task environment/secret references.
Production defaults and deployment configuration are unchanged. Rollback disables the
BFF flag first, then the Converter flag; retained secret references are harmless.

## Production promotion (2026-11-12)

The main promotion enables the same approved product transport with `standin/production/converter-interactive-token`, provisioned by the infra PR. It uses production body manifests, the reviewed Converter image, and a single private Converter replica. The main deployment verifies the current production body/default/credential and explicit replay storage before updating tasks. Client release builds enable the interactive capability negotiation in production as well as staging. RC4 stays disabled. No staging credential or endpoint is copied. See `DEVELOP_MAIN_PROMOTION_2026-11-12.md` for rollout order.
