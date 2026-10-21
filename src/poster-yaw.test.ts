import assert from "node:assert/strict";
import test from "node:test";
import {
  nearestYaw,
  posterCamera,
  posterOptions,
  annotatePoster,
} from "./poster-yaw.js";
import { verifiedPoster, createDefaultPosterRoutes } from "./pose-posters.js";
import { sha256Hex } from "./converter/client.js";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";

const source = Buffer.from("registered public source"),
  hash = sha256Hex(source);
const jpeg = Buffer.from([255, 216, 255, 12]);
function camera(yaw: number, kind = "fixed_117") {
  const y = (yaw * Math.PI) / 180;
  return {
    camera_kind: kind,
    render_camera: {
      version: "pose-preview-camera-v1",
      basis: "right-handed-Y-up",
      rotation_order: "Rz@Rx@Ry_column_vectors",
      bvh_camera_rotation_applied: false,
      yaw_degrees: yaw,
      pitch_degrees: 0,
      roll_degrees: 0,
      rotation: [
        [Math.cos(y), 0, Math.sin(y)],
        [0, 1, 0],
        [-Math.sin(y), 0, Math.cos(y)],
      ],
    },
  };
}
function image(yaw: number, change: Record<string, string> = {}) {
  return new Response(jpeg, {
    headers: {
      "Content-Type": "image/jpeg",
      "X-Standin-Poster-Version": "default-body-poster-v1",
      "X-Standin-Poster-Kind": "default-body",
      "X-Standin-Source-BVH-SHA256": hash,
      "X-Standin-Output-Scope": "full",
      "X-Standin-Preview-Projection": "orthographic",
      "X-Standin-Preview-Only": "true",
      "X-Standin-Preview-Revision": "a".repeat(64),
      "X-Standin-Character-Id": "standin-master-v2",
      "X-Standin-Character-SHA256":
        "7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d",
      "X-Standin-Preview-Method": "frozen-native-scope8-v1",
      "X-Standin-Poster-Asset-Version": "scope8-v1",
      "X-Standin-Asset-Library-Version": "lib-20261021-12345678",
      "X-Standin-Artifact-SHA256": sha256Hex(jpeg),
      "X-Standin-Poster-Variant": "rough-yaw8-v1",
      "X-Standin-Poster-Yaw": String(yaw),
      "X-Standin-Poster-Fallback": "none",
      "X-Standin-Projection-Matches-Search": "false",
      "X-Standin-Preview-View": `yaw_${String((360 - yaw) % 360).padStart(3, "0")}`,
      ...change,
    },
  });
}

test("rounding wraps negative angles and ties; invalid/default cameras cannot pretend to be rough fits", () => {
  for (const [yaw, expected] of [
    [30, 45],
    [60, 45],
    [120, 135],
    [330, 315],
    [-45, 315],
    [359, 0],
    [22.5, 45],
    [337.5, 0],
  ])
    assert.equal(nearestYaw(yaw), expected);
  assert.throws(() => nearestYaw(NaN));
  assert.equal(posterCamera(camera(30)).selectedYaw, 45);
  assert.equal(
    posterCamera(camera(30, "semantic_preview")).source,
    "semantic_preview",
  );
  assert.equal(posterCamera(camera(30, "viewer_default")).requestedYaw, null);
  const broken = camera(30);
  broken.render_camera.rotation[0][0] = 0;
  assert.equal(posterCamera(broken).requestedYaw, null);
});

test("validates actual camera/fallback and native view sign before forwarding image", async () => {
  const c = posterCamera(camera(30)),
    options = posterOptions(c);
  const r = annotatePoster(
    await verifiedPoster("p", hash, async () => image(45), "full", options),
    c,
  );
  assert.equal(r.headers.get("X-Standin-Poster-Requested-Yaw"), "30");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  const changes: Record<string, string>[] = [
    { "X-Standin-Poster-Yaw": "90" },
    { "X-Standin-Preview-View": "yaw_045" },
    { "X-Standin-Artifact-SHA256": "f".repeat(64) },
    { "X-Standin-Source-BVH-SHA256": "f".repeat(64) },
  ];
  for (const change of changes)
    await assert.rejects(
      verifiedPoster("p", hash, async () => image(45, change), "full", options),
    );
  const front = await verifiedPoster(
    "p",
    hash,
    async () => image(0, { "X-Standin-Poster-Fallback": "missing_angle" }),
    "full",
    options,
  );
  assert.equal(front.headers.get("X-Standin-Poster-Yaw"), "0");
});

test("owned route selects each stored candidate camera and rejects forged view; no permissions promoted", async () => {
  const row = { candidate_id: "a", asset: { bvh_sha256: hash }, ...camera(30) };
  const candidate = {
    id: "a",
    poseId: "p",
    sourceBvhSha256: hash,
    lookupAllowed: true,
    releaseAllowed: false,
  };
  const job = {
    status: "completed",
    result: {
      candidatesByPerson: [
        {
          personIndex: 0,
          candidates: [candidate],
          posePresentation: {
            library_candidates: [row],
            review_candidates: [],
            generated_candidates: [],
          },
        },
      ],
    },
  } as unknown as Job;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("owner") ?? "owner");
    await next();
  });
  let calls = 0;
  app.route(
    "/",
    createDefaultPosterRoutes({
      getOwnedJob: async (_, owner) => (owner === "owner" ? job : undefined),
      getPoseBvh: async () => new Response(source),
      getPosePoster: async (_p, _s, _scope, options) => {
        calls++;
        assert.equal(options?.view, "yaw_045");
        return image(45);
      },
    }),
  );
  const url =
    "/p/poster?jobId=j&personIndex=0&candidateId=a&variant=rough-yaw8-v1";
  const r = await app.request(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Standin-Poster-Yaw"), "45");
  assert.equal((await app.request(url + "&view=yaw_180")).status, 409);
  assert.equal(
    (await app.request(url, { headers: { owner: "other" } })).status,
    404,
  );
  assert.equal(calls, 1);
  assert.equal(candidate.releaseAllowed, false);
});
