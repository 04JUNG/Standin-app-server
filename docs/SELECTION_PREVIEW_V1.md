# Read-only selection preview v1

Draft addition on BFF #154 (`29e2a4559f964ec70b02fd83228f3a53ea63c085`), latest fetched develop `37adaa616b21ac49933974f73b56fbc5c575b0c2`. Uses existing Converter #167; no new solver or converter protocol. Client dependency: `codex/selection-large-preview-20261104` based on client #173.

`POST /v1/analysis/jobs/:jobId/people/:personIndex/selection-preview`, private/no-store, existing installation middleware and private interactive feature/transport gates. Request is strict `{candidateId, bodyRevision}`, maximum 4 KiB. Response is `{schemaVersion:"standin.selection-preview.v1", previewOnly:true, bodyRevision, packet}` with the existing validated canonical packet. No download URL, export receipt or stored operation is created. The job and semantic responses advertise optional `selectionPreview` only through the existing interactive opt-in.

The selection resolver uses all existing ownership, completed-job membership, release/quarantine, source, shape, character, hands, scope, camera and runtime checks. Its explicit server-only `purpose:"preview"` omits the confirmed-selection prerequisite and allows an existing preview-only body. Default purpose remains `export`: preview-only bodies and unconfirmed candidates still cannot be exported. Near/review-only candidates do not acquire release permission through this route.

The common worker solves in an isolated service-instance/owned-job namespace with monotonic server revisions. Therefore preview cancellation and preview revisions cannot cancel or supersede an export or another person's work. Same owner/job/person replacements abort and drain their predecessor. Bounds: two running solves, 16 total in-flight requests, 120-second signal/expiry, maximum existing packet budget. A full queue returns 429. The current server selection hash is resolved again after solve; changed/revoked selection blocks delivery. Every exit cancels the isolated snapshot; Converter expiry backs up failed cleanup. No private packet cache is retained. No source geometry, paths or credentials are logged.

Verification: full BFF suite 1,005 passed / 2 optional skips; build/typecheck. New tests cover unconfirmed/preview-only boundaries, quarantine/ownership, strict request/body size/flag, missing stored file authority, old revision, rapid replacement, in-flight mutation and cleanup. Actual shared local Converter run returned a validated approved male/full packet (9,430,240 response bytes), zero export calls and two successful cleanup calls in 6,506 / 4,122 ms (two consecutive local requests). That check injects an owned-selection resolver; it does not certify production PostgreSQL, native saving, Windows/CSP or instantaneous cold shape preparation. Existing initial/intermediate FBX dependencies stay intact. No deployment/merge/paid API calls.

Rollout remains off by default and both PRs stay Draft pending UI/integration review. This service uses the existing private single-instance transport assumptions; distributed admission control is outside the scope of the underlying #154/#167 contract.

Manual reviewed candidates keep their explicit `pose-preview-camera-v1` descriptor.
The BFF adds the SHA of the server-validated original BVH as
`source_bvh_sha256` in the private interactive selection, just as search cameras
already carry it. This preserves rotation/projection and does not claim that a
fixed preview camera matches a searched projection. Converter must explicitly
support this descriptor; older search-only Converter versions reject it closed.

Unshaped registered bodies may still use a server-approved default shape recipe.
The resolver binds its rules version from the trusted body catalog only when both
character ID and asset SHA match, and includes that authority in the selection
hash. Packet validation uses explicit shape-source rules first; for a null shape
only, it can use those trusted default rules. A non-null shape without explicit
source provenance cannot use this fallback. Packet-provided rules never establish
expected authority.
