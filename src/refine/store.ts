// refine 관련 저장소 접근. 공개 AnalysisResult와 내부 refine context를 분리해 둔다(BFF-04).
import { execute, queryOne } from "../db.js";

/** `/analyze` 때 서버측에 보관해 둔 refine 입력과 안전정책. */
export interface StoredRefineContext {
  keypoints: number[][];
  scores: number[] | null;
  refineAllowed: boolean;
  refinableLimbs: string[];
  // ── v2.5 policy lineage. 추론이 fail-closed로 재검증한다 ────────────────
  skeletonState: string | null;
  coverageClass: string | null;
  slotOrigin: string | null;
  skeletonSource: string | null;
  lowerBodyObserved: boolean;
}

interface PersonRow {
  refine_allowed: boolean | null;
  refinable_limbs_json: string | null;
  refine_context_json: string | null;
  skeleton_state: string | null;
  coverage_class: string | null;
  slot_origin: string | null;
  skeleton_source: string | null;
  lower_body_observed: boolean | null;
}

/**
 * refine 입력을 DB에서만 읽는다.
 *
 * 클라이언트가 COCO-17 좌표와 `refine_allowed`를 요청 바디로 되돌려 보내게 하면 저신뢰
 * 인물에도 refine을 걸 수 있다. 그래서 클라는 candidateId만 보내고 나머지는 여기서 온다.
 */
export async function loadRefineContext(
  jobId: string,
  personIndex: number,
): Promise<StoredRefineContext | null> {
  const row = await queryOne<PersonRow>(
    `SELECT refine_allowed, refinable_limbs_json, refine_context_json,
            skeleton_state, coverage_class, slot_origin, skeleton_source,
            lower_body_observed
     FROM analysis_people WHERE job_id = $1 AND person_index = $2`,
    [jobId, personIndex],
  );
  if (!row) return null;

  let keypoints: number[][] | null = null;
  let scores: number[] | null = null;
  if (row.refine_context_json) {
    try {
      const parsed = JSON.parse(row.refine_context_json) as {
        keypoints?: number[][] | null;
        scores?: number[] | null;
      };
      keypoints = parsed.keypoints ?? null;
      scores = parsed.scores ?? null;
    } catch {
      // 저장된 JSON이 깨졌으면 refine 입력이 없는 것과 같다 → 베이스로 간다.
      keypoints = null;
    }
  }
  // 추론 계약은 17×2를 요구한다. 어긋나면 호출하지 않고 베이스를 쓴다.
  if (!keypoints || keypoints.length !== 17) return null;

  let refinableLimbs: string[] = [];
  if (row.refinable_limbs_json) {
    try {
      const parsed: unknown = JSON.parse(row.refinable_limbs_json);
      if (Array.isArray(parsed)) refinableLimbs = parsed.filter((v) => typeof v === "string");
    } catch {
      refinableLimbs = [];
    }
  }

  return {
    keypoints,
    scores: scores && scores.length === 17 ? scores : null,
    refineAllowed: row.refine_allowed === true,
    refinableLimbs,
    // 마이그레이션 직전에 저장된 행은 이 컬럼들이 NULL이다. 그대로 보내면 추론이
    // skeleton_policy로 떨어뜨린다 — 값을 지어내는 것보다 그 편이 맞다.
    skeletonState: row.skeleton_state,
    coverageClass: row.coverage_class,
    slotOrigin: row.slot_origin,
    skeletonSource: row.skeleton_source,
    lowerBodyObserved: row.lower_body_observed === true,
  };
}

/** 선택 후보의 pose_id·view·distance. refine 요청에 그대로 실린다. */
export async function loadCandidate(
  jobId: string,
  personIndex: number,
  candidateId: string,
): Promise<{ poseId: string; view: string; distance: number | null } | null> {
  const row = await queryOne<{ pose_id: string; view: string; distance: number | null }>(
    `SELECT pose_id, view, distance FROM analysis_candidates
     WHERE job_id = $1 AND person_index = $2 AND candidate_id = $3`,
    [jobId, personIndex, candidateId],
  );
  return row ? { poseId: row.pose_id, view: row.view, distance: row.distance } : null;
}

export interface RefinedArtifact {
  jobId: string;
  personIndex: number;
  candidateId: string;
  poseId: string;
  refined: boolean;
  reason: string;
  objectKey: string | null;
  /** 미리보기 PNG의 S3 key. 없으면 null — 화면이 후보 썸네일로 폴백한다. */
  thumbnailKey: string | null;
  limbs: string[];
}

interface ArtifactRow {
  job_id: string;
  person_index: number;
  candidate_id: string;
  pose_id: string;
  refined: boolean;
  reason: string;
  object_key: string | null;
  thumbnail_key: string | null;
  limbs_json: string;
}

function toArtifact(row: ArtifactRow): RefinedArtifact {
  let limbs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.limbs_json);
    if (Array.isArray(parsed)) limbs = parsed.filter((v) => typeof v === "string");
  } catch {
    limbs = [];
  }
  return {
    jobId: row.job_id,
    personIndex: row.person_index,
    candidateId: row.candidate_id,
    poseId: row.pose_id,
    refined: row.refined,
    reason: row.reason,
    objectKey: row.object_key,
    // 컬럼 추가 전에 저장된 행은 undefined로 온다. 없는 것과 같게 다룬다.
    thumbnailKey: row.thumbnail_key ?? null,
    limbs,
  };
}

export async function findRefinedArtifact(
  jobId: string,
  personIndex: number,
  candidateId: string,
): Promise<RefinedArtifact | null> {
  const row = await queryOne<ArtifactRow>(
    `SELECT * FROM refined_artifacts
     WHERE job_id = $1 AND person_index = $2 AND candidate_id = $3`,
    [jobId, personIndex, candidateId],
  );
  return row ? toArtifact(row) : null;
}

/**
 * 결과를 기록한다. 같은 (job, person, candidate)를 다시 눌러도 한 행만 남는다(BFF-07).
 *
 * ⚠ `refined=true`는 **object_key까지 실제로 저장한 뒤에만** 넘어와야 한다. 거짓 성공을
 *   남기면 export가 조정본을 찾다가 매번 베이스로 떨어지면서 지표만 틀어진다(BFF-06).
 */
export async function saveRefinedArtifact(artifact: RefinedArtifact): Promise<void> {
  await execute(
    `INSERT INTO refined_artifacts
      (job_id, person_index, candidate_id, pose_id, refined, reason, object_key,
       thumbnail_key, limbs_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (job_id, person_index, candidate_id) DO UPDATE SET
       pose_id = EXCLUDED.pose_id, refined = EXCLUDED.refined, reason = EXCLUDED.reason,
       object_key = EXCLUDED.object_key, thumbnail_key = EXCLUDED.thumbnail_key,
       limbs_json = EXCLUDED.limbs_json`,
    [
      artifact.jobId,
      artifact.personIndex,
      artifact.candidateId,
      artifact.poseId,
      artifact.refined,
      artifact.reason,
      artifact.objectKey,
      artifact.thumbnailKey,
      JSON.stringify(artifact.limbs),
      new Date().toISOString(),
    ],
  );
}
