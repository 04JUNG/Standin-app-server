import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { AnalysisPerson, CandidateCamera } from "../types.js";
import type { CutResult, UpstreamPerson } from "../inference.js";
import { makeManualPresentation } from "../body-selection/fixtures.js";
import { mapCutResult } from "../mapping.js";
import { manualExportCandidate, restrictedCandidate } from "../routed-search.js";
import { candidateRefineAllowed, refinableLibraryCandidate } from "./eligibility.js";
import { createRefineRoutes } from "./routes.js";

function fixture() {
  const digest = "a".repeat(64), rotation = [[1,0,0],[0,1,0],[0,0,1]];
  const p = { personIndex: 0, candidates: [{ id: "old", poseId: "registered", rank: 1,
    camera: { source_bvh_sha256: digest, rotation } as CandidateCamera }] } as unknown as AnalysisPerson;
  makeManualPresentation(p);
  const row = p.posePresentation!.library_candidates[0]!;
  row.camera_kind = "fixed_117"; row.render_camera.projection_matches_search = true;
  const keypoints = Array.from({ length: 17 }, (_,i) => [i*2, i*3]);
  const bytes = Buffer.alloc(136); keypoints.flat().forEach((v,i) => bytes.writeFloatLE(v,i*4));
  const camera: CandidateCamera = { version: "candidate-camera-v2", reference: "search-fit", rotation,
    source_bvh_sha256: digest, canonical_yaw: 0, display_view: "front", status: "fitted", fit_error: .2,
    facing_source: "geometry_only", depth_ambiguous: true, projection: "orthographic", distance_torso: null,
    labels_swapped: false, pose_id: "registered", query_sha256: createHash("sha256").update(bytes).digest("hex"),
    observed_joint_mask: Array(17).fill(true) };
  const person: UpstreamPerson = { index: 0, box: null, tags: {}, skeleton: null, confidence: "low", candidates: [],
    pose_presentation: { ...p.posePresentation, source: "dynamic_search", library_candidates: [{ ...row, asset: {
      transport: "library_bvh", bvh_sha256: digest, bvh_url: "/pose/registered/bvh", bvh: null, encoding: null, library_lookup_supported: true } }] },
    refine_allowed: true, refinable_limbs: ["left_arm"], skeleton_state: "valid", coverage_class: "full",
    slot_origin: "vlm", skeleton_source: "full_image", keypoints, scores: Array(17).fill(.9),
    refine_candidates: [{ pose_id: "registered", view: "front", distance: .2, tags: {}, rerank_score: null,
      bvh_url: "/pose/registered/bvh", thumbnail_url: null, camera }] };
  const cut = { route: "core", people: [person], notes: [], count_confidence: "high", detector_count: 1, vlm_count: 1,
    image: { width: 100, height: 100 }, inference_metadata: {} } as unknown as CutResult;
  return { cut, person, camera };
}

test("dynamic binding survives mapping/manual upgrade while automatic release stays restricted", () => {
  const f = fixture(), p = mapCutResult("job", f.cut).candidatesByPerson[0]!, c = p.candidates[0]!;
  assert.equal(p.refineAllowed, true); assert.equal(c.refineAllowed, true);
  assert.deepEqual(c.camera, f.camera); assert.equal(c.distance, .2);
  assert.equal(c.releaseAllowed, false); assert.equal(c.actualMeshValidated, false);
  assert.equal(refinableLibraryCandidate(c), true); assert.equal(candidateRefineAllowed(c), true);
  assert.equal(manualExportCandidate(c), true); assert.equal(restrictedCandidate(c), true);
});

for (const mutation of ["old-server", "person-disabled", "query", "source", "rotation", "near"])
  test(`invalid dynamic refine binding stays off: ${mutation}`, () => {
    const f = fixture();
    if (mutation === "old-server") delete f.person.refine_candidates;
    if (mutation === "person-disabled") f.person.refine_allowed = false;
    if (mutation === "query" && f.camera.version === "candidate-camera-v2") f.camera.query_sha256 = "b".repeat(64);
    if (mutation === "source") f.camera.source_bvh_sha256 = "b".repeat(64);
    if (mutation === "rotation") f.camera.rotation = [[0,0,1],[0,1,0],[-1,0,0]];
    if (mutation === "near") (f.person.pose_presentation as { library_candidates: Array<{ kind: string }> }).library_candidates[0]!.kind = "near_match";
    const p = mapCutResult("job", f.cut).candidatesByPerson[0]!;
    assert.equal(p.refineAllowed, false); assert(p.candidates.every(c => c.refineAllowed === false));
  });

test("owned eligible library candidate reaches refine; a reference does not", async () => {
  const f = fixture(), result = mapCutResult("job", f.cut), c = result.candidatesByPerson[0]!.candidates[0]!;
  let calls = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (ctx,next) => { ctx.set("installationId", "owner"); await next(); });
  app.route("/", createRefineRoutes({ getOwnedJob: async () => ({ status: "completed", result }) as never,
    validateExportCandidate: async () => true, runRefine: async () => {
      calls++; return { refined: true, reasonCode: "ok", adjustedLimbs: ["left_arm"], poseId: "registered", thumbnailAvailable: false };
    } }));
  const request = () => app.request("/job/people/0/refine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidateId: c.id }) });
  assert.equal((await request()).status, 200); assert.equal(calls, 1);
  c.presentationKind = "near_match";
  assert.equal((await request()).status, 409); assert.equal(calls, 1);
});
