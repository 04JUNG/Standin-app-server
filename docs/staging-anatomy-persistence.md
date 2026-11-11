# Staging anatomy release persistence — 2026-11-11

The approved pre-face anatomy release uses male `male-base-v0-8-0` (authoring v5.4) and female `female-base-v0-4-0` (v5.1). Old asset IDs remain immutable for saved custom bodies and explicit historical choices.

An export on November 11 still resolved `male-base-v0-7-2`: its captured `last_used` preference outranked the correctly registered new default. Deployment-only anatomy code was also absent from subsequent develop images. Both the selection migration and the earlier thumbnail/pose-transfer code must be merged into develop.

Known, unshaped old male/female BASE preferences now resolve to the corresponding approved default. Existing inherited `last_used` selections migrate on read with a compare-and-swap update and exactly one selection revision increment. Concurrent manual changes win. The revision and body hash invalidate stale preview/export receipts. Manual selections, numeric controls, named cards, presets and captured first-use historical fallbacks remain unchanged.

`scripts/verify-staging-anatomy.mjs` rejects develop deployments whose current task lost the approved manifest hash, catalog path, default ID or initializer success dependency. Intentional future anatomy releases must update that guard in source and pass CI. ECS health-triggered rollback remains enabled.

Validation: real PostgreSQL semantics via PGlite exercise the reported persisted selection path, repeat reads, stale revisions, ownership and explicit historical choices. Existing body, hand catalog and model-card tests cover compatibility. Live verification must use the existing job selection path, not only direct requests with the new model ID.
