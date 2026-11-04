# Proportional default bodies: integration contract

This change prepares catalog-driven male 8.3 / female 8.0 defaults and preserves the previous bases as separate choices. It does not deploy, activate flags, mount assets, migrate installation rows or repoint existing character IDs. The model/converter session owns measured models, asset approval and `model-manifest.json`.

## Authoritative entry points

| Entry | Current authority | Rollout behavior |
| --- | --- | --- |
| New installation/job, `last_used` with no usable history | `body-selection/model.ts` `snapshot` → `firstUseBody` | Role-aware catalog: exact `defaultCharacterId` with `gender=male,role=default`. Capture full BodyRef at job creation. Older role-free catalogs retain first `male-base-*` behavior. |
| New job with usable `last_used` | Captured `lastUsed` BodyRef + numeric controls | Preserve the previous base or personal shape. No preference/revision write. |
| `auto`, or per-person explicit `auto` | `mapBodyRecommendations` + eligible upstream recommendation | Preserve existing auto policy. Model/inference owns base/presentation recommendation and preset registry. Unsupported recommendation uses the captured common male fallback. No gender inference or remapping of arbitrary recommendations here. |
| Candidate body gender filter | Body options presentation | Filter only; changing the tab does not change a selection. Explicit card PUT chooses that exact ID. |
| New custom card / gender change in editor | Operator default role for that gender | Start from the matching default. Explicit `?base` and existing personal cards retain their chosen IDs/controls. |
| Reopen existing jobs | Stored selection and captured job policy | Preserve identity and revision. Pre-capture historical fallback rows use their stored BodyRef when adopting role metadata. Missing/changed assets stay unavailable. |
| Legacy non-body export / hands / thumbnail | `CONVERTER_CHARACTER_ID`, converter registry | Remains independently configured; mounting a catalog must not silently change the legacy default. A later approved release must coordinate this env setting with registry and all affected preview contracts. |
| `/v1/models` | Converter availability + approved body catalog presentation | Add catalog-only rows as `coming_soon`, use catalog names/gender/order/role; never make a missing converter asset available. `isDefault` and top-level default remain the legacy converter default. |
| Final FBX | Stored BodySelection → framed review → reviewKey | BodyRef, shape/source, body/hand revision, refined BVH, runtime, scope and final file SHA remain strict. No UI label authorizes export. |

## Additive catalog fields

Each asset may declare `gender: male|female|child`, `role: default|previous_default|preset`, and nonnegative integer `order`. `displayName` remains user-facing Korean text. The BFF passes these fields through `body-options` and `body-preferences.shapeEditable`. `/models` also carries `role` and `order`, with male/female display gender (child remains unspecified in the older models contract).

If any role is declared, there must be exactly one male `default`; its ID must equal catalog `defaultCharacterId`. There can be at most one female `default`. Invalid roles, genders, ordering or conflicting defaults close the catalog. A missing declared default must never rediscover the preserved old `male-base-*` by array order. Role-free catalogs keep their existing behavior.

The model catalog must include **new distinct IDs** with actual measured FBX hashes plus unchanged old BASE IDs/assets/spec defaults/sources. Old bases receive `role=previous_default`, `displayName=기존 기본형`; new bases receive default roles and measured head-count names. Presentation metadata is excluded from BodyRef, render keys and file identity. The repository's empty catalog and feature flags remain unchanged.

## Cache and parallel integration audit

- Canonical Top-5 posters (`pose-posters.ts`) are existing read-only reference assets with `standin-master-v2` / frozen template / revision gates. This PR neither labels them as new-default results nor changes their expected hashes. New canonical posters require a separately approved versioned asset set. Initial candidate cards remain reference images; chosen-body final review is authoritative.
- Body preview keys already include exact BodyRef, shape/source, candidate source hashes/camera, output scope, hand revision/library and renderer revision. New character IDs and FBX hashes create different keys; old render URLs fail stale checks. Neutral PNGs require both exact character SHA and image SHA. Sampled runtimes must retain source controller/blend SHA and preset grid validation.
- Refine preserves pose identity until final body bake; changing default presentation alone cannot reuse an old FBX receipt as a new body. Final review and download revalidate body, hands, scope, source/refine and file SHA. BVH has no body mesh.
- Concurrent PRs inspected: client #173 `6fd099e8`, BFF #154 `29e2a455`, converter #167 `3d90db65` (2026-11-04). No code from those branches was merged. BFF overlap is API documentation only; body-selection metadata is a narrow additive interface. Their owner-bound static Top-5 assets must be rebuilt for new BodyRefs; no approved-character/hash allowlist is relaxed here. Recheck heads at integration time.

## Evidence boundaries

Synthetic tests prove policy, API metadata and stale/hash failures. Browser fixtures use product React components; when they display real neutral model PNGs that proves card source/layout only, not a real job export. Independent Blender reimport, measured ratios, actual body/hand/scope FBX and render comparisons belong to the model manifest. User visual approval and a separately authorized rollout are required before activation.

## Model handoff observed locally

The model session's review catalog uses distinct new IDs `male-default83-v0-7-6-p1` (FBX SHA `085dd9c65a3a66035f7e0ce9e0a9171b9abb0e33dada92194676d92e00c8b026`) and `female-default80-v0-3-9-p1` (`712ac75e58efd4d6ccded0b1e931590900015de023327f1320cf6d7d94026ffc`). These are manifest observations, not hardcoded runtime defaults. Actual editor previous IDs are `male-base-v0-7-2` / `female-base-v0-3-4`; authoring source BASE IDs are m076/f039. The live pinned catalog's legacy common `body-male-base` and converter `standin-master-v2` are a separate older fallback path. Retired fixed adult IDs remain retired even if a raw catalog labels them previous_default.

`BODY_SHAPE_EDIT_ENABLED=true BODY_DEFAULT_MANIFEST=<model-manifest.json> BODY_DEFAULT_BASE_CATALOG=<prior-pinned-catalog.json> node scripts/check-body-default-release.mjs` is a standalone **read-only** local check after `npm run build`. The flag affects only that short-lived check process, never a server. It compares actual new FBX/source bytes, converter registry hashes, original previous BodyRefs/specs/runtime, gender roles and auto/manual/last-used policies. It reports missing neutral/runtime assets and always reports activationAllowed=false; it does not claim a live HTTP conversion/download.
