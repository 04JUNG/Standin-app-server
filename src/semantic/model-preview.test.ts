import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { ConverterError } from "../converter/client.js";
import {
  createSemanticModelRoutes,
  SEMANTIC_CHARACTER_ID,
} from "./model-preview.js";
function fixture() {
  const bvh = "HIERARCHY verified source",
    hash = createHash("sha256").update(bvh).digest("hex"),
    id = "preview_" + "b".repeat(64),
    jobId = "job_" + randomUUID();
  const identity = {
    characterSha256: "c".repeat(64),
    modelRevision: "d".repeat(64),
  };
  const candidate = {
    candidate_id: id,
    source: "library",
    pose_id: "pose",
    asset: { transport: "library_bvh", bvh_sha256: hash },
  };
  const presentation = {
    version: "semantic-pose-presentation-v1",
    output_scope: "full",
    library_candidates: [candidate],
    review_candidates: [],
    generated_candidates: [],
  };
  const job = {
    id: jobId,
    status: "completed",
    result: {
      source: "semantic",
      candidatesByPerson: [{ personIndex: 0, posePresentation: presentation }],
    },
  } as unknown as Job;
  const doc = {
    asset: {
      extras: {
        version: "posed-mesh-v1",
        character_id: SEMANTIC_CHARACTER_ID,
        character_sha256: identity.characterSha256,
        source_bvh_sha256: hash,
        revision: identity.modelRevision,
        scope: "full",
        coordinates: "Y-up-hips-origin",
      },
    },
  };
  const json = Buffer.from(JSON.stringify(doc)),
    size = Math.ceil(json.length / 4) * 4,
    model = Buffer.alloc(size + 32, 32);
  model.writeUInt32LE(0x46546c67, 0);
  model.writeUInt32LE(2, 4);
  model.writeUInt32LE(model.length, 8);
  model.writeUInt32LE(size, 12);
  model.writeUInt32LE(0x4e4f534a, 16);
  json.copy(model, 20);
  const state = {
    owned: true,
    rate: true,
    changed: false,
    missing: false,
    corrupt: false,
    converts: 0,
    after: () => {},
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("Owner") ?? "owner");
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/jobs",
    createSemanticModelRoutes({
      getOwnedJob: async (_, owner) =>
        state.owned && owner === "owner" ? job : undefined,
      checkCharacter: async () => "ok",
      modelPreviewIdentity: async () => identity,
      consume: async () => state.rate,
      loadAssets: async () => ({
        [id]: { transport: "library_bvh", pose_id: "pose", bvh_sha256: hash },
      }),
      getPoseBvh: async () =>
        new Response(bvh + (state.changed ? "changed" : "")),
      getPreviewModel: async () => {
        if (state.missing)
          throw new ConverterError("PREVIEW_NOT_READY", "missing");
        if (state.corrupt)
          throw new ConverterError("CONVERTER_INTEGRITY", "bad");
        state.after();
        return model;
      },
      convertFramed: async (input) => {
        state.converts++;
        assert.equal(input.characterId, SEMANTIC_CHARACTER_ID);
        assert.equal(input.scope, "full");
        assert.equal(input.previewFormat, "model");
        assert.equal(input.hands, undefined);
        assert.equal(input.shape, undefined);
        state.after();
        return {
          preview: model,
          fbx: Buffer.from("private FBX"),
          artifactSha256: "e".repeat(64),
          conversionId: "x",
          sourceBvhSha256: hash,
        };
      },
    }),
  );
  return {
    app,
    state,
    job,
    presentation,
    url: `/jobs/${jobId}/people/0/pose-previews/${id}/${hash}/model`,
  };
}
test("semantic default male returns a source-bound read-only GLB without generating FBX", async () => {
  const { app, state, url } = fixture(),
    r = await app.request(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "model/gltf-binary");
  assert.equal(r.headers.get("X-Standin-Preview-Only"), "true");
  assert.equal(r.headers.get("X-Standin-Character-Id"), SEMANTIC_CHARACTER_ID);
  assert.equal(state.converts, 0);
  assert.equal(
    Buffer.from(await r.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "glTF",
  );
});
test("only a missing library mesh falls back to fixed male conversion; integrity errors fail closed", async () => {
  const { app, state, url } = fixture();
  state.corrupt = true;
  assert.equal((await app.request(url)).status, 503);
  assert.equal(state.converts, 0);
  state.corrupt = false;
  state.missing = true;
  assert.equal((await app.request(url)).status, 200);
  assert.equal(state.converts, 1);
});
test("semantic mesh denies other owners, changed BVH, unknown scope, extra body/format query and rate limit", async () => {
  const { app, state, url, presentation } = fixture();
  assert.equal(
    (await app.request(url, { headers: { Owner: "other" } })).status,
    404,
  );
  assert.equal((await app.request(url + "?format=fbx")).status, 400);
  assert.equal((await app.request(url + "?characterId=female")).status, 400);
  state.changed = true;
  assert.equal((await app.request(url)).status, 409);
  state.changed = false;
  state.rate = false;
  assert.equal((await app.request(url)).status, 429);
  state.rate = true;
  presentation.output_scope = "half";
  assert.equal((await app.request(url)).status, 404);
  assert.equal(state.converts, 0);
});
test("revoked ownership during mesh retrieval discards the model", async () => {
  const { app, state, url } = fixture();
  state.after = () => {
    state.owned = false;
  };
  assert.equal((await app.request(url)).status, 409);
});
test("image jobs cannot obtain semantic fixed-body model access", async () => {
  const { app, job, url } = fixture();
  job.result!.source = "image";
  assert.equal((await app.request(url)).status, 404);
});
