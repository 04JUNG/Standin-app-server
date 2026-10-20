# v4 scene preparation in the save flow

Default off. Requires `FBX_EXPORT_ENABLED=true`, `SCENE_EXPORT_ENABLED=true`,
`SCENE_REFINEMENT_ENABLED=true`, and a private `SCENE_REFINEMENT_BASE_URL` plus
`SCENE_REFINEMENT_TOKEN` (32+ characters). The separate upstream worker is
`Standin-server/src/scene_refinement`. Keep its API internal. Its own request
budget is `SCENE_REFINEMENT_TIMEOUT_MS` (default 900000); `/analyze` is unchanged.
A job without a retained original input does not advertise scene refinement.

1. The client supplies the same reviewed per-person references used by basic
   scene export, plus `prepare: true` to `POST /v1/analysis/jobs/:id/scene`.
2. Existing ownership, confirmed selection, export route and file SHA checks run.
   The BFF loads only the owned job's original input. Inference freshly proposes
   directions, scope, registered base poses and owned arm/interaction goals.
3. Every proposed BVH passes the existing library gate. Full sources are converted
   with the selected body, shape and hands, then the scene worker crops and fits
   the final scene. A different uncalibrated body fails; no master substitution.
4. The BFF revalidates the original job/reviews and pins the final FBX and its PNG
   under an owner/job/source bound 15-minute `reviewKey`. The preparation response
   includes `version`, `artifactSha256`, `previewSha256`, `previewBase64`,
   `personCount`, and a path-free change summary.
5. The client shows the scene and requires explicit confirmation. Download posts
   the same original references and `reviewKey`. Source/body/hand checks run again,
   and exactly the pinned file is returned with version `scene-refinement-v4`.
   The client verifies its SHA against the reviewed artifact before native save.

Expired receipts, changed selections, changed bytes or process restarts require
another review. The public client cannot provide yaw, joint coordinates, paths,
new pose IDs, body overrides or a scene placement manifest. The original scope
and candidate export gates remain intact; preparation is an isolated derived
scene review. Disabling refinement preserves the existing `rough-layout-v1` path.

The local 3-cut comparison exercises real scene inference, Converter and this
route with fixed owned-job/confirmed-review fixtures. It does not establish that
the installed staging app or CSP adopts the embedded camera. Exact CSP framing
and deployment remain separate validation steps.
