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

## Validation

- Existing BFF full regression plus private transport credential/owner/revision/path/stream-size/length tests.
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
