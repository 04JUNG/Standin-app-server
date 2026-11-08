# Consented web-to-app journeys (2026-11-09)

This adds `journeys` to the authenticated `/v1/admin/marketing?days=1..90` response and the existing 30-second marketing dashboard refresh. Failure is `null`/unavailable, never an invented zero. Individual installation rows require the new journey consent; existing operational totals remain aggregate-only.

## Contract

- `POST /v1/web-analytics/visitors`: `{consent:true,version:"2026-11-09"}` creates a 90-day visitor capability. Only its SHA-256 hash is stored.
- `POST /events`: `{token,events:[{id,page,sequence,name,at,path,section,target,creative,source,device,elapsedMs,depth}]}` under the same prefix. Strict allowlists in `src/journey/contract.ts`, max 30 events/24 KB, last 24 hours, max 10,000 events per visitor. `elapsedMs` is an interval delta, not a cumulative counter. Event UUID and page sequence make retries idempotent.
- `POST /handoff`: `{token}` returns a separate one-use 30-minute capability. Only its hash is stored. The latest link supersedes earlier unclaimed links for that browser.
- `POST /revoke`: `{token}` stops that visitor, deletes web/app events and handoffs, and unlinks installations. A hash/tombstone remains only until the original expiry to reject late requests. Revocation is not subject to the collection throttle.
- Web routes accept exact production site Origins, reject query strings, omit credentials and referrers, and terminate before application request/identity logging. No IP/fingerprint key is retained for throttling. The bounded per-process throttle is abuse mitigation, not proof of genuine people.
- Installation-authenticated `GET/POST/DELETE /v1/installations/current/journey`: read link, explicitly consent with `{token,consent:true,version}`, or revoke. Revocation wipes app-stage events. Reconsent issues a new receipt; old queued events cannot attach to it.
- `POST /v1/installations/current/journey/events`: `{receipt,events:[{id,name,at}]}`. Fixed stage names only. No event properties, job IDs, texts, file paths or content. Receipt ownership, expiry, current visitor/install consent and event time after consent are enforced transactionally.

## Interpretation and retention

The dashboard labels browser visitors, download clicks, connected apps and server-observed analysis separately. Counts are not a sequential conversion funnel: an existing installation can connect, and a downloaded installer may never be run. Anonymous creative counters and the previous optional advertising attribution are unchanged.

Only visible/focused, recently active time is credited. Section time is exclusive, summed from deduplicated deltas; the last sub-second interval or unload batch can be lost. Last observed section means 30 minutes with no new observation, not proven exit intent. Multiple tabs/browser profiles/devices are not deduplicated into a person. No retroactive joining or pre-consent replay. Direct installer launch cannot join an individual browser visit; v0.2.8 creative-level package counts still work.

Web visitor expiry caps connected app expiry. Expired/revoked rows are excluded immediately; maintenance deletes visitors, links and handoffs. Installation deletion cascades linked app records. Web and app UI withdrawals explicitly describe which records they delete; basic service jobs retain their existing independent lifecycle.

## Deployment and verification

Deploy the additive server schema/routes first, then landing consent/legal changes, then approved client v0.2.9. The landing enables individual handoff only when the public release supports it. Older apps keep campaign-only handoffs. Do not publish a client release before its repository review/build gates pass.

`npm test` includes PGlite integration checks for actual schema/query semantics, ownership, one-time handoff, duplicate suppression, no pre-consent attribution, expiry/withdrawal, display escaping and route CORS/auth. Client and landing repositories contain matching consent/idle/race tests. Production verification must use an explicit test visitor and test installation, then revoke/delete the test journey. Do not fabricate production conversions or reuse real visitor records for testing.
