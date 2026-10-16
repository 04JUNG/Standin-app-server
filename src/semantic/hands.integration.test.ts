import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { PoolClient } from "pg";
import type { AppEnv } from "../env.js";
import type { AnalysisResult } from "../types.js";
import type { Job } from "../jobs/store.js";
import type { RefineContext } from "../mapping.js";
import { parseCatalog } from "../hands/model.js";
import { createHandStore } from "../hands/store.js";
import { createHandSelectionRoutes } from "../hands/routes.js";
import { createSemanticRoutes } from "./routes.js";
import { createFramingRoutes } from "../output-scope/framingRoutes.js";
import { createPresentationRoutes } from "../pose-presentation.js";
import { createReleaseGuard } from "../release-policy.js";
import { createRefineRoutes } from "../refine/routes.js";

/** Real route/store composition. External search, BVH and database are fixtures. */
test("direct text -> owned BVH preview -> hands persist, without refine or any release", async () => {
  const catalog = parseCatalog({
    schema_version: 1,
    library_version: "hands-v1",
    library_sha256: "a".repeat(64),
    default_preset: "relaxed",
    fallback_order: ["relaxed"],
    thumbnails_available: false,
    categories: [
      {
        id: "basic",
        label: "기본",
        presets: ["relaxed", "fist"].map((id) => ({
          id,
          label: id,
          description: id,
          thumbnails: null,
        })),
      },
    ],
  });
  const id = "job_semantic_hands";
  let encoded = "",
    contexts: RefineContext[] = [],
    changed = false,
    forbiddenCalls = 0;
  const bvh = () =>
    Buffer.from(`HIERARCHY fixture${changed ? ":changed" : ""}`);
  const load = (): AnalysisResult => JSON.parse(encoded);
  const owned = async (job: string, owner: string) =>
    job === id && owner === "owner"
      ? ({ id, status: "completed", result: load() } as Job)
      : undefined;
  const store = createHandStore({
    catalog: async () => catalog,
    transaction: async (fn) =>
      fn({
        query: async (sql: string, params: unknown[]) => {
          if (sql.startsWith("SELECT"))
            return {
              rows:
                params[0] === id && params[1] === "owner"
                  ? [{ status: "completed", result_json: encoded }]
                  : [],
            };
          encoded = params[1] as string;
          return { rows: [] };
        },
      } as unknown as PoolClient),
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("X-Test-Owner") ?? "owner");
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/search",
    createSemanticRoutes({
      enabled: () => true,
      consume: async () => true,
      search: async () => ({
        status: "ok",
        error: null,
        query: { text: "던지는 자세", source: "user" },
        score_is_accuracy: false,
        generation_requested: false,
        near_candidates: [],
        pose_library: { version: "poses-v1" },
        candidates: [
          {
            rank: 1,
            pose_id: "throw_mirror",
            score: 0.8,
            refine_allowed: false,
            release_allowed: false,
            actual_mesh_validated: false,
            pose: {
              schema: "standin-pose-record-v1",
              pose_id: "throw_mirror",
              description: "던지기",
              tags: {},
              thumbnail_urls: {},
            },
          },
        ],
      }),
      getPoseBvh: async () => new Response(bvh()),
      createJob: async () => ({ id }) as Job,
      persist: async (_id, result, privateContexts) => {
        encoded = JSON.stringify(result);
        contexts = privateContexts ?? [];
      },
      capabilities: async () => ({
        handSelection: true,
        refine: true,
        fbxExport: true,
        characterSelection: true,
        bodyPreviews: true,
        bodySelection: false,
        bodyRecommendation: false,
        bodyPreviewAssets: false,
        outputScopeSelection: false,
        outputScopeCropping: false,
        modelPreview: false,
      }),
    }),
  );
  app.route("/jobs", createHandSelectionRoutes(store));
  app.route(
    "/v1/analysis/jobs",
    createPresentationRoutes({
      getOwnedJob: owned,
      loadAssets: async () => contexts[0]!.posePresentationAssets!,
      getPoseBvh: async () => new Response(bvh()),
    }),
  );
  app.route(
    "/jobs",
    createRefineRoutes({
      getOwnedJob: owned,
      validateExportCandidate: async () => true,
      runRefine: async () => {
        forbiddenCalls++;
        throw Error("forbidden");
      },
    }),
  );
  app.use("/poses/:id/export", createReleaseGuard(owned));
  app.get("/poses/:id/export", (c) => {
    forbiddenCalls++;
    return c.text("forbidden");
  });
  app.route(
    "/poses",
    createFramingRoutes({
      getOwnedJob: owned,
      validateExportCandidate: async () => true,
      converterEnabled: () => true,
      resolveExportArtifact: async () => {
        forbiddenCalls++;
        throw Error("forbidden");
      },
    }),
  );
  const search = await app.request("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "던지는 자세" }),
  });
  assert.equal(search.status, 200);
  const result = load(),
    p = result.candidatesByPerson[0]!;
  assert.equal(result.capabilities.refine, false);
  assert.equal(result.capabilities.handSelection, true);
  assert.equal(result.image, null);
  assert.equal(p.posePresentation?.library_candidates.length, 1);
  assert.equal(p.candidates[0]!.poseId, "throw_mirror");
  const previewUrl =
    p.posePresentation!.library_candidates[0]!.asset.preview_bvh_url;
  assert.equal((await app.request(previewUrl)).status, 200);
  assert.equal(
    (await app.request(previewUrl, { headers: { "X-Test-Owner": "other" } }))
      .status,
    404,
  );
  const handUrl = `/jobs/${id}/people/0/hands`;
  assert.equal((await app.request(handUrl)).status, 200);
  assert.equal(
    (await app.request(handUrl, { headers: { "X-Test-Owner": "other" } }))
      .status,
    404,
  );
  const put = (revision: number) =>
    app.request(handUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        left: "fist",
        library_sha256: catalog.library_sha256,
        expectedRevision: revision,
      }),
    });
  assert.equal((await put(0)).status, 200);
  assert.equal((await put(0)).status, 409);
  assert.equal(load().candidatesByPerson[0]!.handSelection?.left, "fist");
  assert.equal(load().semantic?.query, "던지는 자세");
  assert.equal(
    load().candidatesByPerson[0]!.candidates[0]!.releaseAllowed,
    false,
  );
  assert.equal((await app.request(previewUrl)).status, 200); // Hand references cannot change the BVH binding.
  // Even an old/malformed candidate that omits or escalates its flags cannot
  // bypass the policy attached to a text-search job.
  const stored = load();
  Object.assign(stored.candidatesByPerson[0]!.candidates[0]!, {
    source: undefined,
    releaseAllowed: true,
    refineAllowed: true,
  });
  encoded = JSON.stringify(stored);
  const query = new URLSearchParams({
    jobId: id,
    personIndex: "0",
    candidateId: p.candidates[0]!.id,
    format: "fbx",
    outputScope: "full",
    characterId: "male",
    reviewKey: "a".repeat(64),
    handSelectionRevision: "1",
  });
  for (const format of ["bvh", "fbx"]) {
    query.set("format", format);
    assert.equal(
      (await app.request(`/poses/throw_mirror/export?${query}`)).status,
      409,
    );
  }
  query.set("format", "fbx");
  assert.equal(
    (await app.request(`/poses/throw_mirror/framed?${query}`)).status,
    409,
  );
  assert.equal(
    (
      await app.request(`/jobs/${id}/people/0/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: p.candidates[0]!.id }),
      })
    ).status,
    409,
  );
  assert.equal(forbiddenCalls, 0);
  changed = true;
  assert.equal((await app.request(previewUrl)).status, 409);
});
