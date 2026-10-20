import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";
import type { CutResult } from "./inference.js";
import { createReleaseGuard } from "./release-policy.js";
import { mapCutResult } from "./mapping.js";
import { mapRoutedSearch, restrictedCandidate } from "./routed-search.js";
import { createRoutedPreviewRoutes } from "./routed-preview.js";
import { createRefineRoutes } from "./refine/routes.js";
import { createFramingRoutes } from "./output-scope/framingRoutes.js";

const row = {
  pose_id: "pose 1",
  kind: "library_original",
  rank_score: 0.01,
  family: "family",
  lookup_allowed: true,
  refine_allowed: false,
  release_allowed: false,
  actual_mesh_validated: false,
  camera: { yaw: 45, pitch: 30, distance: 4 },
};
const report = {
  version: "fullbody-dynamic-v1",
  route: "hybrid",
  status: "ok",
  selected: [row],
  near_candidates: [row],
  framing_references: [row],
  generation: { status: "not_requested" },
};
function fixture(): CutResult {
  return {
    route: "core",
    count_confidence: "high",
    detector_count: 1,
    vlm_count: 1,
    image: { width: 100, height: 200 },
    notes: [],
    inference_metadata: {
      deployment_version: "test",
      vlm_provider: "mock",
      vlm_model: "mock",
      pose_backend: "mock",
      pose_model_version: "test",
      pose_library_version: "v1",
      feature_version: 1,
    },
    people: [
      {
        index: 0,
        box: null,
        tags: {},
        skeleton: null,
        confidence: "high",
        candidates: [],
        refine_allowed: true,
        dynamic_search: report,
      },
    ],
  };
}
const mapped = () => mapCutResult("job", fixture());
test("dynamic selected survives public mapping and persisted JSON without gaining permissions or distance", () => {
  const result = JSON.parse(JSON.stringify(mapped()));
  const person = result.candidatesByPerson[0];
  assert.equal(person.candidateCount, 1);
  assert.equal(person.fallbackMode, "soft");
  assert.equal(person.refineAllowed, false);
  assert.deepEqual(person.refinableLimbs, []);
  assert.equal(person.routedSearch.route, "hybrid");
  assert.equal(person.routedSearch.nearCandidateCount, 1);
  const c = person.candidates[0];
  assert.equal(c.source, "dynamic");
  assert.equal(c.rankScore, 0.01);
  assert.equal(c.distance, undefined);
  assert.equal(c.matchLevel, "low");
  assert.equal(c.bvhAvailable, false);
  assert.equal(c.lookupAllowed, true);
  assert.equal(c.releaseAllowed, false);
  assert.equal(c.refineAllowed, false);
  assert.deepEqual(c.searchCamera, row.camera);
  assert.equal(restrictedCandidate(c), true);
});
test("semantic legacy candidates remain independent of geometry distance and unsafe URLs", () => {
  const f = fixture();
  delete f.people[0].dynamic_search;
  f.people[0].search_routing = { route: "semantic", search: { status: "ok" } };
  f.people[0].semantic_candidates = [
    {
      pose_id: "pose 1",
      score: 42,
      pose: {
        thumbnail_url: "https://evil.test",
        bvh_url: "https://evil.test",
      },
    },
  ];
  const c = mapCutResult("job", f).candidatesByPerson[0].candidates[0];
  assert.equal(c.rankScore, 42);
  assert.equal(c.distance, undefined);
  assert.ok(c.thumbnailUrl?.startsWith("/v1/pose-candidates/"));
  assert.equal(c.source, "semantic");
  assert.equal(c.releaseAllowed, false);
});
for (const field of [
  "refine_allowed",
  "release_allowed",
  "actual_mesh_validated",
]) {
  test(`refuses upstream permission escalation: ${field}`, () => {
    const f = fixture();
    f.people[0].dynamic_search = {
      ...report,
      selected: [{ ...row, [field]: true }],
    };
    const p = mapCutResult("job", f).candidatesByPerson[0];
    assert.equal(p.candidateCount, 0);
    assert.equal(p.routedSearch?.status, "error");
  });
}
test("near, generation, basic and framing outputs never become selected candidates", () => {
  const f = fixture();
  f.people[0].dynamic_search = {
    ...report,
    route: "basic_model",
    selected: [],
    basic_model: {},
    generation: { status: "preview_ready", candidates: [row] },
  };
  const p = mapCutResult("job", f).candidatesByPerson[0];
  assert.equal(p.candidateCount, 0);
  assert.equal(p.routedSearch?.basicModel, true);
  assert.equal(p.routedSearch?.generatedCandidateCount, 1);
});
test("legacy geometric routing keeps original mapping and mixed people keep their own policies", () => {
  assert.equal(
    mapRoutedSearch("job", {
      index: 0,
      search_routing: { route: "geometric" },
    }),
    null,
  );
  const f = fixture();
  f.people.push({
    ...f.people[0],
    index: 1,
    dynamic_search: undefined,
    candidates: [
      {
        pose_id: "legacy",
        view: "front",
        distance: 0.1,
        tags: {},
        rerank_score: null,
        bvh_url: "/pose/legacy/bvh",
        thumbnail_url: null,
      },
    ],
  });
  const people = mapCutResult("job", f).candidatesByPerson;
  assert.equal(people[0].refineAllowed, false);
  assert.equal(people[1].refineAllowed, true);
  assert.equal(people[1].candidates[0].distance, 0.1);
});
for (const status of [
  "no_result",
  "error",
  "undetermined",
  "blocked",
  "not_run",
  "partial_error",
]) {
  test(`routing status ${status} remains visible and cannot imply legacy success`, () => {
    const f = fixture();
    f.people[0].dynamic_search = {
      ...report,
      status,
      selected: status === "partial_error" ? [row] : [],
    };
    const p = mapCutResult("job", f).candidatesByPerson[0];
    assert.equal(p.routedSearch?.status, status);
    assert.equal(p.candidateCount, status === "partial_error" ? 1 : 0);
  });
}

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "request");
    await next();
  });
  return a;
}
const job = { status: "completed", result: mapped() } as Job;
test("lookup thumbnails enforce job ownership and pose/candidate membership", async () => {
  let calls = 0;
  const a = app();
  a.route(
    "/",
    createRoutedPreviewRoutes({
      getOwnedJob: async (id, owner) =>
        id === "job" && owner === "owner" ? job : undefined,
      getPoseThumbnail: async (pose, view) => {
        calls++;
        assert.equal(pose, "pose 1");
        assert.equal(view, "front");
        return new Response("jpeg");
      },
    }),
  );
  const query = new URLSearchParams({
    jobId: "job",
    personIndex: "0",
    candidateId: "dynamic::pose 1",
  });
  assert.equal(
    (await a.request(`/pose%201/lookup-thumbnail?${query}`)).status,
    200,
  );
  for (const [k, value] of [
    ["jobId", "foreign"],
    ["personIndex", "1"],
    ["candidateId", "spoof"],
  ]) {
    const q = new URLSearchParams(query);
    q.set(k, value);
    assert.equal(
      (await a.request(`/pose%201/lookup-thumbnail?${q}`)).status,
      409,
    );
  }
  assert.equal(calls, 1);
});
test("direct refine request cannot bypass review-only policy even after confirmation", async () => {
  let calls = 0;
  const a = app();
  a.route(
    "/",
    createRefineRoutes({
      getOwnedJob: async () => job,
      validateExportCandidate: async () => true,
      runRefine: async () => {
        calls++;
        throw new Error("must not call");
      },
    }),
  );
  const response = await a.request("/job/people/0/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateId: "dynamic::pose 1",
      refineAllowed: true,
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "CANDIDATE_REFINE_FORBIDDEN",
  );
  assert.equal(calls, 0);
});
test("framed FBX export cannot bypass review-only policy with a confirmed selection", async () => {
  let calls = 0;
  const a = app();
  a.route(
    "/",
    createFramingRoutes({
      getOwnedJob: async () => job,
      validateExportCandidate: async () => true,
      resolveExportArtifact: async () => {
        calls++;
        throw new Error("must not resolve");
      },
    }),
  );
  const q = new URLSearchParams({
    jobId: "job",
    personIndex: "0",
    candidateId: "dynamic::pose 1",
    outputScope: "full",
    format: "fbx",
  });
  const response = await a.request(`/pose%201/framed?${q}`);
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "CANDIDATE_RELEASE_FORBIDDEN",
  );
  assert.equal(calls, 0);
});

for (const format of ["bvh", "fbx"]) {
  test(`base ${format} release guard refuses restricted candidates before any artifact work`, async () => {
    let artifactCalls = 0;
    const a = app();
    a.use(
      "/:id/export",
      createReleaseGuard(async () => job),
    );
    a.get("/:id/export", (c) => {
      artifactCalls++;
      return c.text("bytes");
    });
    const q = new URLSearchParams({
      jobId: "job",
      personIndex: "0",
      candidateId: "dynamic::pose 1",
      format,
      releaseAllowed: "true",
    });
    const response = await a.request(`/pose%201/export?${q}`);
    assert.equal(response.status, 409);
    assert.equal(artifactCalls, 0);
  });
}

test("manual library release requires stored permission and a source hash", async () => {
  const allowed = structuredClone(job);
  const candidate = allowed.result!.candidatesByPerson[0].candidates[0];
  candidate.source = "library";
  candidate.releaseAllowed = true;
  candidate.lookupAllowed = true;
  candidate.sourceBvhSha256 = "a".repeat(64);
  const a = app();
  a.use("/:id/export", createReleaseGuard(async () => allowed));
  a.get("/:id/export", (c) => c.text("permitted after confirmation"));
  const path = "/pose%201/export?jobId=job&personIndex=0&candidateId=dynamic%3A%3Apose%201";
  assert.equal((await a.request(path)).status, 200);
  candidate.releaseAllowed = false;
  assert.equal((await a.request(path)).status, 409);
  candidate.releaseAllowed = true;
  candidate.sourceBvhSha256 = undefined;
  assert.equal((await a.request(path)).status, 409);
});
