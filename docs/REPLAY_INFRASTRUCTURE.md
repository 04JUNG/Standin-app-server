# Replay infrastructure proposal (not applied)

No AWS resource, IAM policy, service environment, workflow or database in a running service
was modified. Local verification uses PGlite and a local private directory only.

A future deployment needs a dedicated private S3 bucket and an application-scoped role.
Pass its name through `REPLAY_BUCKET`; use `REPLAY_ENVIRONMENT=staging` only for a confirmed
staging service. Production assumed mode must remain denied. The existing Docker image
already runs `npm run build`, which now bundles the player. No CDN or extra hosted site is needed.

Illustrative CloudFormation (review and adapt in Standin-infra; do not apply from this PR):

```yaml
ReplayBucket:
  Type: AWS::S3::Bucket
  Properties:
    PublicAccessBlockConfiguration:
      BlockPublicAcls: true
      IgnorePublicAcls: true
      BlockPublicPolicy: true
      RestrictPublicBuckets: true
    OwnershipControls:
      Rules:
        - ObjectOwnership: BucketOwnerEnforced
    BucketEncryption:
      ServerSideEncryptionConfiguration:
        - ServerSideEncryptionByDefault:
            SSEAlgorithm: AES256
    # Do not enable versioning without also removing noncurrent copies on explicit deletion.
    LifecycleConfiguration:
      Rules:
        - Id: MaximumReplayLifetime
          Status: Enabled
          Prefix: replays/
          ExpirationInDays: 14
          AbortIncompleteMultipartUpload:
            DaysAfterInitiation: 1
```

Deny all non-TLS access in a bucket policy. Grant only `s3:PutObject`, `s3:GetObject`,
`s3:DeleteObject` for `<bucket>/replays/*` and `s3:ListBucket` with prefix `replays/*`.
No public ACL, `PutBucketPolicy`, CORS or S3 presign permission is needed. No client ever
receives S3 credentials or an S3 URL. Keep object versioning disabled for this new bucket;
if infrastructure enables versioning, extend deletion to version IDs and noncurrent versions
before use. S3 access/error metrics and bucket alarms should use aggregate dimensions only.

The existing PostgreSQL startup schema adds replay tables/indexes, a replay-withdrawal
marker and a transactional object-deletion trigger/outbox. Account for raw-event metadata
and storage volume during RDS capacity review. A minute BFF sweep handles earlier source
expiry/withdrawal/object deletion retries. The 14-day bucket lifecycle is a backstop, not
an implementation of prompt withdrawal or job deletion. Alert on oldest deletion-outbox age
and repeated object-delete failures; never log object bytes or recorded DOM.

An operator must review backup retention and object-version retention before introducing
real production content. This proposal makes no claim that deleted material is erased from
an existing infrastructure backup. No operational change or deploy is authorized here.
