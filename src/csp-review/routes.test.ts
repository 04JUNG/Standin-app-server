import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createCspReviewRoutes } from "./routes.js";
import { parseReviewRelease } from "./assets.js";
import { storedZip } from "./zip.js";
import type { AppEnv } from "../env.js";

const bytes = new TextEncoder().encode("review model"), bvh = new TextEncoder().encode("HIERARCHY\nROOT Hips {}\nMOTION\nFrames: 1\nFrame Time: 0.0333\n");
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const manifestKey = "body-models/csp-review/test/manifest.json";
const release = { schema: "standin-csp-review.v1" as const, releaseId: "test", mode: "neutral-vrm-plus-selected-bvh" as const,
  models: ["male", "female"].map(sex => ({ sex: sex as "male" | "female", version: "0.7.6", key: `body-models/csp-review/test/${sex}.vrm`, sha256: sha(bytes), bytes: 100 })) };
const asset = { release, model: release.models[0], bytes };
const query = "?poseId=pose%20one&jobId=job_test&candidateId=candidate_test&personIndex=0";

test("review release requires hash, both sexes and in-prefix model keys", () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const good = enc(release);
  assert.equal(parseReviewRelease(good, sha(good), manifestKey).releaseId, "test");
  assert.throws(() => parseReviewRelease(good, "0".repeat(64), manifestKey));
  for (const change of [
    { ...release, models: [release.models[0], release.models[0]] },
    { ...release, models: [{ ...release.models[0], key: "other/male.vrm" }, release.models[1]] },
  ]) { const b = enc(change); assert.throws(() => parseReviewRelease(b, sha(b), manifestKey)); }
});

test("disabled review route does not fetch pose or model", async () => {
  const app = new Hono<AppEnv>();
  app.route("/v1/csp-review", createCspReviewRoutes(() => { throw Error("not called"); }, async () => { throw Error("not called"); }, () => false));
  assert.equal((await app.request("/v1/csp-review/male/bundle" + query)).status, 404);
});

test("existing release denial is preserved and model is never read", async () => {
  let requested: Request | undefined;
  const app = new Hono<AppEnv>();
  app.route("/v1/csp-review", createCspReviewRoutes(r => { requested = r; return new Response("denied", { status: 409 }); }, async () => { throw Error("not called"); }, () => true));
  const r = await app.request("/v1/csp-review/male/bundle" + query, { headers: { "X-Device-Token": "test-only" } });
  assert.equal(r.status, 409);
  assert.equal(await r.text(), "denied");
  assert.equal(new URL(requested!.url).pathname, "/v1/pose-candidates/pose%20one/export");
  assert.equal(new URL(requested!.url).searchParams.get("format"), "bvh");
  assert.equal(requested!.headers.get("X-Device-Token"), "test-only");
});

test("candidate bundle is readable by Python ZIP reader with exact payload hashes", async () => {
  const app = new Hono<AppEnv>();
  app.route("/v1/csp-review", createCspReviewRoutes(() => new Response(bvh), async () => asset, () => true));
  const r = await app.request("/v1/csp-review/male/bundle" + query);
  assert.equal(r.status, 200);
  const zip = new Uint8Array(await r.arrayBuffer());
  assert.equal(r.headers.get("X-Standin-Artifact-SHA256"), sha(zip));
  const python = spawnSync("python3", ["-c", "import sys,io,zipfile,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; m=json.loads(z.read('manifest.json')); assert set(z.namelist())=={'model.vrm','pose.bvh','manifest.json','README.txt'}; assert all(hashlib.sha256(z.read(k)).hexdigest()==v['sha256'] for k,v in m['artifacts'].items()); assert m['body']['slidersApplied'] is False; assert m['CSP']['locksEmbedded'] is False"], { input: zip });
  assert.equal(python.status, 0, python.stderr.toString());
});

test("unsupported shaping input and invalid BVH fail closed", async () => {
  const app = new Hono<AppEnv>();
  app.route("/v1/csp-review", createCspReviewRoutes(() => new Response("not a BVH"), async () => asset, () => true));
  assert.equal((await app.request("/v1/csp-review/male/bundle" + query + "&shape=ignored")).status, 400);
  assert.equal((await app.request("/v1/csp-review/male/bundle" + query)).status, 502);
  assert.throws(() => storedZip([{ name: "../escape", bytes }]));
});

test("asset availability failure does not substitute an old model", async () => {
  const app = new Hono<AppEnv>();
  app.route("/v1/csp-review", createCspReviewRoutes(() => new Response(bvh), async () => { throw Error("bad model hash"); }, () => true));
  assert.equal((await app.request("/v1/csp-review/male/bundle" + query)).status, 503);
});
