import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { createPoseRoutes } from "../pose/routes.js";
test("owned legacy BVH/FBX routes reject requested outline before reading/converting bytes and preserve zero BVH", async () => {
  const app = new Hono<AppEnv>(); let reads = 0, conversions = 0;
  const job = { status: "completed", result: { candidatesByPerson: [{ personIndex: 0, candidates: [{ id: "pick", poseId: "pose" }] }] } } as Job;
  app.use("*", async (c, next) => { c.set("installationId", "inst_fixture"); c.set("requestId", "req_fixture"); await next(); });
  app.route("/", createPoseRoutes({ getOwnedJob: async () => job, validateExportCandidate: async () => true,
    getPoseBvh: async () => { reads++; return new Response("HIERARCHY MOTION"); },
    resolveExportArtifact: async () => ({ variant: "base", fallbackReason: null }), recordExport: async () => {},
    convertBvhToFbx: async () => { conversions++; throw new Error("must not convert"); } }));
  const request = (format: string, appearance: unknown) => app.request("/pose/export?" + new URLSearchParams({
    jobId: "job_fixture", personIndex: "0", candidateId: "pick", format, appearance: JSON.stringify(appearance) }));
  for (const format of ["bvh", "fbx"]) {
    assert.equal((await request(format, { version: "fbx-outline-v1", width: 1 })).status, 409);
    assert.equal((await request(format, { version: "fbx-outline-v1", width: "1" })).status, 400);
  }
  assert.equal(reads, 0); assert.equal(conversions, 0);
  const zero = await request("bvh", { version: "fbx-outline-v1", width: 0 });
  assert.equal(zero.status, 200); assert.equal(await zero.text(), "HIERARCHY MOTION");
});

test("legacy routes explicitly reject skin requests/paths, while default retains original BVH", async () => {
  const { legacyAppearanceError, unsupportedSceneAppearance } = await import("./legacy.js");
  const app = new Hono<AppEnv>(); let reads = 0;
  app.get("/file", c => legacyAppearanceError(c) ?? (reads++, c.text("original")));
  const skin = { version: "fbx-skin-v1", id: "flesh" };
  assert.equal((await app.request("/file?" + new URLSearchParams({ skin: JSON.stringify(skin) }))).status, 409);
  for (const query of ["skinUrl=https://untrusted.invalid", "skinPath=../skin.png", "skin={}&skin={}"])
    assert.equal((await app.request(`/file?${query}`)).status, 400);
  assert.equal(reads, 0);
  const original = await app.request("/file?" + new URLSearchParams({ skin: JSON.stringify({ ...skin, id: "default" }), appearance: JSON.stringify({ version: "fbx-outline-v1", width: 0 }) }));
  assert.equal(original.status, 200); assert.equal(await original.text(), "original");
  for (const value of [{ skin }, { persons: [{ skin }] }]) assert.equal(unsupportedSceneAppearance(value), "SKIN_UNSUPPORTED");
  for (const value of [{ skinUrl: "external" }, { persons: [{ skin: { ...skin, texture: "external" } }] }])
    assert.equal(unsupportedSceneAppearance(value), "INVALID_SKIN");
  assert.equal(unsupportedSceneAppearance({ persons: [{ skin: { ...skin, id: "default" } }] }), undefined);
});
