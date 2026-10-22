# Refine v3 private shadow relay

This branch adds an optional private relay for the inference `refine-shadow-v1` signed envelope. It does not enable regional refinement or change source BVH/FBX output, public candidate permissions, automatic review timing, or existing source cache keys.

`REFINE_V3_SHADOW=false` is the default. When explicitly enabled in an isolated evaluation, `extractRefineContexts` accepts a bounded envelope from inference `/analyze` only, persists it in the existing private `analysis_people.refine_context_json`, and `runRefine` forwards it from that database context as optional `refine_v3`. The public request still contains only selection identifiers. The public analysis result omits the envelope. Inference owns HMAC verification; this BFF parser validates transport shape/size, not semantic authority.

A malformed/missing envelope is discarded. The existing `refineAllowed` gate, selected candidate lookup, artifact cache, timeout/fallback, deferred preview, and exact accepted source BVH storage remain in force. Upper-only people do not acquire eligibility through this relay. Shadow output must never be stored as an accepted artifact. No client change is required for this private phase. Product target/profile/body/shape/hand revision caching and new regional eligibility require a later negotiated contract after actual Converter/profile certification; this PR does not claim to implement them.

Inference companion: `Standin-server` branch `codex/refine-v3-integration-20261022` (develop base `7a3713f7`). Envelope payload version is `refine-shadow-v1`, signature is lowercase SHA256 hex, and encoded size is at most 65,536 bytes. The inference signing secret is never forwarded or stored by the BFF.

Validation: `npm test` 741 passed, 2 skipped; focused mapping/refine tests 41 passed; TypeScript build passed. No deployment, flag activation or main merge performed.
