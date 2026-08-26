// Job 저장소(PostgreSQL). result는 JSON 문자열로 저장.
// 인터페이스(createJob/getJob/updateJob)는 유지하되 Promise를 돌려준다.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { execute, pool, queryOne, transaction } from "../db.js";
import {
  LimitExceededError,
  dailyWindow,
  isDisabled,
  isQuotaExempt,
  kstIsoString,
  secondsUntil,
  weeklyWindow,
} from "../limits/policy.js";
import { refund, tryConsume } from "../limits/store.js";
import { log } from "../log.js";
import type { RefineContext } from "../mapping.js";
import type { AnalysisResult } from "../types.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  userId: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result: AnalysisResult | null;
  errorCode: string | null;
  rerunOf: string | null;
  installationId: string | null;
  inputS3Key: string | null;
  inputMime: string | null;
}

interface JobRow {
  id: string;
  user_id: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  result_json: string | null;
  error_code: string | null;
  rerun_of: string | null;
  installation_id: string | null;
  input_s3_key: string | null;
  input_mime: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    result: r.result_json ? (JSON.parse(r.result_json) as AnalysisResult) : null,
    errorCode: r.error_code,
    rerunOf: r.rerun_of,
    installationId: r.installation_id,
    inputS3Key: r.input_s3_key,
    inputMime: r.input_mime,
  };
}

/** 진행 중 분석은 보통 수 초에 끝난다. 그 정도 뒤에 다시 눌러보라고 안내한다. */
const CONCURRENCY_RETRY_SECONDS = 10;

export interface JobInput {
  installationId: string;
  source: "capture" | "file" | "clipboard";
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

async function insertJob(
  executor: Pool | PoolClient,
  userId: string | null,
  rerunOf: string | null,
  input?: JobInput,
): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: `job_${randomUUID()}`,
    userId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    result: null,
    errorCode: null,
    rerunOf,
    installationId: input?.installationId ?? null,
    inputS3Key: null,
    inputMime: input?.mime ?? null,
  };
  await executor.query(
    `INSERT INTO jobs
      (id, user_id, status, created_at, updated_at, result_json, error_code, rerun_of,
       installation_id, source, input_mime, input_size, input_width, input_height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      job.id,
      userId,
      job.status,
      now,
      now,
      null,
      null,
      rerunOf,
      input?.installationId ?? null,
      input?.source ?? null,
      input?.mime ?? null,
      input?.size ?? null,
      input?.width ?? null,
      input?.height ?? null,
    ],
  );
  return job;
}

export async function createJob(
  userId: string | null,
  rerunOf: string | null = null,
  input?: JobInput,
): Promise<Job> {
  return insertJob(pool, userId, rerunOf, input);
}

/**
 * 사용량 한도를 확인하면서 Job을 만든다. 오픈베타 분석 경로는 반드시 이 함수를 쓴다.
 *
 * 한도 검사와 INSERT를 **한 트랜잭션**에 넣는 이유: 중간에 한도 초과로 throw하면
 * 롤백이 이미 올린 카운터까지 되돌린다. "먼저 세고 실패하면 빼기"는 그 사이에 프로세스가
 * 죽으면 쿼터가 영구히 새는 반면, 이 방식은 샐 구멍이 없다.
 *
 * 설치 단위 advisory lock을 먼저 잡아 같은 설치의 동시 요청을 직렬화한다
 * (동시 분석 제한이 붙을 자리이기도 하다).
 *
 * @throws LimitExceededError 한도 초과 시
 */
export async function createJobWithLimits(
  userId: string | null,
  input: JobInput,
): Promise<Job> {
  const nowMs = Date.now();
  const day = dailyWindow(nowMs);
  const week = weeklyWindow(nowMs);
  // 개발자 단말은 세지 않는다. 자기 한도에 막히면 정작 한도를 확인해야 할 때 확인하지 못한다.
  // 인증(requireInstallation)을 통과한 뒤에만 여기 오므로 ID를 흉내 내 우회할 수 없다.
  const exempt = isQuotaExempt(input.installationId, config.quotaExemptInstallations);
  if (exempt) {
    // 우회는 조용히 일어나면 안 된다 — 지표에서 "한도가 안 걸리네"의 원인을 찾을 수 있어야 한다.
    log.info({ type: "quota_exempt", installationId: input.installationId });
  }
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.installationId]);

    if (!exempt && !isDisabled(config.quotaInstallationConcurrent)) {
      // 오래된 Job은 세지 않는다 — 배포로 유실된 running Job이 설치를 영구히 막는다.
      const cutoff = new Date(nowMs - config.analysisStaleAfterSeconds * 1000).toISOString();
      const res = await client.query(
        `SELECT count(*)::int AS running FROM jobs
         WHERE installation_id = $1 AND status IN ('queued','running') AND created_at > $2`,
        [input.installationId, cutoff],
      );
      const running = (res.rows[0] as { running: number }).running;
      if (running >= config.quotaInstallationConcurrent) {
        throw new LimitExceededError("CONCURRENCY_LIMIT", CONCURRENCY_RETRY_SECONDS, {
          limit: config.quotaInstallationConcurrent,
        });
      }
    }

    if (!exempt && !isDisabled(config.quotaInstallationWeekly)) {
      const ok = await tryConsume(
        "installation_week",
        input.installationId,
        week,
        config.quotaInstallationWeekly,
        client,
      );
      if (!ok) {
        throw new LimitExceededError(
          "WEEKLY_QUOTA_EXCEEDED",
          secondsUntil(week.resetAtMs, nowMs),
          { limit: config.quotaInstallationWeekly, retryAt: kstIsoString(week.resetAtMs) },
        );
      }
    }

    if (!exempt && !isDisabled(config.quotaGlobalDaily)) {
      const ok = await tryConsume("global_day", "all", day, config.quotaGlobalDaily, client);
      if (!ok) {
        throw new LimitExceededError(
          "GLOBAL_QUOTA_EXCEEDED",
          secondsUntil(day.resetAtMs, nowMs),
          { retryAt: kstIsoString(day.resetAtMs) },
        );
      }
    }

    return insertJob(client, userId, null, input);
  });
}

/**
 * 커밋 뒤에 요청이 실패했을 때 소비한 쿼터를 돌려준다(예: 입력 저장 실패, 상류 혼잡).
 * best-effort — 실패해도 요청 처리를 막지 않는다.
 */
export async function refundAnalysisQuota(installationId: string): Promise<void> {
  // 애초에 세지 않은 설치에는 돌려줄 것도 없다.
  if (isQuotaExempt(installationId, config.quotaExemptInstallations)) return;
  const nowMs = Date.now();
  if (!isDisabled(config.quotaInstallationWeekly)) {
    await refund("installation_week", installationId, weeklyWindow(nowMs));
  }
  if (!isDisabled(config.quotaGlobalDaily)) {
    await refund("global_day", "all", dailyWindow(nowMs));
  }
}

/**
 * Job을 실패로 닫는다. `refundQuota`면 이 Job이 소비한 하루 쿼터도 돌려준다.
 *
 * 상태 전이가 **실제로 일어난 경우에만** 환불한다. 리스가 만료되면 같은 Job을 두 워커가
 * 잡을 수 있어서(claimJob), 조건 없이 환불하면 실패 한 번에 쿼터가 두 번 돌아간다.
 * 이미 끝난(completed) Job을 실패로 덮어쓰지 않는 것도 같은 조건이 막아 준다.
 *
 * @returns 이 호출이 Job을 실패로 닫았는가
 */
export async function failJob(
  id: string,
  errorCode: string,
  options: { refundQuota?: boolean } = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const row = await queryOne<{ installation_id: string | null }>(
    `UPDATE jobs SET status = 'failed', error_code = $2, updated_at = $3, completed_at = $3
     WHERE id = $1 AND status NOT IN ('failed', 'completed')
     RETURNING installation_id`,
    [id, errorCode, now],
  );
  if (!row) return false;
  if (options.refundQuota && row.installation_id) {
    // best-effort. 환불이 실패했다고 실패 기록까지 되돌리면 Job이 running에 남아
    // 그 설치는 동시 분석 한도에 막힌다 — 쿼터 1회보다 그쪽이 훨씬 아프다.
    await refundAnalysisQuota(row.installation_id).catch(() => {});
  }
  return true;
}

/**
 * 유실된 Job을 실패로 정리한다.
 *
 * 러너는 프로세스 내 fire-and-forget이라(runner.ts) 배포·태스크 교체 시 상태가
 * queued/running인 채로 영원히 남는다. 사용자에게는 무응답으로 보이고, 동시 분석
 * 한도가 1이면 그 설치는 다시 분석할 수 없다. 명시적 실패로 바꿔 둘 다 푼다.
 *
 * @returns 정리한 Job 수
 */
export async function failStaleJobs(): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - config.analysisStaleAfterSeconds * 1000).toISOString();
  return execute(
    `UPDATE jobs SET status = 'failed', error_code = 'ABANDONED',
       updated_at = $1, completed_at = $1
     WHERE status IN ('queued','running') AND created_at < $2`,
    [now.toISOString(), cutoff],
  );
}

export async function getOwnedJob(id: string, installationId: string): Promise<Job | undefined> {
  const row = await queryOne<JobRow>(
    "SELECT * FROM jobs WHERE id = $1 AND installation_id = $2",
    [id, installationId],
  );
  return row ? toJob(row) : undefined;
}

export async function setJobInput(
  id: string,
  input: { s3Key: string | null; sha256: string },
  enqueue = false,
): Promise<void> {
  await transaction(async (client) => {
    const now = new Date().toISOString();
    await client.query(
      `UPDATE jobs SET input_s3_key = $2, input_sha256 = $3,
         input_stored_at = $4, updated_at = $4 WHERE id = $1`,
      [id, input.s3Key, input.sha256, now],
    );
    if (enqueue) {
      await client.query(
        `INSERT INTO job_outbox (job_id, created_at)
         VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING`,
        [id, now],
      );
    }
  });
}

/** SQS는 at-least-once다. lease를 원자적으로 획득한 worker 하나만 실행한다. */
export async function claimJob(
  id: string,
  workerId: string,
  leaseSeconds: number,
): Promise<Job | undefined> {
  const now = new Date();
  const expires = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const rows = await queryOne<JobRow>(
    `UPDATE jobs
     SET status = 'running', started_at = COALESCE(started_at, $2), updated_at = $2,
         lease_owner = $3, lease_expires_at = $4, attempt_count = attempt_count + 1
     WHERE id = $1 AND input_s3_key IS NOT NULL
       AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < $2)))
     RETURNING *`,
    [id, now.toISOString(), workerId, expires],
  );
  return rows ? toJob(rows) : undefined;
}

export async function renewJobLease(
  id: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return (
    (await execute(
      `UPDATE jobs SET lease_expires_at = $3, updated_at = $4
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [id, workerId, expires, new Date().toISOString()],
    )) === 1
  );
}

export async function getJob(id: string): Promise<Job | undefined> {
  const row = await queryOne<JobRow>("SELECT * FROM jobs WHERE id = $1", [id]);
  return row ? toJob(row) : undefined;
}

/**
 * 지정한 필드만 갱신한다.
 *
 * 이전 구현은 "읽어서 병합 후 통째로 쓰기"였는데, 태스크가 여러 개면 두 갱신이
 * 서로를 덮어쓸 수 있다. 넘어온 필드만 COALESCE 없이 직접 지정해 그 창을 없앤다.
 */
export async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const sets: string[] = ["updated_at = $2"];
  const params: unknown[] = [id, new Date().toISOString()];

  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    if (patch.status === "running") {
      params.push(new Date().toISOString());
      sets.push(`started_at = $${params.length}`);
    }
    if (patch.status === "completed" || patch.status === "failed") {
      params.push(new Date().toISOString());
      sets.push(`completed_at = $${params.length}`);
    }
  }
  if (patch.result !== undefined) {
    params.push(patch.result ? JSON.stringify(patch.result) : null);
    sets.push(`result_json = $${params.length}`);
  }
  if (patch.errorCode !== undefined) {
    params.push(patch.errorCode);
    sets.push(`error_code = $${params.length}`);
  }

  await execute(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function persistAnalysisRecords(
  jobId: string,
  result: AnalysisResult,
  refineContexts: RefineContext[] = [],
): Promise<void> {
  const contextByPerson = new Map(refineContexts.map((ctx) => [ctx.personIndex, ctx]));
  await transaction(async (client) => {
    await client.query("DELETE FROM analysis_candidates WHERE job_id = $1", [jobId]);
    await client.query("DELETE FROM analysis_people WHERE job_id = $1", [jobId]);
    for (const person of result.candidatesByPerson) {
      const ctx = contextByPerson.get(person.personIndex);
      await client.query(
        `INSERT INTO analysis_people
          (job_id, person_index, bbox_json, tags_json, skeleton_json, confidence,
           candidate_count, candidate_shortfall_reason,
           skeleton_state, skeleton_source, coverage_class, fallback_mode,
           slot_origin, lower_body_observed,
           refine_allowed, refinable_limbs_json, refine_context_json, raw_scores_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          jobId,
          person.personIndex,
          person.box ? JSON.stringify(person.box) : null,
          JSON.stringify(person.tags),
          person.skeleton ? JSON.stringify(person.skeleton) : null,
          person.confidence,
          person.candidateCount,
          person.candidateShortfallReason,
          person.skeletonState,
          person.skeletonSource,
          person.coverageClass,
          person.fallbackMode,
          // v2.5 policy lineage. 공개 응답에는 없고 refine 호출에만 쓴다(BFF-03).
          ctx?.slotOrigin ?? null,
          ctx?.lowerBodyObserved === true,
          person.refineAllowed,
          JSON.stringify(person.refinableLimbs),
          // refine 입력은 서버측에만 둔다(BFF-04). 클라가 되돌려 보낸 값은 신뢰하지 않는다.
          ctx
            ? JSON.stringify({
                keypoints: ctx.keypoints,
                scores: ctx.scores,
                qualityReasons: ctx.qualityReasons,
                qualityTrace: ctx.qualityTrace,
              })
            : null,
          ctx?.rawScores ? JSON.stringify(ctx.rawScores) : null,
        ],
      );
      for (const candidate of person.candidates) {
        await client.query(
          `INSERT INTO analysis_candidates
            (job_id, person_index, candidate_id, pose_id, rank, view, distance,
             rerank_score, match_level, tags_json, pose_library_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            jobId,
            person.personIndex,
            candidate.id,
            candidate.poseId,
            candidate.rank,
            candidate.view,
            candidate.distance ?? null,
            candidate.rerankScore ?? null,
            candidate.matchLevel,
            JSON.stringify(candidate.tags),
            result.inferenceMetadata.poseLibraryVersion,
          ],
        );
      }
    }
    await client.query(
      `UPDATE jobs
       SET inference_metadata_json = $2, input_width = COALESCE(input_width, $3),
           input_height = COALESCE(input_height, $4)
       WHERE id = $1`,
      [
        jobId,
        JSON.stringify(result.inferenceMetadata),
        result.image.width,
        result.image.height,
      ],
    );
  });
}
