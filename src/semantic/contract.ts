import type { AnalysisResult, PoseCandidate } from "../types.js";

export const SEMANTIC_MAX_TOP_K = 20;

export class SemanticError extends Error {
  constructor(
    public code:
      | "SEMANTIC_UNAVAILABLE"
      | "SEMANTIC_FAILED"
      | "INVALID_INPUT"
      | "SEMANTIC_CONTRACT",
    public status: 400 | 502 | 503,
  ) {
    super(code);
  }
}
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  return value as ObjectValue;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  return value;
}
function poseId(value: unknown): string {
  const id = text(value);
  if (/[\x00-\x1f/\\]/.test(id) || id === "." || id === "..")
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  return id;
}
function score(value: unknown): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
}
export function readSearchInput(value: unknown): {
  query: string;
  topK: number;
} {
  const body = object(value);
  if (
    Object.keys(body).some((k) => k !== "query" && k !== "topK") ||
    typeof body.query !== "string"
  )
    throw new SemanticError("INVALID_INPUT", 400);
  const query = body.query.trim();
  const topK = body.topK ?? 5;
  if (
    !query ||
    query.length > 500 ||
    !Number.isInteger(topK) ||
    Number(topK) < 1 ||
    Number(topK) > SEMANTIC_MAX_TOP_K
  )
    throw new SemanticError("INVALID_INPUT", 400);
  return { query, topK: Number(topK) };
}
export interface SearchGroup {
  rank: number;
  near?: boolean;
  score?: number;
  description: string;
  labels: string[];
  variants: { poseId: string; thumbnail: boolean; alternate: boolean }[];
}
export function readSearchResponse(
  value: unknown,
  topK: number,
  expectedQuery?: string,
): {
  status: "ok" | "no_result";
  groups: SearchGroup[];
  index: Record<string, string>;
} {
  const body = object(value);
  if (body.status === "error") {
    const error = object(body.error).code;
    if (
      ["semantic_unavailable", "semantic_search_failed"].includes(String(error))
    )
      throw new SemanticError("SEMANTIC_UNAVAILABLE", 503);
    throw new SemanticError("SEMANTIC_FAILED", 502);
  }
  if (
    !["ok", "no_result"].includes(String(body.status)) ||
    body.error != null ||
    body.score_is_accuracy !== false ||
    body.generation_requested !== false ||
    !Array.isArray(body.candidates) ||
    !Array.isArray(body.near_candidates) ||
    body.candidates.length > topK ||
    body.near_candidates.length > topK ||
    (body.status === "no_result") !== (body.candidates.length === 0)
  )
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  const query = object(body.query);
  if (
    query.source !== "user" ||
    (expectedQuery !== undefined && query.text !== expectedQuery)
  )
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  const seen = new Set<string>();
  const groups = [body.candidates, body.near_candidates].flatMap(
    (items, group) =>
      (items as unknown[]).map((item, i): SearchGroup => {
        const c = object(item),
          pose = object(c.pose),
          id = poseId(c.pose_id);
        if (
          seen.has(id) ||
          c.rank !== i + 1 ||
          pose.pose_id !== id ||
          pose.schema !== "standin-pose-record-v1" ||
          c.refine_allowed !== false ||
          c.release_allowed !== false ||
          c.actual_mesh_validated !== false
        )
          throw new SemanticError("SEMANTIC_CONTRACT", 502);
        seen.add(id);
        score(c.score);
        const labels: string[] = [];
        for (const entries of Object.values(object(pose.tags))) {
          if (!Array.isArray(entries))
            throw new SemanticError("SEMANTIC_CONTRACT", 502);
          for (const entry of entries) {
            const tag = object(entry);
            if (typeof tag.label === "string" && tag.label.length <= 100)
              labels.push(tag.label);
          }
        }
        return {
          rank: i + 1,
          near: group === 1,
          score: c.score as number,
          description:
            typeof pose.description === "string"
              ? pose.description.slice(0, 1000)
              : "",
          labels: [...new Set(labels)].slice(0, 8),
          variants: [{ poseId: id, thumbnail: true, alternate: false }],
        };
      }),
  );
  const index: Record<string, string> = {};
  if (body.pose_library != null)
    for (const [key, value] of Object.entries(object(body.pose_library)))
      if (
        ["version", "content_sha256", "db_sha256"].includes(key) &&
        typeof value === "string"
      )
        index[key] = value.slice(0, 200);
  return { status: body.status as "ok" | "no_result", groups, index };
}
export function semanticCapabilities(
  capabilities: AnalysisResult["capabilities"],
): AnalysisResult["capabilities"] {
  // Text body selection is preview-only; image-derived recommendation/refine stays disabled.
  return {
    ...capabilities,
    refine: false,
    semanticBodySelection: capabilities.bodySelection === true && capabilities.bodyPreviews === true,
    bodySelection: false,
    bodyRecommendation: false,
    bodyPreviews: false,
    bodyPreviewAssets: false,
  };
}
export function semanticResult(
  jobId: string,
  query: string,
  index: Record<string, string>,
  candidates: PoseCandidate[],
  capabilities: AnalysisResult["capabilities"],
): AnalysisResult {
  return {
    jobId,
    source: "semantic",
    semantic: { query, index },
    image: null,
    inferenceMetadata: {
      deploymentVersion: index.code_version ?? "unknown",
      vlmProvider: "none",
      vlmModel: "none",
      poseBackend: "none",
      poseModelVersion: "none",
      poseLibraryVersion: index.version ?? "unknown",
      featureVersion: 0,
    },
    notes: [],
    capabilities: semanticCapabilities(capabilities),
    candidatesByPerson: [
      {
        personIndex: 0,
        box: null,
        tags: {},
        skeleton: null,
        confidence: "low",
        skeletonState: "missing",
        skeletonSource: "none",
        coverageClass: "insufficient",
        fallbackMode: "none",
        refineAllowed: false,
        refinableLimbs: [],
        candidateCount: candidates.length,
        candidateShortfallReason: null,
        candidates,
      },
    ],
  };
}
