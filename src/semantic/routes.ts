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
import { sha256Hex } from "../converter/client.js";
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
import type { PoseCandidate } from "../types.js";
import { attachSemanticPresentation } from "./presentation.js";

async function previewBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader || Number(response.headers.get("Content-Length")) > 2_000_000)
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2_000_000) throw new SemanticError("SEMANTIC_CONTRACT", 502);
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    if (
      !new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .startsWith("HIERARCHY")
    )
      throw new SemanticError("SEMANTIC_CONTRACT", 502);
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const defaults = {
  enabled: () => config.semanticSearchEnabled,
  readiness: semanticReadiness,
  search: searchSemantic,
  getPoseBvh,
  createJob: createSemanticJob,
  persist: persistAnalysisRecords,
  updateJob,
  capabilities: currentCapabilities,
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
      },
      200,
      { "Cache-Control": "private, no-store" },
    ),
  );
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
      const deadline = AbortSignal.timeout(config.semanticSearchTimeoutMs);
      const upstream = await deps.search(input.query, input.topK, deadline);
      const response = readSearchResponse(upstream, input.topK, input.query);
      if (!response.groups.length)
        return c.json({ status: "no_result", jobId: null }, 200, {
          "Cache-Control": "private, no-store",
        });
      // Pin the actual original/mirror BVH bytes. Scores never become geometric confidence.
      const entries = response.groups.flatMap((group) =>
        group.variants.map((variant) => ({ group, variant })),
      );
      const candidates: PoseCandidate[] = new Array(entries.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
          for (let i = cursor++; i < entries.length; i = cursor++) {
            const { group, variant } = entries[i]!;
            const bvh = await deps.getPoseBvh(variant.poseId, deadline);
            if (!bvh.ok) throw new SemanticError("SEMANTIC_UNAVAILABLE", 503);
            const bytes = await previewBytes(bvh);
            candidates[i] = {
              id: `${variant.poseId}::front`,
              poseId: variant.poseId,
              rank: group.rank,
              view: "front",
              tags: group.labels,
              matchLevel: "medium",
              bvhAvailable: true,
              source: "semantic",
              lookupAllowed: true,
              refineAllowed: false,
              releaseAllowed: false,
              manualExportAllowed: true,
              presentationKind: group.near ? "near_match" : "library_match",
              actualMeshValidated: false,
              reviewRequired: true,
              rankScore: group.score,
              semantic: {
                familyId: group.variants[0]!.poseId,
                alternate: variant.alternate,
                description: group.description,
                near: group.near === true,
              },
              sourceBvhSha256: sha256Hex(bytes),
              ...(variant.thumbnail
                ? {
                    thumbnailUrl: `/v1/pose-candidates/${encodeURIComponent(variant.poseId)}/thumbnail?view=front`,
                  }
                : {}),
            };
          }
        }),
      );
      const job = await deps.createJob(owner, c.get("userId") ?? null);
      jobId = job.id;
      const result = semanticResult(
        job.id,
        input.query,
        response.index,
        candidates,
        await deps.capabilities(),
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
      return c.json({ status: "ok", jobId: job.id }, 200, {
        "Cache-Control": "private, no-store",
      });
    } catch (error) {
      if (jobId)
        await deps.updateJob(jobId, {
          status: "failed",
          errorCode: "SEMANTIC_FAILED",
        });
      if (error instanceof SemanticError) return fail(error.code, error.status);
      return fail("SEMANTIC_UNAVAILABLE", 503);
    }
  });
  return routes;
}
