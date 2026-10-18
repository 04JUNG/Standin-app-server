import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type {
  PreviewCandidate,
  PrivatePreviewAsset,
} from "../pose-presentation.js";
import { readHands, type HandSelection } from "./model.js";
import { createHandPreviewRoutes } from "./preview.js";
import { resolveOutputScope } from "../output-scope/model.js";
function fixture(inline = false) {
  const text = "HIERARCHY authored fixture",
    hash = createHash("sha256").update(text).digest("hex"),
    id = "preview_" + "b".repeat(64),
    job = "job_" + randomUUID();
  const selection: HandSelection = {
    personIndex: 0,
    left: "fist",
    right: "relaxed",
    recommended: { left: "relaxed", right: "relaxed" },
    observation: readHands(null),
    library_version: "v1",
    library_sha256: "c".repeat(64),
    revision: 1,
    changed: ["left"],
  };
  const candidate = {
    candidate_id: id,
    pose_id: inline ? null : "pose",
    render_camera: {
      version: "pose-preview-camera-v1",
      projection: "orthographic",
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      yaw_degrees: 0,
      pitch_degrees: 0,
      roll_degrees: 0,
      distance_torso: null,
      basis: "right-handed-Y-up",
      rotation_order: "Rz@Rx@Ry_column_vectors",
      origin: "hip_midpoint",
      scale: "hip_to_shoulder_midpoint_length",
      screen_y: "down",
      projection_rule: "xy=(x,-y)",
      projection_matches_search: false,
      fit_to_rough_pixels: false,
      bvh_camera_rotation_applied: false,
    },
    asset: {
      transport: inline ? "inline_bvh" : "library_bvh",
      bvh_sha256: hash,
    },
  } as PreviewCandidate;
  const asset: PrivatePreviewAsset = {
    transport: inline ? "inline_bvh" : "library_bvh",
    pose_id: inline ? null : "pose",
    bvh_sha256: hash,
    ...(inline ? { bvh: text } : {}),
  };
  const result = {
    id: job,
    status: "completed",
    result: {
      candidatesByPerson: [
        {
          personIndex: 0,
          posePresentation: {
            output_scope: "half",
            library_candidates: inline ? [] : [candidate],
            review_candidates: [],
            generated_candidates: inline ? [candidate] : [],
          },
        },
      ],
    },
  } as unknown as Job;
  const state = {
    owned: true,
    rate: true,
    calls: 0,
    expectedScope: "half",
    reads: 0,
    changed: false,
    after: () => {},
    selection,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("Owner") ?? "owner");
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/jobs",
    createHandPreviewRoutes({
      getOwnedJob: async (j, o) =>
        state.owned && j === job && o === "owner" ? result : undefined,
      loadAssets: async () => ({ [id]: asset }),
      selection: async () => structuredClone(state.selection),
      handBakeFor: async (p) =>
        p?.handSelection ? { ...p.handSelection } : null,
      characterId: () => "standin-master-v2",
      checkCharacter: async () => "ok",
      consume: async () => state.rate,
      getPoseBvh: async () => {
        state.reads++;
        return new Response(text + (state.changed ? "changed" : ""));
      },
      convertFramed: async (input) => {
        state.calls++;
        assert.deepEqual(
          input.cameraRotation,
          candidate.render_camera.rotation,
        );
        assert.equal(input.scope, state.expectedScope);
        assert.equal(input.hands?.left, "fist");
        state.after();
        return {
          fbx: Buffer.from("private FBX never returned"),
          preview: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          conversionId: "test",
          artifactSha256: "d".repeat(64),
          sourceBvhSha256: hash,
        };
      },
    }),
  );
  const url = `/jobs/${job}/people/0/pose-previews/${id}/${hash}/hands?revision=1`;
  return { app, state, url, result };
}
test("hand lookup emits PNG-only, pinned hand revision and library, never FBX", async () => {
  const { app, state, url } = fixture();
  const r = await app.request(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.equal(r.headers.get("X-Standin-Preview-Only"), "true");
  assert.equal(r.headers.get("X-Standin-Hand-Revision"), "1");
  assert.equal((await r.arrayBuffer()).byteLength, 8);
  assert.equal(state.calls, 1);
});
test("hand preview rejects another owner, stale revision, changed BVH and rate limit", async () => {
  const { app, state, url } = fixture();
  assert.equal(
    (await app.request(url, { headers: { Owner: "other" } })).status,
    404,
  );
  assert.equal(
    (await app.request(url.replace("revision=1", "revision=0"))).status,
    409,
  );
  state.changed = true;
  assert.equal((await app.request(url)).status, 409);
  state.changed = false;
  state.rate = false;
  assert.equal((await app.request(url)).status, 429);
  assert.equal(state.calls, 0);
});
test("inline generated hand preview never resolves a library pose ID", async () => {
  const { app, state, url } = fixture(true);
  assert.equal((await app.request(url)).status, 200);
  assert.equal(state.reads, 0);
});
test("changed hands during conversion discard the stale PNG", async () => {
  const { app, state, url } = fixture();
  state.after = () => {
    state.selection.revision++;
  };
  assert.equal((await app.request(url)).status, 409);
});
test("stored scope wins over presentation for hand preview; late scope changes are rejected", async () => {
  const { app, state, url, result } = fixture();
  const person = result.result!.candidatesByPerson[0];
  person.outputScope = resolveOutputScope({
    selection: "bust",
    detected: "half",
  });
  state.expectedScope = "bust";
  state.after = () => {
    person.outputScope = resolveOutputScope({ selection: "head" });
  };
  assert.equal((await app.request(url)).status, 409);
  assert.equal(state.calls, 1);
});
test("revoked ownership during conversion discards the PNG", async () => {
  const { app, state, url } = fixture();
  state.after = () => {
    state.owned = false;
  };
  assert.equal((await app.request(url)).status, 409);
});

test("hand lookup cannot be switched to a release format", async () => {
  const { app, state, url } = fixture();
  assert.equal((await app.request(url + "&format=fbx")).status, 400);
  assert.equal(state.calls, 0);
});
