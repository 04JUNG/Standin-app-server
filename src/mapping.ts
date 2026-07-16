// 계약 번역 = BFF가 소유하는 책임.
//  - 추론의 원시 distance → 클라 UI 라벨(matchLevel)
//  - 추론의 {detail} → 클라 오류봉투 {error:{code,...}}
import type { CutResult } from "./inference.js";
import type { AnalysisResult, ErrorEnvelope, MatchLevel, PoseCandidate } from "./types.js";

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
    notes: cut.notes ?? [],
    candidatesByPerson: (cut.people ?? []).map((p) => ({
      personIndex: p.index,
      box: p.box,
      tags: p.tags,
      candidates: p.candidates.map(
        (c, i): PoseCandidate => ({
          id: c.pose_id,
          rank: i + 1,
          view: c.view,
          tags: Object.values(c.tags ?? {}),
          matchLevel: matchLevelFromDistance(c.distance),
          bvhAvailable: true,
          distance: c.distance,
          rerankScore: c.rerank_score,
        }),
      ),
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
