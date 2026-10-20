# Final review pairs across BFF replicas

The final preview and FBX download can reach different BFF tasks. A process-local
cache alone lets the second task render another FBX. Exporter metadata can change
the bytes even for the same pose; its review key then differs from the PNG the
author already confirmed and the download returns `MANUAL_REVIEW_REQUIRED`.

Pinned review pairs now use a private immutable S3 object under
`installations/{installationId}/jobs/{jobId}/framed/{cache-key-sha256}.json`.
The object contains both PNG/GLB and FBX bytes, their hashes, and lineage. Reads
verify the key and both hashes. Conditional creation (`If-None-Match: *`) selects
one canonical pair if replicas render concurrently; both return that winner.
The bounded process-local cache remains the fast first layer. Replicas and task
restarts load the same stored pair without another conversion.

Only requests with pinned character and exporter identities persist pairs. The
key includes owner/job, pose/BVH, camera, scope, body/shape and hand revisions,
runtime/character identity, framing and solver versions. Existing ownership,
confirmed selection, source, quarantine and revision checks still run before and
after cache access. There are no public URLs or additional export permissions.

The existing `BETA_DATA_BUCKET` and task-role GetObject/PutObject permissions are
used. Bucket configuration is required in production; storage failures do not
publish an unpersisted preview receipt. Local development without a bucket keeps
the existing in-memory behavior. No environment-variable values are committed.

Pairs share the job/installation prefix with input and refined artifacts, so
existing job deletion, installation deletion and the bucket's 90-day lifecycle
cover them. In-memory expiry does not invalidate a persisted pair: revision keys
isolate changes and authorization still enforces job availability/retention.

## Validation and rollout

- Regression tests use separate cache instances and a restarted instance with a
  shared store, concurrent different FBX byte sequences, corruption, read/write
  failures, owner/job isolation and changed revision keys.
- Existing framed route tests retain source, scope, body, hands, confirmation,
  quarantine and receipt rejection checks.
- Staging reproduction: native dev.257, natural query `공을 던지는 자세`, 38th
  candidate, job `job_edd3d11e-5fa4-4966-bf9e-321d099488f3`. Final preview returned
  200 in 13.913 s on one BFF task; download returned 409 after another 13.930 s on
  another task. Returning to review and saving again also failed.
- This fix requires deployment and a fresh installed-app E2E against multiple
  tasks. Local tests do not establish a staging pass. Previously issued receipts
  may require returning to review once after deployment.
