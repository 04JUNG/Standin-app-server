import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type { CandidateCamera } from "../types.js";
import type { PreviewRuntime } from "../converter/previewRuntime.js";
import { EXPECTED_SOLVER_VERSION, sha256Hex } from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import {
  createBodyPreviewRoutes,
  bodyPreviewManifestUrl,
  type BodyPreviewManifest,
} from "./previews.js";
import { bodyRef, defaultPreferences, resolveBody, snapshot } from "./model.js";
import { catalog, result } from "./fixtures.js";

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
        assert.equal(input.scope, "full");
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
for (const change of ["body", "revision", "camera", "pose", "runtime"] as const)
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
    const r = await app.request(old.candidates[0].thumbnailUrl);
    assert.equal(r.status, 409);
    assert.equal(await code(r), "BODY_PREVIEW_STALE");
    assert.equal(state.convertCalls, 0);
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
