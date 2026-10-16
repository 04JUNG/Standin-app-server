import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { AnalysisResult } from "../types.js";
import {
  readSearchInput,
  readSearchResponse,
  semanticCapabilities,
} from "./contract.js";
import { createSemanticRoutes } from "./routes.js";
import { config } from "../config.js";
import { searchSemantic, semanticReadiness } from "../inference.js";
import { sha256Hex } from "../converter/client.js";

function response() {
  return {
    status: "ok",
    error: null,
    query: { text: "던지는 자세", source: "user" },
    score_is_accuracy: false,
    generation_requested: false,
    pose_library: { version: "lib" },
    near_candidates: [],
    candidates: ["throw", "throw_mirror"].map((id, i) => ({
      rank: i + 1,
      pose_id: id,
      score: 0.8 - i * 0.1,
      refine_allowed: false,
      release_allowed: false,
      actual_mesh_validated: false,
      pose: {
        schema: "standin-pose-record-v1",
        pose_id: id,
        description: "공을 던지는 자세",
        tags: { pose_action: [{ label: "던지기" }] },
        thumbnail_urls: { front: "https://internal.invalid/must-not-use" },
      },
    })),
  };
}
function setup() {
  const state = {
    enabled: true,
    available: true,
    rate: true,
    upstream: response() as unknown,
    created: 0,
    calls: 0,
    result: null as AnalysisResult | null,
    missingBvh: false,
    failed: false,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "request");
    await next();
  });
  app.route(
    "/search",
    createSemanticRoutes({
      enabled: () => state.enabled,
      readiness: async () => state.available,
      consume: async (owner) => {
        assert.equal(owner, "owner");
        return state.rate;
      },
      search: async (query, k) => {
        assert.equal(query, "던지는 자세");
        assert.equal(k, 5);
        state.calls++;
        return state.upstream;
      },
      getPoseBvh: async (id) =>
        new Response(`HIERARCHY:${id}`, {
          status: state.missingBvh ? 409 : 200,
        }),
      createJob: async (owner) => {
        assert.equal(owner, "owner");
        state.created++;
        return { id: "job_test" } as Awaited<
          ReturnType<typeof import("../jobs/store.js").createSemanticJob>
        >;
      },
      persist: async (_id, result, contexts, signals, summary, complete) => {
        assert.equal(contexts?.length, 1);
        assert(Object.keys(contexts![0]!.posePresentationAssets!).length > 0);
        assert.deepEqual(signals, []);
        assert.equal(summary, null);
        assert.equal(complete, true);
        state.result = result;
      },
      updateJob: async () => {
        state.failed = true;
      },
      capabilities: async () => ({
        handSelection: true,
        refine: true,
        fbxExport: true,
        characterSelection: true,
        bodyPreviews: true,
        outputScopeCropping: true,
        bodySelection: true,
        bodyRecommendation: false,
        bodyPreviewAssets: false,
        outputScopeSelection: true,
        modelPreview: false,
      }),
    }),
  );
  const post = (body: unknown = { query: " 던지는 자세 " }) =>
    app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { state, app, post };
}
test("input bounds and provenance cannot be overridden", () => {
  assert.deepEqual(readSearchInput({ query: " 던지기 " }), {
    query: "던지기",
    topK: 5,
  });
  for (const body of [
    { query: " " },
    { query: "a".repeat(501) },
    { query: "a", source: "vlm" },
    { query: "a", tags: [] },
    { query: "a", topK: 11 },
    { query: "a", topK: 1.5 },
  ])
    assert.throws(() => readSearchInput(body));
});
test("owned job pins original and actual mirror ids, publishes no skeleton/refine/body camera", async () => {
  const { post, state } = setup();
  const res = await post();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", jobId: "job_test" });
  assert.equal(state.created, 1);
  const result = state.result!;
  assert.equal(result.source, "semantic");
  assert.equal(result.image, null);
  assert.equal(result.capabilities.refine, false);
  assert.equal(result.capabilities.handSelection, true);
  assert.equal(result.capabilities.bodyPreviews, false);
  assert.equal(result.capabilities.fbxExport, true);
  const p = result.candidatesByPerson[0]!;
  assert.equal(p.skeleton, null);
  assert.equal(p.refineAllowed, false);
  assert.deepEqual(
    p.candidates.map((c) => c.poseId),
    ["throw", "throw_mirror"],
  );
  assert.equal(
    p.candidates[1]!.sourceBvhSha256,
    sha256Hex(Buffer.from("HIERARCHY:throw_mirror")),
  );
  assert.equal(
    p.candidates[0]!.thumbnailUrl,
    "/v1/pose-candidates/throw/thumbnail?view=front",
  );
  assert.equal(p.candidates[1]!.semantic!.familyId, "throw_mirror");
  assert(
    p.candidates.every(
      (c) => c.source === "semantic" && c.releaseAllowed === false,
    ),
  );
  assert.equal(p.posePresentation?.library_candidates.length, 2);
  assert(!JSON.stringify(result).includes("internal.invalid"));
});
test("no_result never promotes near misses or creates an export context", async () => {
  const { post, state } = setup();
  state.upstream = {
    ...response(),
    status: "no_result",
    candidates: [],
    near_misses: [{ pose_id: "close", score: 0.3 }],
  };
  assert.deepEqual(await (await post()).json(), {
    status: "no_result",
    jobId: null,
  });
  assert.equal(state.created, 0);
});
test("disabled, readiness false, rate and payload guards are separate from no_result", async () => {
  const { post, state, app } = setup();
  state.enabled = false;
  assert.equal((await post()).status, 503);
  assert.equal(state.calls, 0);
  state.enabled = true;
  state.available = false;
  assert.equal(
    (
      (await (await app.request("/search/capabilities")).json()) as {
        available: boolean;
      }
    ).available,
    false,
  );
  state.rate = false;
  const rate = await post();
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get("Retry-After"), "60");
  state.rate = true;
  assert.equal((await post({ query: "a".repeat(5000) })).status, 413);
});
test("wrong record, invented refine permission, traversal and nonfinite scores fail closed", () => {
  for (const mutate of [
    (r: ReturnType<typeof response>) => {
      r.candidates[0]!.pose.pose_id = "other";
    },
    (r: ReturnType<typeof response>) => {
      r.candidates[0]!.refine_allowed = true;
    },
    (r: ReturnType<typeof response>) => {
      r.candidates[1]!.pose_id = "../other";
    },
    (r: ReturnType<typeof response>) => {
      r.candidates[0]!.score = NaN;
    },
  ]) {
    const r = response();
    mutate(r);
    assert.throws(() => readSearchResponse(r, 5));
  }
});
test("server rank stays intact even if review preference ranks a lower score first", () => {
  const r = response();
  const second = structuredClone(r.candidates[0]!);
  second.pose_id = second.pose.pose_id = "other";
  second.rank = 3;
  second.score = 0.99;
  r.candidates.push(second);
  assert.deepEqual(
    readSearchResponse(r, 5).groups.map((g) => g.variants[0]!.poseId),
    ["throw", "throw_mirror", "other"],
  );
});
test("unready index and mismatched pose are explicit errors, never empty success", async () => {
  const { post, state } = setup();
  state.upstream = {
    status: "error",
    error: { code: "semantic_unavailable", message: "secret" },
  };
  const res = await post();
  assert.equal(res.status, 503);
  assert(!JSON.stringify(await res.json()).includes("secret"));
  state.upstream = response();
  state.missingBvh = true;
  assert.equal((await post()).status, 503);
  assert.equal(state.created, 0);
});
test("live capabilities cannot re-enable refine when an old text result is reopened", () => {
  assert.equal(
    semanticCapabilities({
      refine: true,
      fbxExport: true,
      characterSelection: true,
      bodyPreviews: true,
    }).refine,
    false,
  );
});
test("inference uses internal auth, forced source user, bounded request and exact top_k", async (t) => {
  const old = globalThis.fetch,
    token = config.inferenceServiceToken;
  t.after(() => {
    globalThis.fetch = old;
    Object.assign(config, { inferenceServiceToken: token });
  });
  Object.assign(config, { inferenceServiceToken: "internal-test" });
  globalThis.fetch = async (url, init) => {
    assert(String(url).endsWith("/semantic-search"));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer internal-test",
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: "던지기",
      topK: 5,
    });
    assert(init?.signal);
    return Response.json(response());
  };
  assert.equal(
    ((await searchSemantic("던지기", 5)) as { status: string }).status,
    "ok",
  );
});
test("geometry health alone does not advertise semantic readiness", async (t) => {
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  globalThis.fetch = async () => Response.json({ status: "ok" });
  assert.equal(await semanticReadiness(), false);
  globalThis.fetch = async () =>
    Response.json({ semantic_text: { ready: true } });
  assert.equal(await semanticReadiness(), true);
});

test("near-only response stays a reference group and every release escalation fails closed", async () => {
  const { state, post } = setup();
  const near = structuredClone(response().candidates[0]!);
  state.upstream = {
    ...response(),
    status: "no_result",
    candidates: [],
    near_candidates: [near],
  };
  assert.equal((await post()).status, 200);
  const p = state.result!.candidatesByPerson[0]!.posePresentation!;
  assert.equal(p.search_status, "no_result");
  assert.equal(p.library_candidates.length, 0);
  assert.equal(p.review_candidates.length, 1);
  assert.equal(p.review_candidates[0]!.release_allowed, false);
  for (const field of ["release_allowed", "actual_mesh_validated"]) {
    const invalid = response();
    Object.assign(invalid.candidates[0]!, { [field]: true });
    assert.throws(() => readSearchResponse(invalid, 5));
  }
});
