import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";
import { createSceneRoutes } from "./sceneRoutes.js";

const fbx = Buffer.from("Kaydara FBX Binary  \0\x1a\0person");
function setup(refinement = false) {
  const state = {
    owner: true,
    confirmed: true,
    reviewStatus: 200,
    reads: 0,
    composed: 0,
    changeHands: false,
    preparations: 0,
    tamper: false,
    sent: [] as number[],
  };
  const job = {
    id: "job",
    inputS3Key: "owned-raw-image",
    status: "completed",
    updatedAt: "v1",
    result: {
      image: { width: 765, height: 714 },
      candidatesByPerson: [0, 1].map((i) => ({
        personIndex: i,
        box: [10 + i * 300, 20, 250 + i * 300, 650],
        skeleton: {
          keypoints: Array.from({ length: 17 }, () => [100, 100]),
          scores: Array(17).fill(0.8),
        },
        candidates: [{ id: `pick${i}`, poseId: `pose${i}` }],
      })),
    },
  } as Job;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req");
    c.set("installationId", "owner");
    await next();
  });
  app.route(
    "/",
    createSceneRoutes(
      async (request) => {
        state.reads++;
        assert.equal(request.headers.get("X-Installation-Id"), "owner");
        assert.equal(new URL(request.url).origin, "https://scene.internal");
        if (state.changeHands && state.composed)
          return new Response("changed hands", { status: 409 });
        return new Response(state.tamper ? Buffer.from("wrong") : fbx, {
          status: state.reviewStatus,
        });
      },
      {
        enabled: () => true,
        refinementEnabled: () => refinement,
        prepareRefinedScene: async () => {
          state.composed++;
          state.preparations++;
          return {
            bytes: fbx,
            sha256: sha256Hex(fbx),
            preview: Buffer.from("preview").toString("base64"),
            previewSha256: sha256Hex(Buffer.from("preview")),
            summary: [],
          };
        },
        getOwnedJob: async () => (state.owner ? job : undefined),
        validateConfirmedSelection: async () => state.confirmed,
        composeRoughScene: async (_id, image, sources) => {
          state.composed++;
          state.sent = sources.map((s) => s.person_index);
          assert.deepEqual(image, job.result!.image);
          assert.equal(sources[1]!.observation.box[0], 310);
          assert.deepEqual(Buffer.from(sources[0]!.bytes), fbx);
          return { bytes: fbx, sha256: sha256Hex(fbx) };
        },
      },
    ),
  );
  const rows = [0, 1].map((i) => ({
    personIndex: i,
    candidateId: `pick${i}`,
    sha256: sha256Hex(fbx),
    exportPath: `/v1/pose-candidates/pose${i}/framed?jobId=job&personIndex=${i}&candidateId=pick${i}&format=fbx&reviewKey=review`,
  }));
  return {
    state,
    rows,
    send: (extra: Record<string, unknown> = {}) =>
      app.request("/job/scene", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Installation-Id": "owner",
          "X-Device-Token": "token",
        },
        body: JSON.stringify({ persons: rows, ...extra }),
      }),
  };
}
test("reviewed files plus owned observations compose one authenticated scene", async () => {
  const s = setup(),
    res = await s.send();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Standin-Person-Count"), "2");
  assert.deepEqual(s.state.sent, [0, 1]);
  assert.equal(s.state.reads, 4);
});
test("foreign jobs, unconfirmed selections and rejected reviews never compose", async () => {
  for (const key of ["owner", "confirmed", "reviewStatus"] as const) {
    const s = setup();
    if (key === "reviewStatus") s.state.reviewStatus = 409;
    else s.state[key] = false;
    assert.equal((await s.send()).status, 409);
    assert.equal(s.state.composed, 0);
  }
});
test("never dispatches foreign URLs or duplicate identity parameters", async () => {
  for (const path of [
    "https://evil.test/v1/pose-candidates/pose0/framed",
    "/v1/analysis/jobs/job/scene",
    "/v1/pose-candidates/pose0/framed?jobId=job&jobId=other&personIndex=0&candidateId=pick0&format=fbx",
  ]) {
    const s = setup();
    s.rows[0]!.exportPath = path;
    assert.equal((await s.send()).status, 400);
    assert.equal(s.state.reads, 0);
  }
});
test("artifact substitution and body/hand changes during composition fail closed", async () => {
  const a = setup();
  a.state.tamper = true;
  assert.equal((await a.send()).status, 409);
  assert.equal(a.state.composed, 0);
  const b = setup();
  b.state.changeHands = true;
  assert.equal((await b.send()).status, 409);
  assert.equal(b.state.composed, 1);
});

test("scene refinement requires review, pins exact artifact and rechecks hands on release", async () => {
  const s = setup(true);
  assert.equal((await s.send()).status, 409);
  const prepared = await s.send({ prepare: true });
  assert.equal(prepared.status, 200);
  const receipt = (await prepared.json()) as {
    reviewKey: string;
    artifactSha256: string;
  };
  assert.equal(receipt.artifactSha256, sha256Hex(fbx));
  const download = await s.send({ reviewKey: receipt.reviewKey });
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("X-Standin-Scene-Version"),
    "scene-refinement-v4",
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fbx);
  assert.equal(s.state.preparations, 1);
  s.state.changeHands = true;
  assert.equal((await s.send({ reviewKey: receipt.reviewKey })).status, 409);
});
test("review receipts cannot cross jobs or source references", async () => {
  const a = setup(true);
  const receipt = (await (await a.send({ prepare: true })).json()) as {
    reviewKey: string;
  };
  a.rows[0]!.exportPath += "&changed=1";
  assert.equal((await a.send({ reviewKey: receipt.reviewKey })).status, 409);
  assert.equal((await a.send({ reviewKey: "unknown" })).status, 409);
});
