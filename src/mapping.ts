// 계약 번역 = BFF가 소유하는 책임.
//  - 추론의 원시 distance → 클라 UI 라벨(matchLevel)
//  - 추론의 {detail} → 클라 오류봉투 {error:{code,...}}
import type { CutResult } from "./inference.js";
import type {
  AnalysisResult,
  ErrorEnvelope,
  MatchLevel,
  PoseCandidate,
} from "./types.js";

// 원시 kNN 거리 → UI 라벨.
// ⚠ 임계값 시드: Standin-server/docs/SEARCH_EVAL(좋은 매칭 ~0.15, 앉기-서기 ~0.36).
//    실데이터로 반드시 보정할 것.
export function matchLevelFromDistance(distance: number): MatchLevel {
  if (distance <= 0.25) return "high";
  if (distance <= 0.45) return "medium";
  return "low";
}

export function mapCutResult(jobId: string, cut: CutResult): AnalysisResult {
  return {
    jobId,
    image: cut.image,
    inferenceMetadata: {
      deploymentVersion: cut.inference_metadata.deployment_version,
      vlmProvider: cut.inference_metadata.vlm_provider,
      vlmModel: cut.inference_metadata.vlm_model,
      poseBackend: cut.inference_metadata.pose_backend,
      poseModelVersion: cut.inference_metadata.pose_model_version,
      poseLibraryVersion: cut.inference_metadata.pose_library_version,
      featureVersion: cut.inference_metadata.feature_version,
    },
    notes: cut.notes ?? [],
    candidatesByPerson: (cut.people ?? []).map((p) => ({
      personIndex: p.index,
      box: p.box,
      tags: p.tags,
      skeleton: p.skeleton
        ? {
            schemaVersion: p.skeleton.schema_version,
            keypoints: p.skeleton.keypoints,
            scores: p.skeleton.scores,
          }
        : null,
      confidence: p.confidence,
      candidateCount: p.candidates.length,
      candidateShortfallReason:
        p.candidates.length >= 5
          ? null
          : cut.route === "core"
            ? "UPSTREAM_FEWER_THAN_REQUESTED"
            : "ANALYSIS_ROUTE_SKIPPED",
      candidates: p.candidates.map((c, i): PoseCandidate => ({
        id: `${c.pose_id}::${c.view}`,
        poseId: c.pose_id,
        rank: i + 1,
        view: c.view,
        tags: Object.values(c.tags ?? {}),
        matchLevel: matchLevelFromDistance(c.distance),
        bvhAvailable: true,
        thumbnailUrl: c.thumbnail_url
          ? `/v1/pose-candidates/${encodeURIComponent(c.pose_id)}/thumbnail?view=${encodeURIComponent(c.view)}`
          : undefined,
        distance: c.distance,
        rerankScore: c.rerank_score,
      })),
    })),
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return { error: { code, message, details, requestId } };
}
