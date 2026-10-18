import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type { BodySelection } from "../body-selection/model.js";
import { sha256Hex } from "../converter/client.js";
import { createFramingRoutes } from "./framingRoutes.js";
import { makeManualPresentation } from "../body-selection/fixtures.js";
import type { AnalysisPerson, CandidateCamera } from "../types.js";
function setup(
  version:
    | "candidate-camera-v1"
    | "candidate-camera-v2" = "candidate-camera-v1",
) {
  const source = new TextEncoder().encode("base BVH");
  const state = {
    manual: false,
    manualCameraChanged: false,
    shape: null as BodySelection["shape"],
    revision: 1,
    hash: "a".repeat(64),
    runtime: "b".repeat(64),
    scope: "full",
    refined: false,
    owner: true,
    confirmed: true,
    late: "",
    calls: 0,
    source,
    quarantine: false,
  };
  const body = (): BodySelection => ({
    schemaVersion: "body-selection.v1",
    shape: state.shape,
    shapeSource: state.shape
      ? {
          rules: "test",
          blendSha256: "e".repeat(64),
          controllerSha256: "f".repeat(64),
        }
      : null,
    personIndex: 0,
    intent: "manual",
    manualCharacterId: "chosen",
    recommendation: { status: "unavailable", body: null, reasonCodes: [] },
    resolvedBody: {
      bodyId: "body",
      bodyVersion: "1",
      assetSha256: state.hash,
      characterId: "chosen",
      measurementVersion: "1",
      rigVersion: "1",
    },
    resolvedSource: "manual",
    resolutionStatus: "ready",
    selectionRevision: state.revision,
    renderingExecuted: false,
  });
  const runtime = async () => ({
    schemaVersion: "body-preview-runtime.v1" as const,
    previewRevision: state.runtime,
    modelVersion: "posed-mesh-v1" as const,
    modelRevision: "c".repeat(64),
    solverVersion: "solver",
    framingVersion: "framing",
  });
  const common = {
    canonical_yaw: 0,
    display_view: "front",
    status: "fitted" as const,
    fit_error: 0.1,
    facing_source: "geometry_only" as const,
    depth_ambiguous: true,
    source_bvh_sha256: sha256Hex(source),
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  };
  const camera: CandidateCamera =
    version === "candidate-camera-v1"
      ? { ...common, version, reference: "pelvis-torso-yaw" }
      : {
          ...common,
          version,
          reference: "search-fit",
          projection: "perspective",
          distance_torso: 4,
          labels_swapped: true,
          pose_id: "pose",
          query_sha256: "d".repeat(64),
          observed_joint_mask: Array(17).fill(true),
        };
  function person() {
    const p = {
      personIndex: 0,
      outputScope: { selection: state.scope },
      candidates: [{ id: "pick", poseId: "pose", rank: 1, camera }],
    } as unknown as AnalysisPerson;
    if (state.manual) {
      makeManualPresentation(p);
      if (state.manualCameraChanged)
        p.posePresentation!.library_candidates[0].render_camera.rotation = [
          [0, 0, -1],
          [0, 1, 0],
          [1, 0, 0],
        ];
    }
    return p;
  }
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "req");
    await next();
  });
  const jobId = "job-" + Math.random();
  app.route(
    "/",
    createFramingRoutes(
      {
        recordExport: async () => {},
        getOwnedJob: async () =>
          state.owner
            ? ({
                status: "completed",
                result: {
                  candidatesByPerson: [person()],
                },
              } as Job)
            : undefined,
        validateExportCandidate: async () => state.confirmed,
        resolveExportArtifact: async () =>
          state.refined
            ? {
                variant: "refined" as const,
                bytes: new TextEncoder().encode("refined"),
                artifactId: "ref",
              }
            : { variant: "base" as const, fallbackReason: null },
        getPoseBvh: async () =>
          new Response(source, { status: state.quarantine ? 409 : 200 }),
        checkCharacter: async () => "ok",
        converterEnabled: () => true,
        modelPreviewIdentity: async () => ({
          characterSha256: state.hash,
          modelRevision: "c".repeat(64),
        }),
        getPreviewModel: async () => {
          throw new Error("body review must use the verified artifact pair");
        },
        convertFramed: async (input) => {
          state.calls++;
          assert.equal(input.characterId, "chosen");
          assert.deepEqual(input.shape ?? null, state.shape);
          assert.equal(input.expectedCharacterSha256, state.hash);
          const fbx = new TextEncoder().encode(
            "FBX:" + new TextDecoder().decode(input.bvhBytes),
          );
          const result = {
            fbx,
            preview: new Uint8Array([1, 2]),
            conversionId: "c",
            artifactSha256: sha256Hex(fbx),
            sourceBvhSha256: sha256Hex(input.bvhBytes),
            characterSha256: state.hash,
            previewRevision: state.runtime,
          };
          if (state.late === "camera") state.manualCameraChanged = true;
          if (state.late === "body") state.revision++;
          if (state.late === "runtime") state.runtime = "f".repeat(64);
          if (state.late === "refine") state.refined = true;
          if (state.late === "owner") state.owner = false;
          return result;
        },
      },
      { selection: async () => body(), runtime, enabled: () => true },
    ),
  );
  const request = (extra: Record<string, string> = {}) =>
    app.request(
      "/pose/framed?" +
        new URLSearchParams({
          jobId,
          personIndex: "0",
          candidateId: person().candidates[0].id,
          outputScope: "full",
          format: "preview",
          bodySelectionRevision: "1",
          ...extra,
        }),
    );
  return { state, request };
}
test("body review and download use same confirmed body/refined artifact", async () => {
  const { state, request } = setup();
  state.refined = true;
  const preview = await request();
  assert.equal(preview.status, 200);
  const key = preview.headers.get("X-Standin-Review-Key")!;
  const download = await request({ format: "fbx", reviewKey: key });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "FBX:refined");
  assert.equal(state.calls, 1);
  assert.equal(
    download.headers.get("X-Standin-Artifact-SHA256"),
    preview.headers.get("X-Standin-Artifact-SHA256"),
  );
});
test("direct download requires review; character override rejected", async () => {
  const { request, state } = setup();
  assert.equal((await request({ format: "fbx" })).status, 409);
  assert.equal((await request({ characterId: "other" })).status, 409);
  assert.equal(state.calls, 0);
});
for (const kind of ["body", "runtime", "refine", "owner"])
  test("reject " + kind + " changed during conversion", async () => {
    const { state, request } = setup();
    state.late = kind;
    assert.equal((await request()).status, 409);
  });
for (const kind of [
  "revision",
  "hash",
  "runtime",
  "refine",
  "scope",
  "owner",
  "confirmed",
  "quarantine",
])
  test(
    "old reviewed download rejects " + kind + " change, including cache hits",
    async () => {
      const { state, request } = setup();
      const preview = await request();
      assert.equal(preview.status, 200);
      const key = preview.headers.get("X-Standin-Review-Key")!;
      if (kind === "revision") state.revision++;
      if (kind === "hash") state.hash = "e".repeat(64);
      if (kind === "runtime") state.runtime = "f".repeat(64);
      if (kind === "refine") state.refined = true;
      if (kind === "scope") state.scope = "head";
      if (kind === "owner") state.owner = false;
      if (kind === "confirmed") state.confirmed = false;
      if (kind === "quarantine") state.quarantine = true;
      assert.equal(
        (await request({ format: "fbx", reviewKey: key })).status,
        409,
      );
    },
  );

test("refined cache hit still checks base-pose quarantine", async () => {
  const { state, request } = setup();
  state.refined = true;
  const preview = await request();
  assert.equal(preview.status, 200);
  state.quarantine = true;
  assert.equal(
    (
      await request({
        format: "fbx",
        reviewKey: preview.headers.get("X-Standin-Review-Key")!,
      })
    ).status,
    409,
  );
  assert.equal(state.calls, 1);
});

test("merged final-model path preserves body receipt, hash checks and paired export reuse", async () => {
  const { state, request } = setup();
  const preview = await request({ format: "model", useLibraryModel: "true" });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "model/gltf-binary");
  assert.equal(preview.headers.get("X-Standin-Character-SHA256"), state.hash);
  const download = await request({
    format: "fbx",
    previewType: "model",
    reviewKey: preview.headers.get("X-Standin-Review-Key")!,
  });
  assert.equal(download.status, 200);
  assert.equal(state.calls, 1);
  state.revision++;
  assert.equal((await request({ format: "model" })).status, 409);
});

test("v2 search camera permits body review and paired export with the same receipt", async () => {
  const { state, request } = setup("candidate-camera-v2");
  const preview = await request();
  assert.equal(preview.status, 200);
  const download = await request({
    format: "fbx",
    reviewKey: preview.headers.get("X-Standin-Review-Key")!,
  });
  assert.equal(download.status, 200);
  assert.equal(state.calls, 1);
});

test("manual library numeric body uses one verified preview/export pair and rejects late camera changes", async (t) => {
  const { config } = await import("../config.js");
  const before = config.bodyShapeBakeEnabled;
  Object.assign(config, { bodyShapeBakeEnabled: true });
  t.after(() => Object.assign(config, { bodyShapeBakeEnabled: before }));
  const { state, request } = setup();
  state.manual = true;
  state.shape = {
    schemaVersion: "body-shape.v1",
    controls: { height: 186 },
    shapeSha256: "d".repeat(64),
  };
  const preview = await request();
  assert.equal(preview.status, 200, await preview.clone().text());
  const download = await request({
    format: "fbx",
    reviewKey: preview.headers.get("X-Standin-Review-Key")!,
  });
  assert.equal(download.status, 200, await download.clone().text());
  assert.equal(state.calls, 1);
  assert.equal(
    download.headers.get("X-Standin-Artifact-SHA256"),
    preview.headers.get("X-Standin-Artifact-SHA256"),
  );
  const late = setup();
  late.state.manual = true;
  late.state.late = "camera";
  assert.equal((await late.request()).status, 409);
});
