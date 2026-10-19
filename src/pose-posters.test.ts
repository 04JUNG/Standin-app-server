import { gzipSync, gunzipSync } from "node:zlib";
import { createHumanReferenceRoutes } from "./human-reference.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";
import { sha256Hex } from "./converter/client.js";
import { createDefaultPosterRoutes, verifiedPoster } from "./pose-posters.js";

const source = Buffer.from("verified public BVH");
const hash = sha256Hex(source);
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function response(scope = "full", change: Record<string, string> = {}) {
  return new Response(image, {
    headers: {
      "Content-Type": "image/png",
      "X-Standin-Poster-Kind": "default-body",
      "X-Standin-Poster-Version": "default-body-poster-v1",
      "X-Standin-Source-BVH-SHA256": hash,
      "X-Standin-Output-Scope": scope,
      "X-Standin-Preview-Only": "true",
      "X-Standin-Preview-Projection": "orthographic",
      "X-Standin-Character-Id": "standin-master-v2",
      "X-Standin-Character-SHA256": "a".repeat(64),
      "X-Standin-Preview-Revision": "b".repeat(64),
      "X-Standin-Artifact-SHA256": sha256Hex(image),
      ...change,
    },
  });
}
test("canonical poster checks source, kind, model, scope, projection, revision and exact image bytes", async () => {
  const good = await verifiedPoster("pose", hash, async () => response());
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), image);
  for (const header of [
    "X-Standin-Poster-Version",
    "X-Standin-Source-BVH-SHA256",
    "X-Standin-Output-Scope",
    "X-Standin-Preview-Projection",
    "X-Standin-Preview-Only",
    "X-Standin-Character-Id",
    "X-Standin-Character-SHA256",
    "X-Standin-Preview-Revision",
    "X-Standin-Artifact-SHA256",
  ])
    await assert.rejects(
      verifiedPoster("pose", hash, async () =>
        response("full", { [header]: "changed" }),
      ),
    );
  await assert.rejects(
    verifiedPoster("pose", hash, async () =>
      response("full", { "X-Standin-Character-Id": "body-teen-male" }),
    ),
  );
  const fallback = await verifiedPoster(
    "pose",
    hash,
    async () =>
      response("half", {
        "X-Standin-Poster-Kind": "pose-only",
        "X-Standin-Character-Id": "none",
        "X-Standin-Character-SHA256": "none",
      }),
    "half",
  );
  assert.equal(fallback.headers.get("X-Standin-Poster-Kind"), "pose-only");
});
test("all cards are read-only and owner/source/manual scope are checked before and after serving", async () => {
  const candidate = {
    id: "candidate",
    poseId: "pose_mirror",
    sourceBvhSha256: hash,
  };
  const person = {
    personIndex: 0,
    candidates: [candidate],
    outputScope: {
      selection: "half",
      resolved: "half",
      detected: null,
      detectionSource: "unknown",
      resolutionSource: "user",
    },
  };
  const job = {
    status: "completed",
    result: { candidatesByPerson: [person] },
  } as unknown as Job;
  let calls = 0,
    after = () => {},
    changed = false;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("owner") ?? "owner");
    await next();
  });
  app.route(
    "/",
    createDefaultPosterRoutes({
      getOwnedJob: async (_, owner) => (owner === "owner" ? job : undefined),
      getPoseBvh: async () => new Response(changed ? "changed" : source),
      getPosePoster: async (pose, sha, scope) => {
        calls++;
        assert.equal(pose, "pose_mirror");
        assert.equal(sha, hash);
        after();
        return response(scope);
      },
    }),
  );
  const url =
    "/pose_mirror/poster?jobId=job&personIndex=0&candidateId=candidate&scope=half";
  assert.equal((await app.request(url)).status, 200);
  assert.equal(calls, 1);
  assert.equal(
    (await app.request(url, { headers: { owner: "other" } })).status,
    404,
  );
  assert.equal(calls, 1);
  changed = true;
  assert.equal((await app.request(url)).status, 409);
  assert.equal(calls, 1);
  changed = false;
  after = () => {
    person.outputScope.resolved = "head";
    person.outputScope.selection = "head";
  };
  assert.equal((await app.request(url)).status, 409);
});

// Shared actual-human template/source contracts belong to the poster suite.
const referenceBytes = Buffer.from("HIERARCHY registered source"),
  referenceHash = sha256Hex(referenceBytes);
test("reference BVH requires owned candidate/current scope/referenceHash and does not promote export", async () => {
  let owned = true,
    changed = false;
  const candidate = {
    id: "c",
    poseId: "pose",
    sourceBvhSha256: referenceHash,
    bvhAvailable: false,
    refineAllowed: false,
    releaseAllowed: false,
    lookupAllowed: true,
  };
  const person = {
    personIndex: 0,
    outputScope: { selection: "half", resolved: "half" },
    candidates: [candidate],
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/",
    createHumanReferenceRoutes({
      getOwnedJob: async () =>
        owned
          ? ({
              status: "completed",
              result: { candidatesByPerson: [person] },
            } as unknown as Job)
          : undefined,
      getPoseBvh: async () => {
        if (changed)
          person.outputScope = { selection: "head", resolved: "head" };
        return new Response(referenceBytes);
      },
    }),
  );
  const request = (scope = "half") =>
    app.request(
      "/pose/poster-source?jobId=job&personIndex=0&candidateId=c&scope=" +
        scope,
    );
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), referenceBytes.toString());
  assert.equal(response.headers.get("X-Standin-Preview-Only"), "true");
  assert.equal(
    response.headers.get("X-Standin-Source-BVH-SHA256"),
    referenceHash,
  );
  assert.equal(candidate.releaseAllowed, false);
  assert.equal(candidate.bvhAvailable, false);
  candidate.lookupAllowed = false;
  assert.equal((await request()).status, 404);
  candidate.lookupAllowed = true;
  assert.equal((await request("full")).status, 409);
  candidate.sourceBvhSha256 = "a".repeat(64);
  assert.equal((await request()).status, 409);
  candidate.sourceBvhSha256 = referenceHash;
  changed = true;
  assert.equal((await request()).status, 409);
  changed = false;
  owned = false;
  assert.equal((await request("head")).status, 404);
});
test("shared template verifies exact character/scope/compressed digest and uses native HTTP gzip with the decoded JSON digest", async () => {
  const json = Buffer.from('{"preview_only":true}');
  const packed = gzipSync(json);
  let tamper = false;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    await next();
  });
  app.route(
    "/",
    createHumanReferenceRoutes({
      getDefaultBodyTemplate: async (scope) =>
        new Response(packed, {
          headers: {
            "Content-Type": "application/gzip",
            "X-Standin-Template-Version": "default-body-template-v1",
            "X-Standin-Preview-Only": "true",
            "X-Standin-Character-Id": "standin-master-v2",
            "X-Standin-Character-SHA256":
              "7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d",
            "X-Standin-Output-Scope": scope,
            "X-Standin-Preview-Method": "reference-skinning-v1",
            "X-Standin-Template-JSON-SHA256": sha256Hex(json),
            "X-Standin-Artifact-SHA256": tamper
              ? "c".repeat(64)
              : sha256Hex(packed),
          },
        }),
    }),
  );
  const response = await app.request("/default-body-template/half");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), packed);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(
    response.headers.get("X-Standin-Artifact-SHA256"),
    sha256Hex(json),
  );
  assert.deepEqual(gunzipSync(packed), json);
  assert.equal(
    response.headers.get("X-Standin-Template-SHA256"),
    sha256Hex(packed),
  );
  tamper = true;
  assert.equal((await app.request("/default-body-template/half")).status, 404);
  assert.equal(
    (await app.request("/default-body-template/unknown")).status,
    404,
  );
});
