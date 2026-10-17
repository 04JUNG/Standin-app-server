import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";
import {
  mapPosePresentation,
  createPresentationRoutes,
} from "./pose-presentation.js";
import { mapCutResult, extractRefineContexts } from "./mapping.js";
import type { CutResult } from "./inference.js";
const bvh =
  "HIERARCHY\nROOT Hips\n{}\nMOTION\nFrames: 1\nFrame Time: 0.033333\n0\n";
const hash = createHash("sha256").update(bvh).digest("hex");
const id = "preview_" + "a".repeat(64),
  gid = "preview_" + "b".repeat(64);
const camera = {
  version: "pose-preview-camera-v1",
  projection: "orthographic",
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  yaw_degrees: 0,
  pitch_degrees: 0,
  roll_degrees: 0,
  distance_torso: null,
  basis: "right-handed-Y-up",
  rotation_order: "Rz@Rx@Ry_column_vectors",
  origin: "hip_midpoint",
  scale: "hip_to_shoulder_midpoint_length",
  screen_y: "down",
  projection_rule: "xy=(x,-y)",
  projection_matches_search: false,
  fit_to_rough_pixels: false,
  bvh_camera_rotation_applied: false,
};
function candidate(generated = false) {
  return {
    candidate_id: generated ? gid : id,
    pose_id: generated ? null : "test pose",
    source: generated ? "generation" : "library",
    kind: generated ? "generated_review" : "library_match",
    rank: 1,
    camera_kind: "viewer_default",
    render_camera: camera,
    score_kind: null,
    rank_score: null,
    score_is_accuracy: false,
    lookup_allowed: true,
    review_required: true,
    auto_apply_allowed: false,
    refine_allowed: false,
    export_allowed: false,
    release_allowed: false,
    actual_mesh_validated: false,
    asset: {
      transport: generated ? "inline_bvh" : "library_bvh",
      bvh_url: generated ? null : "/pose/test%20pose/bvh",
      bvh: generated ? bvh : null,
      bvh_sha256: hash,
      library_lookup_supported: !generated,
      encoding: generated ? "utf-8" : null,
    },
  };
}
function raw() {
  return {
    version: "dynamic-pose-presentation-v1",
    source: "dynamic_search",
    person_index: 0,
    route: "hybrid",
    status: "ready",
    search_status: "ok",
    search_reason: null,
    generation_status: "preview_ready",
    generation_reason: null,
    output_scope: "full",
    unobserved_body_is_default: null,
    library_candidates: [candidate()],
    review_candidates: [],
    generated_candidates: [candidate(true)],
    basic_model: null,
    issues: [],
    preview_status: "ready",
    auto_apply_allowed: false,
    refine_allowed: false,
    export_allowed: false,
  };
}
function cut(value: unknown): CutResult {
  return {
    route: "core",
    count_confidence: "high",
    detector_count: 1,
    vlm_count: 1,
    people: [
      {
        index: 0,
        box: null,
        tags: {},
        skeleton: null,
        confidence: "high",
        refine_allowed: true,
        candidates: [],
        dynamic_search: {
          version: "fullbody-dynamic-v1",
          route: "hybrid",
          status: "ok",
          selected: [],
        },
        pose_presentation: value,
      },
    ],
    notes: [],
    image: { width: 100, height: 100 },
    inference_metadata: {
      deployment_version: "test",
      vlm_provider: "mock",
      vlm_model: "mock",
      pose_backend: "mock",
      pose_model_version: "mock",
      pose_library_version: "v1",
      feature_version: 1,
    },
  };
}
test("authoritative presentation preserves groups/counts while private assets never enter public JSON", () => {
  const result = mapCutResult("job", cut(raw())),
    p = result.candidatesByPerson[0];
  assert.equal(p.candidateCount, 2);
  assert.equal(p.fallbackMode, "soft");
  assert.equal(p.refineAllowed, false);
  assert.equal(p.posePresentation?.generated_candidates[0].pose_id, null);
  assert.equal(p.routedSearch, undefined);
  const text = JSON.stringify(result);
  assert.ok(!text.includes("HIERARCHY"));
  assert.ok(!text.includes("/pose/test%20pose/bvh"));
  assert.equal(
    extractRefineContexts(cut(raw()))[0].posePresentationAssets?.[gid].bvh,
    bvh,
  );
});
for (const change of [
  "version",
  "index",
  "policy",
  "url",
  "hash",
  "source",
  "camera",
]) {
  test(`rejects ${change} without falling back to dynamic_search`, () => {
    const r = raw();
    if (change === "version") r.version = "future";
    if (change === "index") r.person_index = 1;
    if (change === "policy") r.library_candidates[0].release_allowed = true;
    if (change === "url")
      r.library_candidates[0].asset.bvh_url = "https://external.invalid/bvh";
    if (change === "hash")
      r.generated_candidates[0].asset.bvh_sha256 = "0".repeat(64);
    if (change === "source")
      r.generated_candidates[0].pose_id = "library-spoof";
    if (change === "camera")
      r.library_candidates[0].render_camera = {
        ...camera,
        rotation: [
          [-1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      };
    const p = mapCutResult("job", cut(r)).candidatesByPerson[0];
    assert.equal(p.posePresentation?.status, "error");
    assert.equal(p.candidateCount, 0);
    assert.equal(p.routedSearch, undefined);
  });
}
test("null and omitted values retain old routing", () => {
  assert.equal(mapPosePresentation(null, 0, "job"), null);
  assert.equal(mapPosePresentation(undefined, 0, "job"), null);
  assert.equal(
    mapCutResult("job", cut(null)).candidatesByPerson[0].routedSearch?.version,
    "fullbody-dynamic-v1",
  );
});
for (const status of [
  "no_result",
  "error",
  "partial_error",
  "generation_failed",
  "basic_reference",
]) {
  test(`preserves separate ${status} search and generation states`, () => {
    const r = raw();
    r.status = status;
    r.search_status = status === "error" ? "error" : "no_result";
    r.generation_status =
      status === "generation_failed" ? "rejected" : "not_requested";
    const p = mapPosePresentation(r, 0, "job")!.presentation;
    assert.equal(p.status, status);
    assert.equal(p.generation_status, r.generation_status);
  });
}
test("owned preview endpoint binds person/candidate/hash and never library-looks-up generated BVH", async () => {
  const mapped = mapPosePresentation(raw(), 0, "job")!;
  let libraryCalls = 0;
  let changed = false;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "req");
    await next();
  });
  app.route(
    "/",
    createPresentationRoutes({
      getOwnedJob: async (job, owner) =>
        job === "job" && owner === "owner"
          ? ({
              status: "completed",
              result: {
                candidatesByPerson: [
                  { personIndex: 0, posePresentation: mapped.presentation },
                ],
              },
            } as Job)
          : undefined,
      loadAssets: async () => mapped.assets,
      getPoseBvh: async (pid) => {
        assert.equal(pid, "test pose");
        libraryCalls++;
        return new Response(changed ? "changed" : bvh);
      },
    }),
  );
  const url = (job: string, cid: string, h = hash, index = 0) =>
    `/${job}/people/${index}/pose-previews/${cid}/${h}`;
  assert.equal(await (await app.request(url("job", gid))).text(), bvh);
  assert.equal(libraryCalls, 0);
  assert.equal(await (await app.request(url("job", id))).text(), bvh);
  assert.equal(libraryCalls, 1);
  for (const u of [
    url("foreign", id),
    url("job", gid, "0".repeat(64)),
    url("job", id, hash, 1),
  ])
    assert.equal((await app.request(u)).status, 404);
  changed = true;
  const r = await app.request(url("job", id));
  assert.equal(r.status, 409);
  assert.equal(
    ((await r.json()) as { error: { code: string } }).error.code,
    "PREVIEW_HASH_MISMATCH",
  );
});
