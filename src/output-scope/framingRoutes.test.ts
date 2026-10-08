import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { createFramingRoutes } from "./framingRoutes.js";
import { resolveOutputScope } from "./model.js";
import { sha256Hex } from "../converter/client.js";

const sourceSha = sha256Hex(Buffer.from("HIERARCHY MOTION"));
function libraryModel(characterSha = "b".repeat(64)) {
  const json = JSON.stringify({
    asset: {
      extras: {
        version: "posed-mesh-v1",
        source_bvh_sha256: sourceSha,
        character_id: "master",
        character_sha256: characterSha,
        scope: "full",
        coordinates: "Y-up-hips-origin",
      },
    },
  });
  const size = Math.ceil(Buffer.byteLength(json) / 4) * 4;
  const bytes = Buffer.alloc(size + 32);
  [0x46546c67, 2, bytes.length, size, 0x4e4f534a].forEach((v, i) =>
    bytes.writeUInt32LE(v, i * 4),
  );
  bytes.fill(32, 20, 20 + size);
  bytes.write(json, 20);
  return bytes;
}

function setup() {
  const state = {
    owner: true,
    confirmed: true,
    scope: "half" as "half" | "head" | "full",
    available: true,
    changeDuringConversion: false,
    calls: 0,
    reads: 0,
    revision: "a".repeat(64),
    refined: false,
    libraryReads: 0,
    libraryCharacter: "b".repeat(64),
    pending: undefined as Promise<void> | undefined,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "inst_test");
    c.set("requestId", "req_test");
    await next();
  });
  app.route(
    "/",
    createFramingRoutes({
      recordExport: async () => {},
      getOwnedJob: async (_job, installation) => {
        assert.equal(installation, "inst_test");
        return state.owner
          ? ({
              status: "completed",
              result: {
                candidatesByPerson: [
                  {
                    personIndex: 0,
                    outputScope: resolveOutputScope({ selection: state.scope }),
                    candidates: [
                      {
                        id: "pick",
                        poseId: "pose",
                        camera:
                          state.scope === "full"
                            ? {
                                source_bvh_sha256: sourceSha,
                                rotation: [
                                  [1, 0, 0],
                                  [0, 1, 0],
                                  [0, 0, 1],
                                ],
                              }
                            : undefined,
                      },
                    ],
                  },
                ],
              },
            } as Job)
          : undefined;
      },
      validateExportCandidate: async () => state.confirmed,
      resolveExportArtifact: async () =>
        state.refined
          ? {
              variant: "refined" as const,
              bytes: Buffer.from("REFINED"),
              fallbackReason: null,
            }
          : {
              variant: "base" as const,
              fallbackReason: null,
            },
      getPoseBvh: async () => {
        state.reads++;
        return new Response("HIERARCHY MOTION", {
          status: state.available ? 200 : 409,
        });
      },
      checkCharacter: async () => "ok" as const,
      getPreviewModel: async () => {
        state.libraryReads++;
        return libraryModel(state.libraryCharacter);
      },
      converterEnabled: () => true,
      modelPreviewIdentity: async () => ({
        modelRevision: state.revision,
        characterSha256: "b".repeat(64),
      }),
      convertFramed: async (input) => {
        state.calls++;
        await state.pending;
        if (state.changeDuringConversion) state.scope = "head";
        return {
          fbx: Buffer.from("fbx"),
          preview: Buffer.from(input.previewFormat === "model" ? "glb" : "png"),
          conversionId: "id",
          artifactSha256: "sha",
          sourceBvhSha256: "sha",
        };
      },
    }),
  );
  const request = (overrides: Record<string, string> = {}, pose = "pose") =>
    app.request(
      `/${pose}/framed?` +
        new URLSearchParams({
          jobId: "job" + Math.random(),
          personIndex: "0",
          candidateId: "pick",
          outputScope: "half",
          format: "preview",
          ...overrides,
        }),
    );
  return { state, request };
}
test("owned confirmed scope returns private preview; same pair can export FBX", async () => {
  const { state, request } = setup();
  const response = await request({ jobId: "paired-job" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "png");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(
    await (await request({ jobId: "paired-job", format: "fbx" })).text(),
    "fbx",
  );
  assert.equal(state.calls, 1);
});

test("model review and download share one conversion but exporter revisions invalidate it", async () => {
  const { state, request } = setup();
  const query = { jobId: "model-pair", format: "model" };
  const model = await request(query);
  assert.equal(model.headers.get("Content-Type"), "model/gltf-binary");
  assert.equal(await model.text(), "glb");
  const exported = await request({
    ...query,
    format: "fbx",
    previewType: "model",
  });
  assert.equal(await exported.text(), "fbx");
  assert.equal(state.calls, 1);
  state.revision = "c".repeat(64);
  await request(query);
  assert.equal(state.calls, 2);
  state.owner = false;
  assert.equal((await request(query)).status, 409);
  assert.equal(state.calls, 2);
});
for (const kind of ["owner", "confirmation", "stale", "pose", "quarantine"]) {
  test(`reject ${kind} before converting`, async () => {
    const { state, request } = setup();
    if (kind === "owner") state.owner = false;
    if (kind === "confirmation") state.confirmed = false;
    if (kind === "stale") state.scope = "head";
    if (kind === "quarantine") state.available = false;
    assert.equal(
      (await request({}, kind === "pose" ? "another" : "pose")).status,
      409,
    );
    assert.equal(state.calls, 0);
  });
}
test("missing person or automatic scope is not accepted as an explicit framing request", async () => {
  const { request } = setup();
  assert.equal((await request({ personIndex: "" })).status, 400);
  assert.equal((await request({ outputScope: "auto" })).status, 400);
});

test("scope changed during conversion cannot be returned as the reviewed result", async () => {
  const { state, request } = setup();
  state.changeDuringConversion = true;
  const response = await request();
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "OUTPUT_SCOPE_CHANGED");
});
test("paired cache still rechecks ownership on every download", async () => {
  const { state, request } = setup();
  const jobId = "owned-cache-job";
  assert.equal((await request({ jobId })).status, 200);
  state.owner = false;
  assert.equal((await request({ jobId, format: "fbx" })).status, 409);
  assert.equal(state.calls, 1);
});

test("server-confirmed library model returns before preparation; save joins the same work", async () => {
  const { state, request } = setup();
  state.scope = "full";
  let finish!: () => void;
  state.pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const query = {
    jobId: "library-pair",
    outputScope: "full",
    characterId: "master",
    format: "model",
    useLibraryModel: "true",
  };
  const response = await request(query);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), libraryModel());
  assert.equal(response.headers.get("X-Standin-Artifact-SHA256"), null);
  assert.equal(state.calls, 1);
  const download = request({
    ...query,
    format: "fbx",
    previewType: "model",
    expectedBvhSha256: sourceSha,
  });
  finish();
  assert.equal(await (await download).text(), "fbx");
  assert.equal(state.calls, 1);
});

test("lost refine response cannot make the server return an unmodified library model", async () => {
  const { state, request } = setup();
  state.scope = "full";
  state.refined = true;
  const response = await request({
    outputScope: "full",
    format: "model",
    useLibraryModel: "true",
  });
  assert.equal(await response.text(), "glb");
  assert.equal(state.libraryReads, 0);
});

test("a library model with an old character hash falls through to final conversion", async () => {
  const { state, request } = setup();
  state.scope = "full";
  state.libraryCharacter = "f".repeat(64);
  const response = await request({
    outputScope: "full",
    characterId: "master",
    format: "model",
    useLibraryModel: "true",
  });
  assert.equal(await response.text(), "glb");
  assert.equal(state.calls, 1);
});

for (const field of [
  "expectedBvhSha256",
  "expectedCharacterSha256",
  "expectedModelRevision",
]) {
  test(`changed ${field} rejects save before conversion`, async () => {
    const { state, request } = setup();
    const response = await request({
      format: "fbx",
      previewType: "model",
      [field]: "f".repeat(64),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "PREVIEW_CHANGED");
    assert.equal(state.calls, 0);
  });
}

test("a refinement stored after review invalidates the pinned original source", async () => {
  const { state, request } = setup();
  state.refined = true;
  const response = await request({
    format: "fbx",
    previewType: "model",
    expectedBvhSha256: sourceSha,
  });
  assert.equal(response.status, 409);
  assert.equal(state.calls, 0);
});
