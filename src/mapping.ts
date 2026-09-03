// 계약 번역 = BFF가 소유하는 책임.
//  - 추론의 원시 distance → 클라 UI 라벨(matchLevel)
//  - 추론의 {detail} → 클라 오류봉투 {error:{code,...}}
import { config } from "./config.js";
import { converterEnabled } from "./converter/client.js";
import type { CutResult, UpstreamPerson } from "./inference.js";
import type {
  AnalysisPerson,
  AnalysisResult,
  CoverageClass,
  ErrorEnvelope,
  FallbackMode,
  MatchLevel,
  PersonConfidence,
  PoseCandidate,
  SkeletonSource,
  SkeletonState,
} from "./types.js";

// 원시 kNN 거리 → 표시용 세부 등급.
// ⚠ 임계값 시드: Standin-server/docs/SEARCH_EVAL(좋은 매칭 ~0.15, 앉기-서기 ~0.36).
//    실데이터로 반드시 보정할 것.
//
// ⚠ **이 함수를 단독으로 쓰면 안 된다.** 반드시 matchLevelForPerson을 통해 호출한다.
export function matchLevelFromDistance(distance: number): MatchLevel {
  if (distance <= 0.25) return "high";
  if (distance <= 0.45) return "medium";
  return "low";
}

/**
 * 인물 신뢰도를 1급 기준으로, 거리는 그 아래 세부 등급으로만 쓴다(BFF-02).
 *
 * 거리만 보면 안 되는 이유: 구조 검사에서 마스킹된 관절이 많을수록 남은 관절끼리의 평균
 * 거리가 **작아진다**. 즉 정보가 거의 없는 스켈레톤일수록 raw distance가 좋아 보이고,
 * `distance <= 0.25 → high` 규칙은 그걸 그대로 "높은 일치"로 승격시킨다.
 *
 * 서로 다른 coverage_class의 raw distance는 같은 절대 구간으로 비교하지 않는다.
 */
export function matchLevelForPerson(
  confidence: PersonConfidence,
  distance: number,
): MatchLevel {
  if (confidence !== "high") return "low";
  return matchLevelFromDistance(distance);
}

const CONFIDENCE_VALUES = new Set<PersonConfidence>(["high", "low"]);
const SKELETON_STATES = new Set<SkeletonState>([
  "valid",
  "partial",
  "suspect",
  "missing",
  "invalid",
]);
const SKELETON_SOURCES = new Set<SkeletonSource>(["full_image", "crop_retry", "none"]);
const COVERAGE_CLASSES = new Set<CoverageClass>([
  "full",
  "reduced",
  "sparse",
  "insufficient",
]);

/**
 * 구 추론 서버 응답이나 모르는 값을 안전한 쪽으로 좁힌다(BFF-01, E2E-12).
 *
 * 안전한 쪽 = 사용자에게 덜 약속하는 쪽이다. 신뢰도는 low, refine은 금지, coverage는
 * insufficient. 모르는 값을 낙관적으로 해석하면 순차 배포 창에서 저정보 결과가 그대로
 * "높은 일치 + refine 허용"으로 나간다.
 */
function narrow<T extends string>(allowed: Set<T>, value: unknown, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function personConfidence(p: UpstreamPerson): PersonConfidence {
  return narrow(CONFIDENCE_VALUES, p.confidence, "low");
}

/**
 * 인물 폴백 상태(요구서 §3-2).
 *
 * `confidence=low`와 `candidates=[]`는 같은 상태가 아니다. 전자는 참고용 후보를 보여주고,
 * 후자는 이 인물에 자동 후보가 없다고 알린다.
 */
function fallbackMode(confidence: PersonConfidence, candidateCount: number): FallbackMode {
  if (candidateCount === 0) return "hard";
  if (confidence !== "high") return "soft";
  return "none";
}

function mapPerson(p: UpstreamPerson): AnalysisPerson {
  const confidence = personConfidence(p);
  const candidateCount = p.candidates.length;
  return {
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
    confidence,
    skeletonState: narrow(SKELETON_STATES, p.skeleton_state, "invalid"),
    skeletonSource: narrow(SKELETON_SOURCES, p.skeleton_source, "none"),
    coverageClass: narrow(COVERAGE_CLASSES, p.coverage_class, "insufficient"),
    fallbackMode: fallbackMode(confidence, candidateCount),
    // 신규 필드가 없는 구 추론 응답은 refine을 금지한다. 허용은 명시적일 때만.
    refineAllowed: p.refine_allowed === true,
    refinableLimbs: p.refinable_limbs ?? [],
    candidateCount,
    candidateShortfallReason: null, // mapCutResult가 route를 알고 채운다
    candidates: [],
  };
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
    capabilities: { refine: config.refineFeatureEnabled, fbxExport: converterEnabled() },
    // 인물 순서는 추론이 최종 box.x1 기준 왼쪽→오른쪽으로 고정해 보낸다.
    // BFF는 다른 기준으로 다시 정렬하지 않는다(요구서 §3-1).
    candidatesByPerson: (cut.people ?? []).map((p) => {
      const person = mapPerson(p);
      person.candidateShortfallReason =
        person.candidateCount >= 5
          ? null
          : cut.route === "core"
            ? "UPSTREAM_FEWER_THAN_REQUESTED"
            : "ANALYSIS_ROUTE_SKIPPED";
      person.candidates = p.candidates.map((c, i): PoseCandidate => ({
        id: `${c.pose_id}::${c.view}`,
        poseId: c.pose_id,
        rank: i + 1,
        view: c.view,
        tags: Object.values(c.tags ?? {}),
        matchLevel: matchLevelForPerson(person.confidence, c.distance),
        bvhAvailable: true,
        thumbnailUrl: c.thumbnail_url
          ? `/v1/pose-candidates/${encodeURIComponent(c.pose_id)}/thumbnail?view=${encodeURIComponent(c.view)}`
          : undefined,
        distance: c.distance,
        rerankScore: c.rerank_score,
      }));
      return person;
    }),
  };
}

/**
 * 공개 응답에 넣지 않고 서버측에만 보관하는 refine 입력(BFF-04).
 *
 * 클라이언트가 COCO-17 좌표와 안전정책을 임의로 되돌려 보내게 하면 refine 금지를 우회할 수
 * 있다. `/analyze` 시점에 여기서 뽑아 DB에 넣고, refine 호출 때 DB에서만 읽는다.
 */
export interface RefineContext {
  personIndex: number;
  keypoints: number[][] | null;
  scores: number[] | null;
  rawScores: number[] | null;
  qualityReasons: string[];
  qualityTrace: Record<string, unknown>;
  /**
   * 인물 소유권 lineage. 추론은 `"vlm"`만 통과시킨다.
   *
   * 공개 `AnalysisPerson`에는 넣지 않는다 — 클라이언트가 쓸 일이 없고, 공개하면 클라가
   * 되돌려 보내는 구조가 생겨 refine 금지를 우회할 수 있다(BFF-03·BFF-04).
   */
  slotOrigin: string | null;
  /** 하체 관측 판정. 추론이 false면 모든 다리 조정을 막는다. */
  lowerBodyObserved: boolean;
}

export function extractRefineContexts(cut: CutResult): RefineContext[] {
  return (cut.people ?? []).map((p) => ({
    personIndex: p.index,
    keypoints: p.keypoints ?? p.skeleton?.keypoints ?? null,
    scores: p.scores ?? p.skeleton?.scores ?? null,
    rawScores: p.raw_scores ?? null,
    qualityReasons: p.quality_reasons ?? [],
    qualityTrace: p.quality_trace ?? {},
    // 값을 좁히지 않고 그대로 옮긴다. 어휘의 단일 소스는 추론의 schema.py이고, 모르는 값은
    // structural_refine_allowed가 fail-closed로 떨어뜨린다 — 여기서 한 번 더 해석하면
    // 두 곳이 어휘를 알게 되고 추론이 값을 늘릴 때 조용히 어긋난다.
    slotOrigin: typeof p.slot_origin === "string" ? p.slot_origin : null,
    // 신규 필드가 없는 구 추론 응답은 하체 미관측으로 본다. 허용은 명시적일 때만.
    lowerBodyObserved: p.lower_body_observed === true,
  }));
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return { error: { code, message, details, requestId } };
}
