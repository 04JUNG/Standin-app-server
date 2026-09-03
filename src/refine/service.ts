// 선택 후보 refine 오케스트레이션(BFF-05 ~ BFF-07).
//
// 핵심 원칙 하나: **refine은 사용자 작업을 실패시키지 않는다.** 안전 게이트가 조정을 버려도,
// 추론이 느려도, S3가 안 돼도 결과는 "베이스 BVH를 쓴다"는 정상 응답이다. 대신 조정본을
// 실제로 보관하지 못했다면 절대 refined=true로 기록하지 않는다.
import {
  InferenceError,
  refine as refineUpstream,
  type RefineUpstreamThumbnail,
} from "../inference.js";
import { config } from "../config.js";
import { log } from "../log.js";
import {
  getRefinedBvh,
  getRefinedThumbnail,
  putRefinedBvh,
  putRefinedThumbnail,
  refinedObjectKey,
  refinedStorageAvailable,
  refinedThumbnailObjectKey,
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
  /**
   * 확인 화면에 보여줄 미리보기 PNG를 보관했는가.
   *
   * `refined`와 독립이다 — 베이스를 쓰기로 한 결과에도 그림은 있을 수 있고(추론이 베이스를
   * 같은 렌더러로 그려 준다), 조정에 성공했는데 그림만 없을 수도 있다.
   */
  thumbnailAvailable: boolean;
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
  putRefinedBvh: typeof putRefinedBvh;
  putRefinedThumbnail: typeof putRefinedThumbnail;
}

const defaultDeps: RefineDeps = {
  featureEnabled: () => config.refineFeatureEnabled,
  storageAvailable: refinedStorageAvailable,
  loadCandidate,
  loadRefineContext,
  findRefinedArtifact,
  saveRefinedArtifact,
  refineUpstream,
  putRefinedBvh,
  putRefinedThumbnail,
};

function logRefine(event: Record<string, unknown>): void {
  log.info({ type: "refine", ...event });
}

/**
 * 256×256 PNG의 넉넉한 상한. 계약대로면 100 KB를 넘지 않는다.
 *
 * 상한이 필요한 이유는 추론을 의심해서가 아니라, base64 한 필드가 통째로 메모리와 S3로
 * 흘러가는 경로이기 때문이다. 계약이 어긋나는 날 조용히 커지는 것보다 그림을 버리는 게 낫다.
 */
const MAX_THUMBNAIL_BYTES = 1_000_000;

/** PNG 시그니처. 저장한 바이트를 나중에 `image/png`로 되돌려 주므로 여기서 확인한다. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 추론이 인라인으로 준 PNG를 바이트로 되돌린다. 조금이라도 어긋나면 null이다.
 *
 * 미리보기는 "저장될 포즈가 이것"이라고 주장하는 그림이라, 확신이 없으면 **아무것도 보여주지
 * 않는 편**이 맞다(CLAUDE.md §10). 그래서 관대하게 받지 않고 계약대로만 통과시킨다.
 */
export function decodeUpstreamThumbnail(
  thumbnail: RefineUpstreamThumbnail | null | undefined,
): Uint8Array | null {
  if (!thumbnail || typeof thumbnail.data !== "string" || thumbnail.data.length === 0) {
    return null;
  }
  if (thumbnail.encoding !== undefined && thumbnail.encoding !== "base64") return null;
  if (thumbnail.media_type !== undefined && thumbnail.media_type !== "image/png") return null;
  // base64는 4바이트가 3바이트가 된다. 디코드 전에 상한을 본다.
  if (thumbnail.data.length > Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + 4) return null;

  const bytes = new Uint8Array(Buffer.from(thumbnail.data, "base64"));
  // Buffer.from은 잘못된 base64를 던지지 않고 조용히 잘라낸다 — 길이로 걸러낸다.
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  if (bytes.length < PNG_MAGIC.length) return null;
  if (PNG_MAGIC.some((byte, i) => bytes[i] !== byte)) return null;
  return bytes;
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
      // 추론을 다시 부르지 않으므로 미리보기도 **보관해 둔 것**만 있다. 작업 기록에서
      // 다시 열었을 때 그림이 나오는 근거가 이 한 줄이다(ADR-012).
      thumbnailAvailable: Boolean(existing.thumbnailKey),
    };
  }

  logRefine({ event: "refine_requested", jobId, personIndex });

  const location = { installationId, jobId, personIndex, candidateId };

  /**
   * 미리보기를 보관한다. 실패는 삼킨다 — 그림이 없다고 저장을 막지 않는다(요구서 §3).
   *
   * 조정본 BVH의 `putRefinedBvh` 실패와는 성격이 다르다. 그쪽은 "조정했다고 기록해 놓고
   * 산출물이 없는" 상태를 만들지만, 여기는 화면이 후보 썸네일로 폴백하면 그만이다.
   */
  const persistThumbnail = async (
    thumbnail: RefineUpstreamThumbnail | null | undefined,
  ): Promise<string | null> => {
    const bytes = decodeUpstreamThumbnail(thumbnail);
    if (!bytes) return null;
    const key = refinedThumbnailObjectKey(location);
    try {
      await deps.putRefinedThumbnail(key, bytes);
      return key;
    } catch {
      logRefine({ event: "refine_thumbnail_failed", jobId, personIndex, stage: "persist" });
      return null;
    }
  };

  const skip = async (
    reasonCode: string,
    thumbnailKey: string | null = null,
  ): Promise<RefineOutcome> => {
    await deps.saveRefinedArtifact({
      jobId,
      personIndex,
      candidateId,
      poseId: candidate.poseId,
      refined: false,
      reason: reasonCode,
      objectKey: null,
      thumbnailKey,
      limbs: [],
    });
    logRefine({ event: "refine_skipped", jobId, personIndex, reasonCode });
    return {
      refined: false,
      reasonCode,
      adjustedLimbs: [],
      poseId: candidate.poseId,
      thumbnailAvailable: thumbnailKey !== null,
    };
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
      // v2.5 policy lineage. 하나라도 빠지면 추론이 fail-closed로 전건 skeleton_policy를
      // 돌려주는데, 그건 정상 스킵이라 오류로도 안 잡힌다 — refine이 조용히 꺼진다.
      skeleton_state: context.skeletonState,
      coverage_class: context.coverageClass,
      slot_origin: context.slotOrigin,
      skeleton_source: context.skeletonSource,
      lower_body_observed: context.lowerBodyObserved,
    });
  } catch (error) {
    // timeout·5xx·404·422 모두 사용자에게는 "베이스를 쓴다"로 수렴한다. 운영 오류는 로그로만.
    const status = error instanceof InferenceError ? error.status : 0;
    logRefine({ event: "refine_failed", jobId, personIndex, status });
    return skip("upstream_unavailable");
  }

  // 안전 게이트가 베이스를 유지한 것 — 오류가 아니다(요구서 §3-3).
  // 이 경우에도 미리보기는 있다. 추론이 **실제로 저장될 베이스 BVH**를 같은 렌더러로
  // 그려 주므로, 확인 화면은 조정 여부와 무관하게 같은 그림을 쓸 수 있다.
  if (!upstream.refined) return skip(upstream.reason, await persistThumbnail(upstream.thumbnail));

  // refined=true인데 본문이 없다면 계약 위반이다. 추론 서버가 조정본을 넘기는 경로는
  // 이 필드 하나뿐이고(REFINE_HANDOFF §3 4단계에서 /refined/{handle}/bvh는 제거됐다),
  // 없는 걸 지어낼 방법이 없으므로 베이스로 안전 전환한다.
  //
  // ⚠ `=== undefined`로는 부족하다. 추론은 `bvh: null`을 **명시적으로** 보내고
  //   (`bvh=res.bvh_text if res.refined else None`), null이 새어 나가면 아래
  //   `TextEncoder().encode()`가 문자열 `"null"`을 조정본으로 S3에 올린다.
  if (typeof upstream.bvh !== "string" || upstream.bvh.length === 0) {
    logRefine({ event: "refine_failed", jobId, personIndex, stage: "contract" });
    return skip("upstream_missing_bvh");
  }

  // 여기부터가 INF-03의 핵심: 조정본을 즉시 우리 소유로 옮긴다.
  // 계약상 LF 개행이다. UTF-8로 그대로 인코딩하면 추론이 만든 본문과 같은 바이트가 된다.
  const objectKey = refinedObjectKey(location);
  try {
    await deps.putRefinedBvh(objectKey, new TextEncoder().encode(upstream.bvh));
  } catch {
    // 조정은 됐지만 우리가 보관하지 못했다 → refined=true로 기록하지 않는다(BFF-06).
    logRefine({ event: "refine_failed", jobId, personIndex, stage: "persist" });
    // 베이스로 떨어지지만 그림은 조정본을 그린 것이라 맞지 않는다 — 붙이지 않는다.
    return skip("artifact_store_failed");
  }

  const thumbnailKey = await persistThumbnail(upstream.thumbnail);

  await deps.saveRefinedArtifact({
    jobId,
    personIndex,
    candidateId,
    poseId: candidate.poseId,
    refined: true,
    reason: upstream.reason,
    objectKey,
    thumbnailKey,
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
    thumbnailAvailable: thumbnailKey !== null,
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

/**
 * 확인 화면 미리보기 PNG. 없으면 null — 화면은 후보 썸네일로 폴백한다.
 *
 * 조정본 BVH와 달리 여기에는 폴백 사유를 남기지 않는다. 그림이 없는 것은 지표로 추적할
 * 품질 사건이 아니라 화면이 알아서 처리하는 정상 상태다.
 */
export async function resolveRefinedThumbnail(
  jobId: string,
  personIndex: number,
  candidateId: string,
): Promise<Uint8Array | null> {
  const artifact = await findRefinedArtifact(jobId, personIndex, candidateId);
  if (!artifact?.thumbnailKey) return null;
  return getRefinedThumbnail(artifact.thumbnailKey);
}
