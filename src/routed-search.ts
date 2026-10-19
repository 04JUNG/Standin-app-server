import type { PoseCandidate } from "./types.js";

export interface SearchPreviewCamera {
  yaw?: number;
  pitch?: number;
  distance?: number | null;
  view?: string;
}
export interface RoutedSearch {
  version: string;
  route: string;
  status: string;
  reason: string | null;
  nearCandidateCount: number;
  framingReferenceCount: number;
  generationStatus: string | null;
  generatedCandidateCount: number;
  basicModel: boolean;
}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const code = (v: unknown): string | null =>
  typeof v === "string" && /^[a-zA-Z0-9_:.-]{1,160}$/.test(v) ? v : null;
const count = (v: unknown) => (Array.isArray(v) ? Math.min(v.length, 5) : 0);

function previewCamera(value: unknown): SearchPreviewCamera | undefined {
  const v = object(value);
  if (!v) return undefined;
  const out: SearchPreviewCamera = {};
  for (const k of ["yaw", "pitch", "distance"] as const) {
    if (typeof v[k] === "number" && Number.isFinite(v[k])) out[k] = v[k];
  }
  if (v.distance === null) out.distance = null;
  if (code(v.view)) out.view = code(v.view)!;
  return Object.keys(out).length ? out : undefined;
}

/** These sources are lookup-only even if a client or stale context claims otherwise. */
export const restrictedCandidate = (
  candidate: Pick<PoseCandidate, "source" | "releaseAllowed" | "lookupAllowed" | "sourceBvhSha256"> | undefined,
) =>
  candidate?.source === "dynamic" ||
  candidate?.source === "semantic" ||
  (candidate?.source === "library" && (candidate.releaseAllowed !== true ||
    candidate.lookupAllowed !== true || !/^[a-f0-9]{64}$/.test(candidate.sourceBvhSha256 ?? ""))) ||
  candidate?.releaseAllowed === false;

/** A stored, hash-bound library asset may be manually reviewed without claiming search validation. */
export const manualExportCandidate = (candidate: PoseCandidate | undefined): boolean =>
  candidate?.manualExportAllowed === true &&
  ["library", "semantic"].includes(candidate.source ?? "") &&
  candidate.lookupAllowed === true && candidate.bvhAvailable === true &&
  candidate.reviewRequired === true && candidate.refineAllowed === false &&
  /^[a-f0-9]{64}$/.test(candidate.sourceBvhSha256 ?? "");

export const exportCandidateAllowed = (candidate: PoseCandidate | undefined): boolean =>
  !!candidate && (manualExportCandidate(candidate) || !restrictedCandidate(candidate));

/** Translate ranked retrieval into browseable candidates, never geometric confidence or export permission. */
export function mapRoutedSearch(
  jobId: string,
  person: {
    index: number;
    dynamic_search?: unknown;
    semantic_candidates?: unknown;
    search_routing?: unknown;
  },
): { candidates: PoseCandidate[]; summary: RoutedSearch } | null {
  const dynamic = object(person.dynamic_search);
  const routing = object(person.search_routing);
  const isDynamic = person.dynamic_search != null;
  if (!isDynamic && !routing && !count(person.semantic_candidates)) return null;
  // Old routing may accompany unchanged geometry. Only semantic/non-geometric output replaces it.
  if (!isDynamic && routing?.route === "geometric") return null;
  const source = isDynamic ? "dynamic" : "semantic";
  const rows = isDynamic ? dynamic?.selected : person.semantic_candidates;
  const search = object(routing?.search);
  const generation = object(dynamic?.generation);
  const summary: RoutedSearch = {
    version: isDynamic ? "fullbody-dynamic-v1" : "semantic-routing-v1",
    route: code(dynamic?.route ?? routing?.route) ?? "error",
    status: code(dynamic?.status ?? search?.status) ?? "error",
    reason: code(dynamic?.reason ?? routing?.reason) ?? null,
    nearCandidateCount: count(dynamic?.near_candidates),
    framingReferenceCount: count(dynamic?.framing_references),
    generationStatus: code(generation?.status),
    generatedCandidateCount: count(generation?.candidates),
    basicModel: object(dynamic?.basic_model) !== null,
  };
  const candidates: PoseCandidate[] = [];
  const seen = new Set<string>();
  let invalid = isDynamic && dynamic?.version !== "fullbody-dynamic-v1";
  if (
    !invalid &&
    ["ok", "partial_error"].includes(summary.status) &&
    Array.isArray(rows)
  ) {
    for (const raw of rows.slice(0, 5)) {
      const row = object(raw);
      const pid = row?.pose_id;
      const rankScore = isDynamic ? row?.rank_score : row?.score;
      if (
        !row ||
        typeof pid !== "string" ||
        !pid ||
        pid.length > 255 ||
        /[\/\\\x00-\x1f]/.test(pid) ||
        typeof rankScore !== "number" ||
        !Number.isFinite(rankScore) ||
        (isDynamic &&
          (row.kind !== "library_original" ||
            row.lookup_allowed !== true ||
            row.refine_allowed !== false ||
            row.release_allowed !== false ||
            row.actual_mesh_validated !== false))
      ) {
        invalid = true;
        continue;
      }
      if (seen.has(pid)) continue;
      seen.add(pid);
      const id = `${source}::${pid}`;
      const params = new URLSearchParams({
        jobId,
        personIndex: String(person.index),
        candidateId: id,
      });
      candidates.push({
        id,
        poseId: pid,
        rank: candidates.length + 1,
        view: "front",
        tags: [
          source === "dynamic" ? "전신 검색" : "의미 검색",
          "정면 참고 이미지",
        ],
        matchLevel: "low",
        bvhAvailable: false,
        thumbnailUrl: `/v1/pose-candidates/${encodeURIComponent(pid)}/lookup-thumbnail?${params}`,
        source,
        rankScore,
        lookupAllowed: true,
        refineAllowed: false,
        releaseAllowed: false,
        actualMeshValidated: false,
        reviewRequired: true,
        notExactMatch: row.not_exact_match === true,
        searchCamera: previewCamera(
          row.camera ??
            row.semantic_preview_camera ??
            object(row.pose)?.preview_camera,
        ),
      });
    }
  }
  // Contract errors are visible; do not silently publish a partially trusted batch.
  if (invalid) {
    candidates.length = 0;
    summary.status = "error";
    summary.reason = "invalid_routed_candidate_contract";
  }
  return { candidates, summary };
}
