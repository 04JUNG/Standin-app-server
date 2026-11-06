import { interactiveEnabled } from "../interactive-state/runtime.js";
import { randomUUID } from "node:crypto";
import { inferenceStatus } from "../inference.js";
import {
  materialize,
  assertLibrary,
  paging,
  SEMANTIC_PAGE_SIZE,
  saveSnapshot,
  readPage,
  SemanticPageError,
} from "./pages.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { semanticReadiness, searchSemantic, getPoseBvh } from "../inference.js";
import {
  createSemanticJob,
  persistAnalysisRecords,
  updateJob,
} from "../jobs/store.js";
import { currentCapabilities } from "../characters/service.js";
import { errorEnvelope } from "../mapping.js";
import { fixedWindow } from "../limits/policy.js";
import { tryConsume } from "../limits/store.js";
import {
  readSearchInput,
  readSearchResponse,
  semanticResult,
  SemanticError,
  SEMANTIC_MAX_TOP_K,
} from "./contract.js";
import { attachSemanticPresentation } from "./presentation.js";

const defaults = {
  enabled: () => config.semanticSearchEnabled,
  readiness: semanticReadiness,
  search: searchSemantic,
  getPoseBvh,
  createJob: createSemanticJob,
  persist: persistAnalysisRecords,
  updateJob,
  capabilities: async (): Promise<
    Awaited<ReturnType<typeof currentCapabilities>> & {
      selectionPreview?: boolean;
    }
  > => ({
    ...(await currentCapabilities()),
    ...(interactiveEnabled() ? { selectionPreview: true } : {}),
  }),
  library: inferenceStatus,
  saveSnapshot,
  readPage,
  consume: (owner: string) =>
    tryConsume(
      "semantic_search",
      owner,
      fixedWindow(Date.now(), 60),
      config.semanticSearchPerMinute,
    ),
};
export function createSemanticRoutes(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/capabilities", async (c) =>
    c.json(
      {
        available: deps.enabled() && (await deps.readiness()),
        maxQueryLength: 500,
        maxTopK: SEMANTIC_MAX_TOP_K,
        supportsAllResults: true,
        supportsProgressiveResults: true,
      },
      200,
      { "Cache-Control": "private, no-store" },
    ),
  );
  routes.get("/:jobId/pages", async (c) => {
    try {
      const result = await deps.readPage(
        c.get("installationId")!,
        c.req.param("jobId"),
        c.req.query("cursor") ?? "",
        c.req.raw.signal,
        { getPoseBvh: deps.getPoseBvh, library: deps.library },
      );
      return c.json(result, 200, { "Cache-Control": "private, no-store" });
    } catch (error) {
      const status = error instanceof SemanticPageError ? error.status : 503;
      return c.json(
        errorEnvelope(
          error instanceof SemanticPageError
            ? error.code
            : "SEMANTIC_UNAVAILABLE",
          "포즈를 더 불러오지 못했어요. 다시 시도해 주세요.",
          c.get("requestId"),
        ),
        status,
      );
    }
  });
  routes.use(
    "/",
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json(
          errorEnvelope(
            "INVALID_INPUT",
            "검색어는 500자 이내로 입력해 주세요.",
            c.get("requestId"),
          ),
          413,
        ),
    }),
  );
  routes.post("/", async (c) => {
    const fail = (code: string, status: 400 | 502 | 503) =>
      c.json(
        errorEnvelope(
          code,
          "자연어 검색을 완료하지 못했습니다.",
          c.get("requestId"),
        ),
        status,
      );
    if (!deps.enabled()) return fail("SEMANTIC_UNAVAILABLE", 503);
    let input;
    try {
      input = readSearchInput(await c.req.json());
    } catch {
      return fail("INVALID_INPUT", 400);
    }
    const owner = c.get("installationId")!;
    if (!(await deps.consume(owner)))
      return c.json(
        errorEnvelope(
          "RATE_LIMITED",
          "잠시 후 다시 검색해 주세요.",
          c.get("requestId"),
        ),
        429,
        { "Retry-After": "60" },
      );
    let jobId: string | undefined;
    try {
      const deadline = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(config.semanticSearchTimeoutMs),
      ]);
      const upstream = await deps.search(input.query, input.topK, deadline);
      const response = readSearchResponse(upstream, input.topK, input.query);
      if (!response.groups.length)
        return c.json({ status: "no_result", jobId: null }, 200, {
          "Cache-Control": "private, no-store",
        });
      // Pin the actual original/mirror BVH bytes. Scores never become geometric confidence.
      const progressive = (await c.req.json()).progressive === true;
      const groups = progressive
        ? response.groups.slice(0, SEMANTIC_PAGE_SIZE)
        : response.groups;
      if (progressive) await assertLibrary(response.index, deps.library);
      const candidates = await materialize(groups, deadline, deps.getPoseBvh);
      if (progressive) await assertLibrary(response.index, deps.library);
      const job = await deps.createJob(owner, c.get("userId") ?? null);
      jobId = job.id;
      const result = semanticResult(
        job.id,
        input.query,
        response.index,
        candidates,
        await deps.capabilities(),
      );
      if (progressive)
        result.semantic!.paging = paging(
          randomUUID(),
          response.groups,
          candidates.length,
        );
      // Rows and completed result publish together. An export can only address exposed candidates.
      await deps.persist(
        job.id,
        result,
        [attachSemanticPresentation(result)],
        [],
        null,
        true,
      );
      if (progressive)
        await deps.saveSnapshot(
          job.id,
          result.semantic!.paging!.snapshotId,
          response.groups,
        );
      return c.json({ status: "ok", jobId: job.id }, 200, {
        "Cache-Control": "private, no-store",
      });
    } catch (error) {
      if (jobId)
        await deps.updateJob(jobId, {
          status: "failed",
          errorCode: "SEMANTIC_FAILED",
        });
      if (error instanceof SemanticPageError)
        return c.json(
          errorEnvelope(
            error.code,
            "포즈 목록이 바뀌었어요. 다시 검색해 주세요.",
            c.get("requestId"),
          ),
          error.status,
        );
      if (error instanceof SemanticError) return fail(error.code, error.status);
      return fail("SEMANTIC_UNAVAILABLE", 503);
    }
  });
  return routes;
}
