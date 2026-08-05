// 선택 후보 refine 오케스트레이션(BFF-05 ~ BFF-07).
//
// 핵심 원칙 하나: **refine은 사용자 작업을 실패시키지 않는다.** 안전 게이트가 조정을 버려도,
// 추론이 느려도, S3가 안 돼도 결과는 "베이스 BVH를 쓴다"는 정상 응답이다. 대신 조정본을
// 실제로 보관하지 못했다면 절대 refined=true로 기록하지 않는다.
import { InferenceError, fetchUpstreamPath, refine as refineUpstream } from "../inference.js";
import { config } from "../config.js";
import {
  getRefinedBvh,
  putRefinedBvh,
  refinedObjectKey,
  refinedStorageAvailable,
} from "../refineStorage.js";
import {
  findRefinedArtifact,
  loadCandidate,
  loadRefineContext,
  saveRefinedArtifact,
} from "./store.js";

export interface RefineOutcome {
  refined: boolean;
  /** 코드형 값만. 추론의 raw reason이거나 BFF가 붙인 스킵 사유다. */
  reasonCode: string;
  adjustedLimbs: string[];
  /** export 경로를 만들 때 쓴다. candidateId 문자열을 파싱하지 않기 위해 함께 돌려준다. */
  poseId: string;
}

export type RefineFailure = { error: "JOB_CANDIDATE_MISMATCH" };

/** 후보를 찾지 못했다는 뜻. 소유권 검증은 라우트가 먼저 끝낸다. */
export function isRefineFailure(v: RefineOutcome | RefineFailure): v is RefineFailure {
  return "error" in v;
}

/**
 * 협력자를 주입 가능하게 둔다.
 *
 * 이 함수의 값어치는 "언제 refine을 호출하지 않는가"라는 결정표에 있다. 그 표는 Postgres나
 * S3 없이 검증할 수 있어야 실제로 검증된다. 기본값은 진짜 구현이므로 호출부는 신경 쓰지 않는다.
 */
export interface RefineDeps {
  featureEnabled(): boolean;
  storageAvailable(): boolean;
  loadCandidate: typeof loadCandidate;
  loadRefineContext: typeof loadRefineContext;
  findRefinedArtifact: typeof findRefinedArtifact;
  saveRefinedArtifact: typeof saveRefinedArtifact;
  refineUpstream: typeof refineUpstream;
  fetchUpstreamPath: typeof fetchUpstreamPath;
  putRefinedBvh: typeof putRefinedBvh;
}

const defaultDeps: RefineDeps = {
  featureEnabled: () => config.refineFeatureEnabled,
  storageAvailable: refinedStorageAvailable,
  loadCandidate,
  loadRefineContext,
  findRefinedArtifact,
  saveRefinedArtifact,
  refineUpstream,
  fetchUpstreamPath,
  putRefinedBvh,
};

function logRefine(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "refine", ...event }));
}

export async function runRefine(
  input: {
    installationId: string;
    jobId: string;
    personIndex: number;
    candidateId: string;
  },
  deps: RefineDeps = defaultDeps,
): Promise<RefineOutcome | RefineFailure> {
  const { installationId, jobId, personIndex, candidateId } = input;

  const candidate = await deps.loadCandidate(jobId, personIndex, candidateId);
  if (!candidate) return { error: "JOB_CANDIDATE_MISMATCH" };

  // 같은 선택을 다시 눌러도 추론을 다시 호출하지 않고 S3 객체도 늘어나지 않는다(BFF-07).
  const existing = await deps.findRefinedArtifact(jobId, personIndex, candidateId);
  if (existing) {
    return {
      refined: existing.refined,
      reasonCode: existing.reason,
      adjustedLimbs: existing.limbs,
      poseId: existing.poseId,
    };
  }

  logRefine({ event: "refine_requested", jobId, personIndex });

  const skip = async (reasonCode: string): Promise<RefineOutcome> => {
    await deps.saveRefinedArtifact({
      jobId,
      personIndex,
      candidateId,
      poseId: candidate.poseId,
      refined: false,
      reason: reasonCode,
      objectKey: null,
      limbs: [],
    });
    logRefine({ event: "refine_skipped", jobId, personIndex, reasonCode });
    return { refined: false, reasonCode, adjustedLimbs: [], poseId: candidate.poseId };
  };

  // BFF flag가 꺼져 있으면 추론 endpoint가 살아 있어도 호출하지 않는다(OPS-02).
  if (!deps.featureEnabled()) return skip("feature_disabled");

  // 조정본을 보관할 곳이 없으면 조정해 봐야 다음 요청에서 사라진다(INF-03).
  if (!deps.storageAvailable()) return skip("storage_unavailable");

  const context = await deps.loadRefineContext(jobId, personIndex);
  if (!context) return skip("context_unavailable");
  // 추론도 같은 판단을 다시 하지만(INF-02), 저신뢰 인물에 굳이 호출을 태우지 않는다.
  if (!context.refineAllowed) return skip("skeleton_policy");

  let upstream;
  try {
    upstream = await deps.refineUpstream({
      pose_id: candidate.poseId,
      view: candidate.view,
      keypoints: context.keypoints,
      scores: context.scores,
      search_distance: candidate.distance,
      refine_allowed: context.refineAllowed,
      refinable_limbs: context.refinableLimbs,
    });
  } catch (error) {
    // timeout·5xx·404·422 모두 사용자에게는 "베이스를 쓴다"로 수렴한다. 운영 오류는 로그로만.
    const status = error instanceof InferenceError ? error.status : 0;
    logRefine({ event: "refine_failed", jobId, personIndex, status });
    return skip("upstream_unavailable");
  }

  // 안전 게이트가 베이스를 유지한 것 — 오류가 아니다(요구서 §3-3).
  if (!upstream.refined) return skip(upstream.reason);

  // 여기부터가 INF-03의 핵심: 추론 로컬 디스크의 조정본을 즉시 우리 소유로 옮긴다.
  const objectKey = refinedObjectKey({ installationId, jobId, personIndex, candidateId });
  try {
    const res = await deps.fetchUpstreamPath(upstream.bvh_url);
    if (!res.ok) throw new Error(`upstream refined bvh ${res.status}`);
    await deps.putRefinedBvh(objectKey, new Uint8Array(await res.arrayBuffer()));
  } catch {
    // 조정은 됐지만 우리가 보관하지 못했다 → refined=true로 기록하지 않는다(BFF-06).
    logRefine({ event: "refine_failed", jobId, personIndex, stage: "persist" });
    return skip("artifact_store_failed");
  }

  await deps.saveRefinedArtifact({
    jobId,
    personIndex,
    candidateId,
    poseId: candidate.poseId,
    refined: true,
    reason: upstream.reason,
    objectKey,
    limbs: upstream.limbs,
  });
  logRefine({
    event: "refine_applied",
    jobId,
    personIndex,
    reasonCode: upstream.reason,
    limbCount: upstream.limbs.length,
  });
  return {
    refined: true,
    reasonCode: upstream.reason,
    adjustedLimbs: upstream.limbs,
    poseId: candidate.poseId,
  };
}

/**
 * export가 실제로 내보낼 대상. 조정본이 유효하면 그 바이트를, 아니면 null(=베이스).
 *
 * 조정본을 저장했다고 기록해 놓고 객체가 사라진 경우에도 사용자 저장은 성공해야 한다.
 * 그래서 실패를 던지지 않고 사유와 함께 베이스로 안전 전환한다(BFF-06, E2E-09).
 */
export async function resolveExportArtifact(
  jobId: string,
  personIndex: number,
  candidateId: string,
): Promise<
  | { variant: "refined"; bytes: Uint8Array }
  | { variant: "base"; fallbackReason: string | null }
> {
  const artifact = await findRefinedArtifact(jobId, personIndex, candidateId);
  if (!artifact?.refined || !artifact.objectKey) {
    return { variant: "base", fallbackReason: null };
  }
  const bytes = await getRefinedBvh(artifact.objectKey);
  if (!bytes) return { variant: "base", fallbackReason: "refined_object_missing" };
  return { variant: "refined", bytes };
}
