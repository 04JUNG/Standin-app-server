import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";
import {
  mapPosePresentation,
  createPresentationRoutes,
  withBasicCloseupPreview,
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
test("close-up plan uses the existing cropped neutral template without adding candidates", () => {
  for (const scope of ["head", "shoulder_head"]) {
    const value = { ...raw(), route: "basic_model", status: "basic_reference", search_status: "ok",
      output_scope: scope, library_candidates: [], generated_candidates: [],
      generation_status: "not_requested", preview_status: "not_requested",
      basic_model: { status: "planned", output_scope: scope } };
    const mapped = mapPosePresentation(value, 0, "job")!;
    assert.deepEqual(mapped.presentation.basic_model?.preview, {
      version: "basic-closeup-preview-v1", scope,
      template_url: `/v1/pose-candidates/default-body-template/${scope}`,
      pose: "neutral", preview_only: true,
    });
    assert.deepEqual(mapped.assets, {});
    assert.equal(mapped.presentation.library_candidates.length, 0);
    assert.equal(mapped.presentation.export_allowed, false);
    assert.equal(mapped.presentation.preview_status, "not_requested");
    // Reading a persisted old result upgrades only the response, not stored data.
    const old: typeof mapped.presentation = { ...mapped.presentation, basic_model: value.basic_model };
    assert.equal(old.basic_model?.preview, undefined);
    assert.deepEqual(withBasicCloseupPreview(old), mapped.presentation);
    assert.equal(old.basic_model?.preview, undefined);
    for (const invalid of [
      { output_scope: "half" }, { status: "error" }, { search_status: "error" },
      { route: "semantic" }, { version: "semantic-pose-presentation-v1" },
      { export_allowed: true }, { issues: ["invalid_basic_model"] },
      { library_candidates: [candidate()] },
    ]) {
      const changed = { ...mapped.presentation, ...invalid } as typeof mapped.presentation;
      assert.equal(withBasicCloseupPreview(changed).basic_model?.preview, undefined);
    }
  }
});
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
  assert.equal(p.candidates.length, 2);
  assert.equal(p.candidates[0].id, id);
  assert.equal(p.candidates[0].source, "library");
  assert.equal(p.candidates[0].releaseAllowed, false);
  assert.equal(p.candidates[0].manualExportAllowed, true);
  assert.equal(p.candidates[0].sourceBvhSha256, hash);
  assert.equal(p.candidates[0].camera, undefined);
  assert.equal(p.candidates[0].distance, undefined);
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
    assert.equal(p.posePresentation?.search_reason, change === "version" ? "presentation_contract_unsupported" : "presentation_contract_invalid");
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

for (const status of ["blocked", "error", "not_run", "no_result"]) {
  test(`manual library choice preserves ${status} search failure without claiming validation`, () => {
    const value = raw();
    value.search_status = status;
    const person = mapCutResult("job", cut(value)).candidatesByPerson[0];
    assert.equal(person.candidates.length, status === "no_result" ? 2 : 1);
    assert.equal(person.posePresentation!.search_status, status);
    assert.equal(person.candidates[0].manualExportAllowed, true);
    assert.equal(person.candidates[0].releaseAllowed, false);
    assert.equal(person.candidates[0].actualMeshValidated, false);
  });
}

test("selected-body preview binds private library/generated sources, shape, scope and stale choices without release", async (t) => {
  const { config } = await import("./config.js");
  const before = config.bodyShapeBakeEnabled;
  Object.assign(config, { bodyShapeBakeEnabled: true });
  t.after(() => Object.assign(config, { bodyShapeBakeEnabled: before }));
  const { catalog } = await import("./body-selection/fixtures.js");
  const { resolveBody, snapshot, defaultPreferences } =
    await import("./body-selection/model.js");
  const { personBodyContext } = await import("./body-selection/store.js");
  const mapped = mapPosePresentation(raw(), 0, "body-job")!;
  const result = mapCutResult("body-job", cut(raw()));
  const context = personBodyContext(result.candidatesByPerson[0]);
  assert.equal(context.previewOnly, true);
  const cat = catalog();
  cat.assets[0].characterId = "male-base-v0-7-2";
  let selection = resolveBody(
    0,
    snapshot(defaultPreferences(), cat),
    { status: "disabled", body: null, reasonCodes: [] },
    cat,
    context.poses,
    "inherit",
    null,
    0,
    null,
    true,
  );
  assert.equal(selection.resolutionStatus, "ready");
  // The same unvalidated pose remains unavailable to the legacy release selection resolver.
  assert.equal(
    resolveBody(
      0,
      snapshot(defaultPreferences(), cat),
      selection.recommendation,
      cat,
      ["unvalidated-pose"],
    ).resolutionStatus,
    "unavailable",
  );
  let libraryCalls = 0,
    renders = 0,
    changeDuringRender = false;
  const runtime = {
    previewRevision: "c".repeat(64),
    modelRevision: "d".repeat(64),
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "req");
    await next();
  });
  app.route(
    "/",
    createPresentationRoutes({
      enabled: () => true,
      getOwnedJob: async (job, owner) =>
        job === "body-job" && owner === "owner"
          ? ({ status: "completed", result } as Job)
          : undefined,
      loadAssets: async () => mapped.assets,
      selection: async () => structuredClone(selection),
      checkCharacter: async () => "ok",
      getPreviewRuntime: async () =>
        runtime as Awaited<
          ReturnType<
            typeof import("./converter/previewRuntime.js").getPreviewRuntime
          >
        >,
      getPoseBvh: async () => {
        libraryCalls++;
        return new Response(bvh);
      },
      convertFramed: async (input) => {
        renders++;
        assert.equal(Buffer.from(input.bvhBytes).toString(), bvh);
        assert.equal(input.characterId, selection.resolvedBody!.characterId);
        assert.deepEqual(input.shape, selection.shape);
        assert.deepEqual(input.cameraRotation, camera.rotation);
        assert.equal(input.scope, "full");
        if (changeDuringRender)
          selection = {
            ...selection,
            selectionRevision: selection.selectionRevision + 1,
          };
        return {
          fbx: new Uint8Array(),
          preview: png,
          conversionId: "test",
          artifactSha256: "e".repeat(64),
          sourceBvhSha256: hash,
          characterSha256: input.expectedCharacterSha256,
          previewRevision: runtime.previewRevision,
        };
      },
    }),
  );
  const url = (
    cid = gid,
    revision = selection.selectionRevision,
    job = "body-job",
  ) => `/${job}/people/0/pose-previews/${cid}/${hash}/body/${revision}`;
  let response = await app.request(url());
  assert.equal(response.status, 200);
  assert.equal(libraryCalls, 0);
  assert.equal(response.headers.get("X-Standin-Preview-Only"), "true");
  assert.equal(
    response.headers.get("X-Standin-Preview-Projection"),
    "orthographic",
  );
  assert.equal(
    response.headers.get("X-Standin-Character-SHA256"),
    selection.resolvedBody!.assetSha256,
  );
  assert.equal((await app.request(url(id))).status, 200);
  assert.equal(libraryCalls, 2); // Before and after rendering/cache lookup.
  assert.equal((await app.request(url(gid, 0, "foreign"))).status, 404);
  assert.equal((await app.request(url(gid, 99))).status, 409);
  assert.equal(
    (await app.request(url() + "?characterId=untrusted")).status,
    409,
  );
  selection = {
    ...selection,
    shape: {
      schemaVersion: "body-shape.v1",
      controls: { height: 0.5 },
      shapeSha256: "f".repeat(64),
    },
    shapeSource: {
      rules: "test",
      blendSha256: "1".repeat(64),
      controllerSha256: "2".repeat(64),
    },
    selectionRevision: 1,
  };
  response = await app.request(url());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Standin-Shape-SHA256"), "f".repeat(64));
  selection = { ...selection, selectionRevision: 2 };
  changeDuringRender = true;
  response = await app.request(url());
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "BODY_PREVIEW_STALE",
  );
  assert.equal(renders, 4);
  assert.equal(
    result.candidatesByPerson[0].posePresentation!.export_allowed,
    false,
  );
  assert.equal(
    result.candidatesByPerson[0].posePresentation!.generated_candidates[0]
      .actual_mesh_validated,
    false,
  );
  const library = result.candidatesByPerson[0].candidates;
  assert.equal(library.length, 2);
  assert.equal(library[0].source, "library");
  assert.equal(library[0].releaseAllowed, false);
  assert.equal(library[0].manualExportAllowed, true);
  assert.equal(library[0].refineAllowed, false);
  assert.equal(library[0].sourceBvhSha256, hash);
});

function mirrorFixture() {
  const original = candidate();
  const mirror = {
    ...candidate(),
    candidate_id: "preview_" + "c".repeat(64),
    pose_id: "test mirror",
    kind: "mirror_reference",
    rank_score: null,
    score_kind: null,
    validation: { not_exact_match: true, constraints_satisfied: false },
    asset: {
      ...candidate().asset,
      bvh_url: "/pose/test%20mirror/bvh",
      bvh_sha256: "d".repeat(64),
    },
    mirror_comparison: {
      family_id: "family",
      original_pose_id: original.pose_id,
      original_bvh_sha256: original.asset.bvh_sha256,
      original_candidate_id: original.candidate_id,
      is_mirror: true,
      observed_side: "left",
      reference_side: "right",
      reason: "opposite_hand_reference",
      matches_observed_side: false,
    },
  };
  return {
    ...raw(),
    generation_status: null,
    library_candidates: [original],
    review_candidates: [mirror],
    generated_candidates: [] as ReturnType<typeof candidate>[],
    mirror_comparison: { status: "ready", reason: "opposite_hand_reference" },
  };
}
test("opposite-hand reference preserves private BVH binding and is never a selectable match", () => {
  const value = mirrorFixture();
  const mapped = mapPosePresentation(value, 0, "job");
  assert.equal(
    mapped!.presentation.review_candidates[0].mirror_comparison!
      .original_candidate_id,
    id,
  );
  assert.equal(mapped!.presentation.review_candidates[0].rank_score, null);
  assert.equal(
    mapped!.assets[value.review_candidates[0].candidate_id].pose_id,
    "test mirror",
  );
  assert.equal(mapped!.presentation.review_candidates[0].export_allowed, false);
  assert.equal(mapped!.presentation.library_candidates.length, 1);
});
for (const failure of [
  "orphan",
  "original_pose",
  "original_hash",
  "same_side",
  "score",
  "accuracy_score",
  "score_kind",
  "hash",
  "release",
  "refine",
  "export",
  "auto_apply",
  "mesh",
  "budget",
  "generated",
  "generation_status",
  "duplicate",
  "status",
  "not_exact",
  "constraints",
  "camera",
  "projection",
  "is_mirror",
  "wrong_group",
]) {
  test(`rejects invalid mirror ${failure} instead of promoting it`, () => {
    const v = mirrorFixture();
    const m = v.review_candidates[0];
    if (failure === "orphan")
      m.mirror_comparison.original_candidate_id = "preview_" + "e".repeat(64);
    if (failure === "original_pose")
      m.mirror_comparison.original_pose_id = "unrelated";
    if (failure === "original_hash")
      m.mirror_comparison.original_bvh_sha256 = "0".repeat(64);
    if (failure === "same_side") m.mirror_comparison.reference_side = "left";
    if (failure === "score")
      (m as { rank_score: number | null }).rank_score = 0.9;
    if (failure === "accuracy_score") Object.assign(m, { score: 0.9 });
    if (failure === "score_kind")
      Object.assign(m, { score_kind: "weighted_rrf" });
    if (failure === "hash")
      m.asset.bvh_sha256 = v.library_candidates[0].asset.bvh_sha256;
    if (failure === "release") m.release_allowed = true;
    if (failure === "refine") m.refine_allowed = true;
    if (failure === "export") m.export_allowed = true;
    if (failure === "auto_apply") m.auto_apply_allowed = true;
    if (failure === "mesh") m.actual_mesh_validated = true;
    if (failure === "budget")
      v.library_candidates = Array.from({ length: 5 }, (_, i) => ({
        ...v.library_candidates[0],
        candidate_id: i ? "preview_" + String(i).repeat(64) : id,
      }));
    if (failure === "generated") v.generated_candidates.push(candidate(true));
    if (failure === "generation_status")
      Object.assign(v, { generation_status: "preview_ready" });
    if (failure === "duplicate")
      v.review_candidates.push({
        ...m,
        candidate_id: "preview_" + "f".repeat(64),
      });
    if (failure === "status") v.mirror_comparison.status = "unavailable";
    if (failure === "not_exact") m.validation.not_exact_match = false;
    if (failure === "constraints") m.validation.constraints_satisfied = true;
    if (failure === "camera")
      m.render_camera = { ...m.render_camera, yaw_degrees: 10 };
    if (failure === "projection")
      m.render_camera = { ...m.render_camera, projection_matches_search: true };
    if (failure === "is_mirror")
      Object.assign(m.mirror_comparison, { is_mirror: "true" });
    if (failure === "wrong_group") {
      v.review_candidates = [];
      v.library_candidates.push(m);
    }
    const mapped = mapPosePresentation(v, 0, "job")!;
    assert.equal(mapped.presentation.status, "error");
    assert.equal(mapped.presentation.review_candidates.length, 0);
    assert.deepEqual(mapped.assets, {});
  });
}

test("ready 4+1 preserves original ranking, includes source, and allows original and actual mirror manual selection", () => {
  const v = mirrorFixture();
  v.library_candidates = Array.from({ length: 4 }, (_, i) => ({
    ...v.library_candidates[0],
    rank: i + 1,
    candidate_id: i ? "preview_" + String(i).repeat(64) : id,
  }));
  const person = mapCutResult("job", cut(v)).candidatesByPerson[0];
  assert.deepEqual(
    person.posePresentation!.library_candidates.map((c) => c.rank),
    [1, 2, 3, 4],
  );
  assert.equal(person.posePresentation!.review_candidates.length, 1);
  assert.equal(person.candidates.length, 5);
  assert.ok(
    person.candidates.some(
      (c) => c.id === v.review_candidates[0].candidate_id && c.manualExportAllowed === true,
    ),
  );
});

for (const status of ["unavailable", "not_requested"])
  test(`preserves optional mirror ${status} without invalidating originals`, () => {
    const v = mirrorFixture();
    v.review_candidates = [];
    v.mirror_comparison.status = status;
    const mapped = mapPosePresentation(v, 0, "job")!;
    assert.equal(mapped.presentation.status, "ready");
    assert.equal(mapped.presentation.library_candidates.length, 1);
    assert.equal(mapped.presentation.mirror_comparison!.status, status);
  });

test("owned mirror preview fetches the counterpart BVH and rejects changed bytes", async () => {
  const v = mirrorFixture();
  const bytes = bvh + "\n# actual opposite-side source\n";
  const mirror = v.review_candidates[0];
  mirror.asset.bvh_sha256 = createHash("sha256").update(bytes).digest("hex");
  const mapped = mapPosePresentation(v, 0, "job")!;
  const result = mapCutResult("job", cut(v));
  let changed = false;
  const fetched: string[] = [];
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
          ? ({ status: "completed", result } as Job)
          : undefined,
      loadAssets: async () => mapped.assets,
      getPoseBvh: async (pid) => {
        fetched.push(pid);
        return new Response(changed ? bvh : bytes);
      },
    }),
  );
  const url = `/job/people/0/pose-previews/${mirror.candidate_id}/${mirror.asset.bvh_sha256}`;
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), bytes);
  assert.deepEqual(fetched, ["test mirror"]);
  changed = true;
  assert.equal((await app.request(url)).status, 409);
  assert.equal(
    (await app.request(url.replace("/job/", "/other/"))).status,
    404,
  );
  assert.equal((await app.request(url + "?release=true")).status, 409);
});
