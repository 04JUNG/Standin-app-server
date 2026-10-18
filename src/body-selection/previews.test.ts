import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type { CandidateCamera } from "../types.js";
import type { PreviewRuntime } from "../converter/previewRuntime.js";
import { EXPECTED_SOLVER_VERSION, sha256Hex } from "../converter/client.js";
import { FRAMING_VERSION, type FramedInput } from "../converter/framing.js";
import { resolveOutputScope } from "../output-scope/model.js";
import {
  createBodyPreviewRoutes,
  validCamera,
  bodyPreviewManifestUrl,
  type BodyPreviewManifest,
} from "./previews.js";
import { bodyRef, defaultPreferences, resolveBody, snapshot } from "./model.js";
import { catalog, result, makeManualPresentation } from "./fixtures.js";

function setup(count = 5) {
  const bodies = catalog(9),
    analysis = result(),
    jobId = `job_${randomUUID()}`;
  analysis.jobId = jobId;
  const bvh = Buffer.from("unchanged original BVH");
  const rotation = [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ];
  for (const p of analysis.candidatesByPerson) {
    p.candidates = Array.from({ length: count }, (_, i) => ({
      ...p.candidates[0],
      id: `pose-${i}::back`,
      poseId: `pose-${i}`,
      rank: i + 1,
      view: "back",
      bvhAvailable: true,
      camera: {
        version: "candidate-camera-v1",
        rotation: structuredClone(rotation),
        source_bvh_sha256: sha256Hex(bvh),
        reference: "pelvis-torso-yaw",
        canonical_yaw: 0,
        display_view: "back",
        status: "fitted",
        fit_error: 0,
        facing_source: "geometry_only",
        depth_ambiguous: false,
      } as CandidateCamera,
    }));
    p.candidateCount = count;
  }
  for (const a of bodies.assets)
    a.supportedPoseIds = analysis.candidatesByPerson[0].candidates.map(
      (p) => p.poseId,
    );
  const policy = snapshot(defaultPreferences(), bodies);
  const initial = (i: number) =>
    resolveBody(
      i,
      policy,
      { status: "available", body: bodyRef(bodies.assets[1]), reasonCodes: [] },
      bodies,
      bodies.assets[1].supportedPoseIds,
    );
  const state = {
    selections: [initial(0), initial(1)],
    owner: true,
    enabled: true,
    converter: true,
    status: "completed",
    poseStatus: 200,
    corruptBvh: false,
    available: true,
    poseCalls: 0,
    modelCalls: 0,
    convertCalls: 0,
    inputs: [] as FramedInput[],
    framedAvailable: true,
    afterRender: () => {},
    runtime: {
      schemaVersion: "body-preview-runtime.v1",
      previewRevision: "a".repeat(64),
      modelVersion: "posed-mesh-v1",
      modelRevision: "b".repeat(64),
      solverVersion: EXPECTED_SOLVER_VERSION,
      framingVersion: FRAMING_VERSION,
    } as PreviewRuntime,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/v1/analysis/jobs",
    createBodyPreviewRoutes({
      enabled: () => state.enabled,
      converterEnabled: () => state.converter,
      getOwnedJob: async (id, owner) => {
        assert.equal(owner, "owner");
        assert.equal(id, jobId);
        return state.owner
          ? ({ id: jobId, status: state.status, result: analysis } as Job)
          : undefined;
      },
      selection: async (_owner, _job, i) =>
        structuredClone(state.selections[i]),
      checkCharacter: async () => (state.available ? "ok" : "unavailable"),
      getPreviewRuntime: async () => structuredClone(state.runtime),
      modelPreviewIdentity: async () =>
        state.framedAvailable
          ? {
              modelRevision: "f".repeat(64),
              characterSha256: state.selections[0].resolvedBody!.assetSha256,
            }
          : null,
      getPoseBvh: async () => {
        state.poseCalls++;
        return new Response(state.corruptBvh ? "wrong" : bvh, {
          status: state.poseStatus,
        });
      },
      getModel: async (source, body, runtime) => {
        state.modelCalls++;
        assert.equal(source, sha256Hex(bvh));
        assert.deepEqual(body, state.selections[0].resolvedBody);
        assert.deepEqual(runtime, state.runtime);
        state.afterRender();
        return Buffer.from("verified GLB fixture");
      },
      convertFramed: async (input) => {
        state.convertCalls++;
        assert.deepEqual(input.cameraRotation, rotation);
        assert.deepEqual(input.bvhBytes, new Uint8Array(bvh));
        state.inputs.push(input);
        assert.deepEqual(input.shape, state.selections[0].shape ?? null);
        assert.equal(
          input.characterId,
          state.selections[0].resolvedBody!.characterId,
        );
        assert.equal(
          input.expectedCharacterSha256,
          state.selections[0].resolvedBody!.assetSha256,
        );
        const artifact = {
          fbx: Buffer.from("FBX"),
          preview: Buffer.from("PNG"),
          conversionId: "test",
          artifactSha256: sha256Hex(Buffer.from("FBX")),
          sourceBvhSha256: sha256Hex(bvh),
          characterSha256: input.expectedCharacterSha256,
          previewRevision: input.expectedPreviewRevision,
        };
        state.afterRender();
        return artifact;
      },
    }),
  );
  const manifest = async (person = 0) => {
    const response = await app.request(bodyPreviewManifestUrl(jobId, person));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<BodyPreviewManifest>;
  };
  return { app, state, bodies, analysis, jobId, manifest };
}
const code = async (r: Response) =>
  ((await r.json()) as { error: { code: string } }).error.code;

test("manifest preserves Top-5 order and camera; no rendering/search triggered", async () => {
  const { manifest, state, analysis } = setup();
  const before = structuredClone(analysis);
  const m = await manifest();
  assert.equal(m.renderingExecuted, false);
  assert.equal(m.status, "renderable");
  assert.equal(m.candidates.length, 5);
  assert.deepEqual(
    m.candidates.map((c) => c.candidateId),
    analysis.candidatesByPerson[0].candidates.map((c) => c.id),
  );
  assert.deepEqual(m.resolvedBody, state.selections[0].resolvedBody);
  assert.equal(state.poseCalls + state.modelCalls + state.convertCalls, 0);
  assert.deepEqual(analysis, before);
});
test("shortfall uses actual count, hard fallback has no fake candidates", async () => {
  assert.equal((await setup(2).manifest()).candidates.length, 2);
  const s = setup(0);
  const response = await s.app.request(bodyPreviewManifestUrl(s.jobId, 0));
  assert.equal(response.status, 409);
  assert.equal(await code(response), "BODY_NOT_APPLICABLE");
});
test("both GLB and PNG use the stored body; no arbitrary character/camera query", async () => {
  const { app, manifest, state } = setup();
  const m = await manifest(),
    c = m.candidates[0];
  const glb = await app.request(c.previewModel.url),
    png = await app.request(c.thumbnailUrl);
  assert.equal(glb.status, 200);
  assert.equal(png.status, 200);
  assert.equal(glb.headers.get("content-type"), "model/gltf-binary");
  assert.equal(
    png.headers.get("x-standin-character-sha256"),
    m.resolvedBody.assetSha256,
  );
  assert.equal(png.headers.get("x-standin-body-render-key"), m.renderKey);
  assert.equal(png.headers.get("cache-control"), "private, no-store");
  assert.equal((await app.request(c.thumbnailUrl)).status, 200);
  assert.equal(state.convertCalls, 1);
  assert.equal(
    (await app.request(c.thumbnailUrl + "?characterId=other")).status,
    400,
  );
  assert.equal(
    (await app.request(c.previewModel.url + "?camera_rotation=other")).status,
    400,
  );
});
test("all nine approved bodies change preview identity without changing Top-5", async () => {
  const { app, state, bodies, manifest, analysis } = setup();
  const original = structuredClone(analysis);
  const keys = new Set<string>();
  for (const a of bodies.assets) {
    state.selections[0] = {
      ...state.selections[0],
      intent: "manual",
      resolvedBody: bodyRef(a),
      selectionRevision: state.selections[0].selectionRevision + 1,
    };
    const m = await manifest();
    keys.add(m.renderKey);
    assert.equal(
      (await app.request(m.candidates[0].previewModel.url)).status,
      200,
    );
    assert.equal((await app.request(m.candidates[0].thumbnailUrl)).status, 200);
  }
  assert.equal(keys.size, 9);
  assert.deepEqual(analysis, original);
});

test("half scope survives switching all nine bodies; PNG and scoped GLB bind the new body", async () => {
  const s = setup();
  s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
    detected: "half",
  });
  const order = s.analysis.candidatesByPerson[0].candidates.map((c) => c.id);
  let previous: BodyPreviewManifest | undefined;
  for (const asset of s.bodies.assets) {
    s.state.selections[0] = {
      ...s.state.selections[0],
      resolvedBody: bodyRef(asset),
      selectionRevision: s.state.selections[0].selectionRevision + 1,
    };
    const m = await s.manifest();
    assert.equal(m.outputScope, "half");
    assert.deepEqual(
      m.candidates.map((c) => c.candidateId),
      order,
    );
    if (previous) {
      assert.notEqual(m.renderKey, previous.renderKey);
      for (const url of [
        previous.candidates[0].thumbnailUrl,
        previous.candidates[0].previewModel.url,
      ])
        assert.equal((await s.app.request(url)).status, 409);
    }
    for (const url of [
      m.candidates[0].thumbnailUrl,
      m.candidates[0].previewModel.url,
    ]) {
      const response = await s.app.request(url);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("X-Standin-Character-SHA256"),
        asset.assetSha256,
      );
    }
    for (const input of s.state.inputs.slice(-2)) {
      assert.equal(input.scope, "half");
      assert.equal(input.characterId, asset.characterId);
      assert.equal(input.expectedCharacterSha256, asset.assetSha256);
    }
    previous = m;
  }
  assert.equal(s.state.modelCalls, 0);
  assert.equal(s.state.convertCalls, 18);
});

test("half scope + numeric body changes use shaped PNG and reject unshaped library GLB", async (t) => {
  const { config } = await import("../config.js");
  const before = config.bodyShapeBakeEnabled;
  Object.assign(config, { bodyShapeBakeEnabled: true });
  t.after(() => Object.assign(config, { bodyShapeBakeEnabled: before }));
  const s = setup();
  s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
    selection: "half",
  });
  s.state.selections[0].shapeSource = {
    rules: "test",
    blendSha256: "e".repeat(64),
    controllerSha256: "f".repeat(64),
  };
  let previous: BodyPreviewManifest | undefined;
  for (const [height, digest] of [
    [168, "c"],
    [186, "d"],
  ] as const) {
    s.state.selections[0].shape = {
      schemaVersion: "body-shape.v1",
      controls: { height },
      shapeSha256: digest.repeat(64),
    };
    s.state.selections[0].selectionRevision++;
    const m = await s.manifest();
    assert.equal(m.outputScope, "half");
    if (previous)
      assert.equal(
        (await s.app.request(previous.candidates[0].thumbnailUrl)).status,
        409,
      );
    const glb = await s.app.request(m.candidates[0].previewModel.url);
    assert.equal(glb.status, 503);
    assert.equal(await code(glb), "PREVIEW_NOT_READY");
    assert.equal(
      (await s.app.request(m.candidates[0].thumbnailUrl)).status,
      200,
    );
    assert.equal(s.state.inputs.at(-1)?.scope, "half");
    assert.equal(s.state.inputs.at(-1)?.shape?.controls.height, height);
    assert.deepEqual(
      s.state.inputs.at(-1)?.shapeSource,
      s.state.selections[0].shapeSource,
    );
    previous = m;
  }
  assert.equal(s.state.modelCalls, 0);
});

test("missing scoped GLB capability keeps the same half PNG fallback available", async () => {
  const s = setup();
  s.state.framedAvailable = false;
  s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
    detected: "half",
  });
  const m = await s.manifest();
  assert.equal(
    (await s.app.request(m.candidates[0].previewModel.url)).status,
    503,
  );
  assert.equal((await s.app.request(m.candidates[0].thumbnailUrl)).status, 200);
  assert.equal(s.state.inputs[0].scope, "half");
});
for (const format of ["glb", "png"] as const)
  test(`late ${format} cannot overwrite a newer selection`, async () => {
    const { app, state, manifest, bodies } = setup();
    const m = await manifest();
    state.afterRender = () => {
      state.selections[0].selectionRevision++;
      state.selections[0].resolvedBody = bodyRef(bodies.assets[2]);
    };
    const r = await app.request(
      format === "glb"
        ? m.candidates[0].previewModel.url
        : m.candidates[0].thumbnailUrl,
    );
    assert.equal(r.status, 409);
    assert.equal(await code(r), "BODY_PREVIEW_STALE");
  });
for (const change of [
  "body",
  "revision",
  "camera",
  "pose",
  "runtime",
  "scope",
] as const)
  test(`${change} invalidates old URL before rendering`, async () => {
    const { app, state, manifest, analysis, bodies } = setup();
    const old = await manifest();
    if (change === "body")
      state.selections[0].resolvedBody = bodyRef(bodies.assets[2]);
    if (change === "revision") state.selections[0].selectionRevision++;
    if (change === "camera")
      analysis.candidatesByPerson[0].candidates[0].camera!.rotation = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
    if (change === "pose") analysis.candidatesByPerson[0].candidates.reverse();
    if (change === "runtime") state.runtime.previewRevision = "c".repeat(64);
    if (change === "scope")
      analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
        selection: "half",
      });
    const r = await app.request(old.candidates[0].thumbnailUrl);
    assert.equal(r.status, 409);
    assert.equal(await code(r), "BODY_PREVIEW_STALE");
    assert.equal(state.convertCalls, 0);
  });

for (const scope of ["full", "half", "bust", "head"] as const)
  test(`${scope} binds the same scope to manifest, PNG and GLB without changing Top-5`, async () => {
    const s = setup();
    s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
      detected: scope,
    });
    const before = structuredClone(s.analysis);
    const m = await s.manifest();
    assert.equal(m.outputScope, scope);
    assert.equal(m.candidates.length, 5);
    assert.equal(
      (await s.app.request(m.candidates[0].thumbnailUrl)).status,
      200,
    );
    assert.equal(
      (await s.app.request(m.candidates[0].previewModel.url)).status,
      200,
    );
    assert.deepEqual(
      s.state.inputs.map((i) => i.scope),
      scope === "full" ? [scope] : [scope, scope],
    );
    if (scope !== "full") {
      assert.equal(m.runtime.modelRevision, "f".repeat(64));
      assert.notEqual(m.runtime.modelRevision, s.state.runtime.modelRevision);
      assert.equal(s.state.modelCalls, 0);
      assert.equal(s.state.inputs[1].previewFormat, "model");
      assert.equal(s.state.inputs[1].modelRevision, m.runtime.modelRevision);
      assert.equal(
        s.state.inputs[1].characterSha256,
        m.resolvedBody.assetSha256,
      );
    }
    assert.deepEqual(s.analysis, before);
  });

test("user scope overrides detection and presentation; missing/invalid legacy scope falls back", async () => {
  const s = setup();
  makeManualPresentation(s.analysis.candidatesByPerson[0]);
  const person = s.analysis.candidatesByPerson[0];
  person.outputScope = resolveOutputScope({
    selection: "head",
    detected: "half",
  });
  assert.equal((await s.manifest()).outputScope, "head");
  person.outputScope = resolveOutputScope({
    selection: "auto",
    detected: "bust",
  });
  assert.equal((await s.manifest()).outputScope, "bust");
  delete person.outputScope;
  person.posePresentation!.output_scope = "half";
  assert.equal((await s.manifest()).outputScope, "half");
  person.posePresentation!.output_scope = "invalid";
  assert.equal((await s.manifest()).outputScope, "full");
});

for (const format of ["glb", "png"] as const)
  test(`scope change during ${format} rendering rejects the late result`, async () => {
    const s = setup();
    s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
      selection: "half",
    });
    const m = await s.manifest();
    s.state.afterRender = () => {
      s.analysis.candidatesByPerson[0].outputScope = resolveOutputScope({
        selection: "head",
      });
    };
    const r = await s.app.request(
      format === "glb"
        ? m.candidates[0].previewModel.url
        : m.candidates[0].thumbnailUrl,
    );
    assert.equal(r.status, 409);
    assert.equal(await code(r), "BODY_PREVIEW_STALE");
  });
test("other person's change does not invalidate this person's preview", async () => {
  const { app, state, manifest } = setup();
  const old = await manifest();
  state.selections[1].selectionRevision++;
  assert.equal((await manifest()).renderKey, old.renderKey);
  assert.equal((await app.request(old.candidates[0].thumbnailUrl)).status, 200);
});
test("runtime change/deletion during a download is rejected", async () => {
  for (const action of ["runtime", "deleted"]) {
    const s = setup(),
      m = await s.manifest();
    s.state.afterRender = () => {
      if (action === "runtime")
        s.state.runtime.previewRevision = "c".repeat(64);
      else s.state.owner = false;
    };
    const response = await s.app.request(m.candidates[0].previewModel.url);
    assert.equal(response.status, action === "runtime" ? 409 : 404);
  }
});
test("ownership, manifest availability and source quarantine checked even for cached PNG", async () => {
  const s = setup(),
    m = await s.manifest(),
    url = m.candidates[0].thumbnailUrl;
  assert.equal((await s.app.request(url)).status, 200);
  s.state.owner = false;
  assert.equal((await s.app.request(url)).status, 404);
  s.state.owner = true;
  s.state.selections[0].resolutionStatus = "unavailable";
  assert.equal((await s.app.request(url)).status, 409);
  s.state.selections[0].resolutionStatus = "ready";
  s.state.poseStatus = 409;
  assert.equal((await s.app.request(url)).status, 409);
  s.state.poseStatus = 200;
  s.state.corruptBvh = true;
  assert.equal((await s.app.request(url)).status, 409);
  assert.equal(s.state.convertCalls, 1);
});
test("disabled, old camera and malformed parameters fail closed", async () => {
  const s = setup();
  s.state.enabled = false;
  assert.equal(
    (await s.app.request(bodyPreviewManifestUrl(s.jobId, 0))).status,
    503,
  );
  s.state.enabled = true;
  delete s.analysis.candidatesByPerson[0].candidates[0].camera;
  const r = await s.app.request(bodyPreviewManifestUrl(s.jobId, 0));
  assert.equal(await code(r), "BODY_PREVIEW_UNSUPPORTED");
  assert.equal(
    (
      await s.app.request(
        `/v1/analysis/jobs/${s.jobId}/people/-1/body-previews`,
      )
    ).status,
    400,
  );
});

function searchCamera(
  base: CandidateCamera,
  poseId: string,
): Extract<CandidateCamera, { version: "candidate-camera-v2" }> {
  return {
    ...base,
    version: "candidate-camera-v2",
    reference: "search-fit",
    projection: "perspective",
    distance_torso: 4,
    labels_swapped: true,
    pose_id: poseId,
    query_sha256: "d".repeat(64),
    observed_joint_mask: Array(17).fill(true),
  };
}
test("v2 search cameras retain projection/binding metadata through manifest and both preview transports", async () => {
  const s = setup();
  for (const c of s.analysis.candidatesByPerson[0].candidates)
    c.camera = searchCamera(c.camera!, c.poseId);
  const m = await s.manifest();
  assert.deepEqual(
    m.candidates[0].camera,
    s.analysis.candidatesByPerson[0].candidates[0].camera,
  );
  assert.equal((await s.app.request(m.candidates[0].thumbnailUrl)).status, 200);
  assert.equal(
    (await s.app.request(m.candidates[0].previewModel.url)).status,
    200,
  );
  // Preview uses its rotation; projection/mask remain unchanged for inference refine.
  assert.equal(s.state.convertCalls, 1);
  const camera = s.analysis.candidatesByPerson[0].candidates[0].camera!;
  if (camera.version !== "candidate-camera-v2") throw new Error("v2 expected");
  camera.pose_id = "another-pose";
  assert.equal(
    (await s.app.request(bodyPreviewManifestUrl(s.jobId, 0))).status,
    409,
  );
});
test("v2 camera validation rejects incomplete binding, bad projection and unsafe rotation", () => {
  const base = setup().analysis.candidatesByPerson[0].candidates[0].camera!;
  assert.equal(validCamera(base), true);
  const camera = searchCamera(base, "pose-0");
  assert.equal(validCamera(camera), true);
  assert.equal(
    validCamera({
      ...camera,
      projection: "orthographic",
      distance_torso: null,
    }),
    true,
  );
  for (const change of [
    { reference: "pelvis-torso-yaw" },
    { projection: "unknown" },
    { distance_torso: 0.7 },
    { distance_torso: Infinity },
    { labels_swapped: undefined },
    { query_sha256: "bad" },
    { observed_joint_mask: Array(17).fill(false) },
    { observed_joint_mask: Array(16).fill(true) },
    { pose_id: "" },
    {
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, -1],
      ],
    },
    { fit_error: NaN },
  ])
    assert.equal(
      validCamera({ ...camera, ...change } as CandidateCamera),
      false,
    );
});

test("owned manually selectable library Top-5 retain body/shape previews without a fabricated fitted camera", async (t) => {
  const { config } = await import("../config.js");
  const before = config.bodyShapeBakeEnabled;
  Object.assign(config, { bodyShapeBakeEnabled: true });
  t.after(() => Object.assign(config, { bodyShapeBakeEnabled: before }));
  const s = setup();
  makeManualPresentation(s.analysis.candidatesByPerson[0]);
  s.state.selections[0].shape = {
    schemaVersion: "body-shape.v1",
    controls: { height: 186 },
    shapeSha256: "d".repeat(64),
  };
  s.state.selections[0].shapeSource = {
    rules: "test",
    blendSha256: "e".repeat(64),
    controllerSha256: "f".repeat(64),
  };
  const manifest = await s.manifest();
  assert.equal(manifest.candidates.length, 5);
  const response = await s.app.request(manifest.candidates[0].thumbnailUrl);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(s.state.convertCalls, 1);
  assert.deepEqual(manifest.shape, s.state.selections[0].shape);
  s.analysis.candidatesByPerson[0].posePresentation!.library_candidates[0].asset.bvh_sha256 =
    "0".repeat(64);
  assert.equal(
    (await s.app.request(bodyPreviewManifestUrl(s.jobId, 0))).status,
    409,
  );
});
