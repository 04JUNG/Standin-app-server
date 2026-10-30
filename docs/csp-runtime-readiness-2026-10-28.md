# CSP runtime observations and configuration proposal — 2026-10-28

Read-only AWS checks, account `136889124221`, region ap-northeast-2. No deployment, task revision registration, desired-count, live flag or secret changes. Current configuration, historical request logs and local code validation are separate evidence.

## Current runtime

- Staging BFF task definition `StandinStagingAppBffTask81742392:92`: deployment/image tag `264da73294695da800345dc1e814d11fced7b20b`; desired/running 1/1; primary rollout completed.
- `FBX_EXPORT_ENABLED=true`; Converter URL present (value not output).
- `SCENE_EXPORT_ENABLED` and `SCENE_REFINEMENT_ENABLED` absent in environment and secret-name list; no environmentFiles. This source defaults both to false. No container-process environment override probe was performed.
- Analysis worker task revision 36, desired/running 0/0. That fact does not prove a distinct scene-v4 worker exists or is ready, nor does it establish why a particular analysis timed out.

## Historical experiment window

BFF CloudWatch group queried for 2026-10-28 **17:05–17:50 KST**, including the reported 17:14–17:41 experiment. Only structured route/status/code/duration/job/request fields were retained. Raw messages, input bytes and secret values were not emitted or retained.

- Known T001 job `job_2a03f178-d2cc-468a-be47-de49eec8907c`: 4 successful `GET /v1/pose-candidates/:id/framed` requests at 17:17:38, 17:17:42, 17:17:48 and 17:18:24 KST (12325/3811/580/704 ms).
- Known T015 job `job_811eb250-640e-4915-9c35-73fb04d879e7`: 3 successful framed requests at 17:22:31, 17:22:34 and 17:22:52 KST (13876/3304/1082 ms).
- The BFF log-group `/scene` filter returned zero events in that window. This supports individual framed-path usage in the observed logs, but the old route logs do not retain query `format` or binary SHA: a framed request may be ready/preview/FBX. They do **not** prove the exact downloaded bytes, completed client disk saves, camera content, or what capability body the app received. Current flags alone are not retroactive proof of historical configuration.
- 3 BFF `ANALYSIS_TIMEOUT` failures occurred at 17:25:28 / 17:32:09 / 17:40:03 KST, with durations 120008 / 120006 / 120007 ms. Job suffixes `...d4361d0d`, `...d55e4857`, `...34bdcb82`. These are analysis-phase failures. Input hashes were not supplied; their mapping to p060/p0718 is unverified. The logs do not establish whether upstream work stopped after BFF timeout.

## Configuration ownership proposal (not applied)

Keep runtime scene/Converter configuration owned by **Standin-infra ECS task definitions**, with explicit per-environment values. Current `.github/workflows/deploy.yml` downloads the service's task definition and overrides a limited set of env values; FBX/scene/Converter values are outside that list, so it preserves whatever is already in the active task definition, including absence. GitHub Variables alone are not effective configuration.

Proposed separate infra change:

1. Declare `FBX_EXPORT_ENABLED`, `SCENE_EXPORT_ENABLED=false`, `SCENE_REFINEMENT_ENABLED=false` explicitly in staging and beta task definitions; keep Converter internal URL, v4 internal URL and token references in infra-owned configuration. Do not duplicate scene flag ownership in GitHub Variables.
2. Preserve those named environment entries and secret references when CI renders new BFF/worker images. Add infra/deploy tests that rendering changes the image/deployment version without dropping or unintentionally enabling them. URL/token values must never be printed; checks compare names/presence only.
3. Enabling basic integration is a separate reviewed infra rollout after an authorized fresh-job/Converter/installed-app check. v4 remains independently off until calibrated worker/asset readiness is established. Document rollback to explicit false. This PR changes no deploy workflow or live config.
4. Compare runtime task revision/image, result capabilities, structured scene operation path/counts, client persisted SHA, and actual CSP import before declaring success. Metadata availability is not automatic CSP camera application.

The implementation documents this proposed ownership and preservation model; it does not modify the infra repository, deploy it, or claim those future tests have run.
