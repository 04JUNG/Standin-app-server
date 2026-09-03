// BFF 전용 PostgreSQL(유저·refresh·Job).
// ⚠ 추론 라이브러리 poses.db와 다른 저장소(PII 분리).
//
// SQLite에서 옮겨온 이유: 컨테이너(ECS Fargate)의 디스크는 태스크가 교체되면 사라진다.
// 파일 DB를 두면 배포할 때마다 가입한 사용자가 통째로 없어진다.
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  // undefined면 pg가 표준 PG* 환경변수를 읽는다(config.usePgEnvVars 주석 참고).
  connectionString: config.usePgEnvVars ? undefined : config.databaseUrl,
  // RDS는 TLS를 요구하지만 사설 CA라 체인 검증은 끈다. 로컬(compose)은 TLS 자체가 없다.
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: config.databasePoolMax,
});

/** 파라미터화 쿼리. 값은 항상 $1, $2로 넘기고 문자열 연결을 하지 않는다. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** 단일 행 조회. 없으면 undefined. */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** 결과를 쓰지 않는 실행. 영향받은 행 수를 돌려준다. */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(text, params);
  return res.rowCount ?? 0;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS installations (
    id                    TEXT PRIMARY KEY,
    token_hash            TEXT NOT NULL,
    consent_version       TEXT NOT NULL,
    consented_at          TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL,
    app_version           TEXT NOT NULL,
    os_name               TEXT NOT NULL,
    os_version            TEXT NOT NULL,
    architecture          TEXT NOT NULL,
    locale                TEXT NOT NULL,
    revoked_at            TEXT,
    deletion_requested_at TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    password_hash  TEXT,                                 -- 소셜 계정은 NULL
    display_name   TEXT NOT NULL,
    created_at     TEXT NOT NULL,                        -- ISO 8601 문자열(기존 동작 유지)
    provider       TEXT NOT NULL DEFAULT 'local',        -- local | google | kakao | naver
    provider_id    TEXT,                                 -- provider의 유저 id(소셜만)
    email_verified BOOLEAN NOT NULL DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti        TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at BIGINT NOT NULL                           -- unix seconds
  );

  -- 소셜 로그인 성공 후 클라에 넘기는 1회용 교환 코드. 원문이 아니라 SHA-256 해시를 담는다.
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at BIGINT NOT NULL                           -- unix seconds
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    result_json TEXT,
    error_code  TEXT,
    rerun_of    TEXT
  );

  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS installation_id TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_s3_key TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_sha256 TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_mime TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_size BIGINT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_width INTEGER;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_height INTEGER;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS input_stored_at TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inference_metadata_json TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

  -- DB commit과 SQS 전송 사이의 유실을 막는 transactional outbox.
  CREATE TABLE IF NOT EXISTS job_outbox (
    job_id           TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    created_at       TEXT NOT NULL,
    published_at     TEXT,
    publish_attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_job_outbox_pending
    ON job_outbox(created_at) WHERE published_at IS NULL;

  CREATE TABLE IF NOT EXISTS analysis_people (
    job_id          TEXT NOT NULL,
    person_index    INTEGER NOT NULL,
    bbox_json       TEXT,
    tags_json       TEXT NOT NULL,
    skeleton_json   TEXT,
    confidence      TEXT,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    candidate_shortfall_reason TEXT,
    PRIMARY KEY (job_id, person_index)
  );

  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS candidate_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS candidate_shortfall_reason TEXT;

  -- PR #10 스켈레톤 품질 신호. refine_context_json/raw_scores_json은 공개 응답에 나가지
  -- 않는다(BFF-03) — refine 입력과 평가용 원본 점수를 서버측에만 두기 위한 컬럼이다.
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS skeleton_state TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS skeleton_source TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS coverage_class TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS fallback_mode TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS refine_allowed BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS refinable_limbs_json TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS refine_context_json TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS raw_scores_json TEXT;

  -- refine v2.5 policy lineage. 추론의 structural_refine_allowed가 slot_origin='vlm'과
  -- skeleton_source='full_image'를 함께 요구하므로, 보내지 않으면 모든 refine이 조용히
  -- skeleton_policy로 떨어진다. 공개 응답에는 나가지 않는 서버측 전용 값이다(BFF-03).
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS slot_origin TEXT;
  ALTER TABLE analysis_people ADD COLUMN IF NOT EXISTS lower_body_observed BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS analysis_candidates (
    job_id               TEXT NOT NULL,
    person_index         INTEGER NOT NULL,
    candidate_id         TEXT NOT NULL,
    pose_id              TEXT NOT NULL,
    rank                  INTEGER NOT NULL,
    view                  TEXT NOT NULL,
    distance              DOUBLE PRECISION,
    rerank_score          DOUBLE PRECISION,
    match_level           TEXT NOT NULL,
    tags_json             TEXT NOT NULL,
    pose_library_version  TEXT NOT NULL,
    PRIMARY KEY (job_id, person_index, candidate_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    event_id        TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    sequence_number BIGINT NOT NULL,
    event_name      TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    received_at     TEXT NOT NULL,
    job_id          TEXT,
    properties_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS confirmed_selections (
    job_id          TEXT NOT NULL,
    person_index    INTEGER NOT NULL,
    installation_id TEXT NOT NULL,
    candidate_id    TEXT NOT NULL,
    rank            INTEGER NOT NULL,
    confirmed_at    TEXT NOT NULL,
    PRIMARY KEY (job_id, person_index)
  );

  CREATE TABLE IF NOT EXISTS job_feedback (
    job_id          TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    reason          TEXT NOT NULL,
    submitted_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS export_events (
    event_id        TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    job_id          TEXT,
    person_index    INTEGER,
    candidate_id    TEXT NOT NULL,
    status          TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    error_code      TEXT
  );

  -- 실제로 내려간 것이 조정본인지 베이스인지 구분한다(BFF-06). 이게 없으면 조정본
  -- 조회 실패로 베이스가 나간 경우와 처음부터 베이스인 경우를 지표에서 구분할 수 없다.
  ALTER TABLE export_events ADD COLUMN IF NOT EXISTS variant TEXT;
  ALTER TABLE export_events ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
  -- 사용자가 고른 저장 포맷(bvh|fbx). 이게 없으면 FBX 변환 실패율을 BVH 저장과 섞어
  -- 집계하게 되고, converter를 켠 효과를 지표로 확인할 수 없다.
  ALTER TABLE export_events ADD COLUMN IF NOT EXISTS format TEXT;

  /* 조정본 artifact 대장(BFF-06).
     object_key는 추론 컨테이너의 로컬 handle이 아니라 **S3 object key**다 — 태스크가
     교체돼도 export가 계속 성공해야 하기 때문이다(INF-03, E2E-08).
     PK가 (job_id, person_index, candidate_id)인 것이 멱등성의 근거다: 같은 선택을 다시
     눌러도 추론을 다시 호출하지 않고 S3 객체도 중복 생성되지 않는다(BFF-07). */
  CREATE TABLE IF NOT EXISTS refined_artifacts (
    job_id       TEXT NOT NULL,
    person_index INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    pose_id      TEXT NOT NULL,
    refined      BOOLEAN NOT NULL,
    reason       TEXT NOT NULL,
    object_key   TEXT,
    limbs_json   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    PRIMARY KEY (job_id, person_index, candidate_id)
  );

  /* 확인 화면 미리보기 PNG의 S3 key. object_key와 마찬가지로 NULL이면 "없다"이지
     오류가 아니다 — 그림이 없으면 화면이 후보 썸네일로 폴백한다. */
  ALTER TABLE refined_artifacts ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;

  CREATE TABLE IF NOT EXISTS daily_analytics_aggregates (
    day                   TEXT PRIMARY KEY,
    jobs_started          INTEGER NOT NULL,
    jobs_completed        INTEGER NOT NULL,
    jobs_failed           INTEGER NOT NULL,
    confirmed_selections  INTEGER NOT NULL,
    top1_selections       INTEGER NOT NULL,
    mean_reciprocal_rank  DOUBLE PRECISION,
    exports_completed     INTEGER NOT NULL,
    feedback_json         TEXT NOT NULL,
    latency_p50_seconds   DOUBLE PRECISION,
    latency_p95_seconds   DOUBLE PRECISION,
    refreshed_at          TEXT NOT NULL
  );

  -- 사용량 카운터(설치별 일일 쿼터·전체 상한·IP burst). 정본은 여기다 —
  -- 프로세스 메모리에 세면 태스크 수만큼 한도가 늘어나고 배포마다 초기화된다.
  CREATE TABLE IF NOT EXISTS usage_counters (
    scope        TEXT NOT NULL,      -- installation_week | global_day | ip_register | ip_analyze
    subject      TEXT NOT NULL,      -- installationId | 'all' | IP 해시
    window_start TEXT NOT NULL,      -- KST 일자('2026-08-11') 또는 고정창 시작 unix초
    count        INTEGER NOT NULL DEFAULT 0,
    expires_at   BIGINT NOT NULL,    -- unix seconds. 지난 창은 청소한다.
    PRIMARY KEY (scope, subject, window_start)
  );

  -- 운영 스위치. env로 두면 반영에 재배포가 필요해 "즉시 중단"이 되지 않는다.
  CREATE TABLE IF NOT EXISTS service_flags (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    reason     TEXT,
    updated_at TEXT NOT NULL
  );

  -- 운영 지표 1분 롤업(계획 3단계). 태스크마다 자기 행을 쓰고, 합치는 것은 조회 시점에 한다.
  -- 지연시간은 p50/p95가 아니라 히스토그램으로 둔다 — 태스크별 p95를 평균 내는 것은
  -- 통계적으로 의미가 없지만(p95의 평균은 p95가 아니다), 버킷 카운트는 더할 수 있다.
  CREATE TABLE IF NOT EXISTS ops_metrics (
    bucket_at    TEXT NOT NULL,      -- 분 경계 ISO
    service      TEXT NOT NULL,      -- bff | inference
    task_id      TEXT NOT NULL,      -- 태스크(프로세스) 식별자
    requests     INTEGER NOT NULL DEFAULT 0,
    errors_4xx   INTEGER NOT NULL DEFAULT 0,
    errors_5xx   INTEGER NOT NULL DEFAULT 0,
    duration_sum BIGINT  NOT NULL DEFAULT 0,
    lat_50       INTEGER NOT NULL DEFAULT 0,
    lat_100      INTEGER NOT NULL DEFAULT 0,
    lat_250      INTEGER NOT NULL DEFAULT 0,
    lat_500      INTEGER NOT NULL DEFAULT 0,
    lat_1000     INTEGER NOT NULL DEFAULT 0,
    lat_2500     INTEGER NOT NULL DEFAULT 0,
    lat_5000     INTEGER NOT NULL DEFAULT 0,
    lat_10000    INTEGER NOT NULL DEFAULT 0,
    lat_30000    INTEGER NOT NULL DEFAULT 0,
    lat_inf      INTEGER NOT NULL DEFAULT 0,
    by_error     JSONB   NOT NULL DEFAULT '{}'::jsonb,
    by_route     JSONB   NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (bucket_at, service, task_id)
  );

  CREATE TABLE IF NOT EXISTS admin_access_audit (
    audit_id     TEXT PRIMARY KEY,
    reviewer     TEXT NOT NULL,
    action       TEXT NOT NULL,
    job_id       TEXT,
    request_id   TEXT NOT NULL,
    occurred_at  TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
  CREATE UNIQUE INDEX IF NOT EXISTS users_provider ON users (provider, provider_id)
    WHERE provider_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at ON refresh_tokens (expires_at);
  CREATE INDEX IF NOT EXISTS usage_counters_expires_at ON usage_counters (expires_at);
  CREATE INDEX IF NOT EXISTS oauth_codes_expires_at ON oauth_codes (expires_at);
  CREATE INDEX IF NOT EXISTS jobs_user_id ON jobs (user_id);
  CREATE INDEX IF NOT EXISTS jobs_installation_id ON jobs (installation_id);
  -- 작업 기록 목록의 커서 페이지네이션((created_at, id) 비교 + ORDER BY DESC) 전용.
  -- jobs_installation_id는 이 복합의 접두라 중복이지만, DROP은 동시성 카운트 쿼리의
  -- 플랜에 영향을 주고 되돌리려면 재배포가 필요하므로 별도 정리 작업으로 미룬다.
  CREATE INDEX IF NOT EXISTS jobs_installation_created
    ON jobs (installation_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS analytics_events_installation ON analytics_events (installation_id, occurred_at);
  CREATE INDEX IF NOT EXISTS analytics_events_job ON analytics_events (job_id);
  CREATE INDEX IF NOT EXISTS candidates_job_rank ON analysis_candidates (job_id, person_index, rank);
  CREATE INDEX IF NOT EXISTS ops_metrics_bucket ON ops_metrics (bucket_at);

  CREATE OR REPLACE VIEW analytics_job_funnel AS
  SELECT
    j.id AS job_id,
    left(j.created_at, 10) AS day,
    j.status,
    (CASE WHEN j.inference_metadata_json IS NULL THEN '{}'::jsonb
          ELSE j.inference_metadata_json::jsonb END)->>'deploymentVersion' AS deployment_version,
    (CASE WHEN j.inference_metadata_json IS NULL THEN '{}'::jsonb
          ELSE j.inference_metadata_json::jsonb END)->>'poseModelVersion' AS pose_model_version,
    EXTRACT(EPOCH FROM (j.input_stored_at::timestamptz - j.created_at::timestamptz)) AS input_storage_seconds,
    EXTRACT(EPOCH FROM (j.completed_at::timestamptz - j.started_at::timestamptz)) AS inference_seconds,
    (SELECT min(ae.occurred_at) FROM analytics_events ae
      WHERE ae.job_id = j.id AND ae.event_name = 'results_viewed') AS results_viewed_at,
    (SELECT min(cs.confirmed_at) FROM confirmed_selections cs
      WHERE cs.job_id = j.id) AS selection_confirmed_at,
    (SELECT min(ee.occurred_at) FROM export_events ee
      WHERE ee.job_id = j.id AND ee.status = 'completed') AS export_completed_at,
    (SELECT count(*) FROM analytics_events ae
      WHERE ae.job_id = j.id AND ae.event_name = 'candidate_selected'
        AND ae.properties_json::jsonb->>'previousCandidateId' IS NOT NULL)::integer AS candidate_change_count
  FROM jobs j
  WHERE j.installation_id IS NOT NULL;

  CREATE OR REPLACE VIEW analytics_candidate_quality AS
  SELECT
    j.id AS job_id,
    left(j.created_at, 10) AS day,
    (CASE WHEN j.inference_metadata_json IS NULL THEN '{}'::jsonb
          ELSE j.inference_metadata_json::jsonb END)->>'deploymentVersion' AS deployment_version,
    (CASE WHEN j.inference_metadata_json IS NULL THEN '{}'::jsonb
          ELSE j.inference_metadata_json::jsonb END)->>'vlmModel' AS vlm_model,
    (CASE WHEN j.inference_metadata_json IS NULL THEN '{}'::jsonb
          ELSE j.inference_metadata_json::jsonb END)->>'poseModelVersion' AS pose_model_version,
    ap.person_index,
    ap.confidence AS person_confidence,
    CASE WHEN ap.skeleton_json IS NULL THEN NULL ELSE (
      SELECT avg(score::double precision)
      FROM jsonb_array_elements_text(ap.skeleton_json::jsonb->'scores') AS scores(score)
    ) END AS mean_joint_confidence,
    ap.candidate_count,
    ap.candidate_shortfall_reason,
    ac.candidate_id,
    ac.pose_id,
    ac.rank,
    ac.distance,
    ac.rerank_score,
    EXISTS (
      SELECT 1 FROM confirmed_selections cs
      WHERE cs.job_id = ac.job_id AND cs.person_index = ac.person_index
        AND cs.candidate_id = ac.candidate_id
    ) AS selected,
    jf.reason AS feedback_reason
  FROM jobs j
  JOIN analysis_people ap ON ap.job_id = j.id
  LEFT JOIN analysis_candidates ac
    ON ac.job_id = ap.job_id AND ac.person_index = ap.person_index
  LEFT JOIN job_feedback jf ON jf.job_id = j.id
  WHERE j.installation_id IS NOT NULL;
`;

// 이 앱 전용 advisory lock 키. 다른 서비스와 겹치지 않게 고정값 하나를 쓴다.
const INIT_LOCK_KEY = 0x5354_4e44; // "STND"

/**
 * 스키마 준비 + 만료 토큰 청소. 기동 시 1회.
 *
 * ECS는 태스크를 여러 개 동시에 띄우므로 CREATE ... IF NOT EXISTS가 서로 부딪힐 수 있다
 * (Postgres에서 동시 실행하면 duplicate 오류가 난다). advisory lock으로 한 번에 하나만
 * 통과시킨다. 락은 세션 단위라 같은 커넥션에서 잡고 푼다.
 */
export async function initDb(): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [INIT_LOCK_KEY]);
    try {
      await client.query(SCHEMA);
      await refreshAggregatesAndRetention(client);
      const now = Math.floor(Date.now() / 1000);
      await client.query("DELETE FROM refresh_tokens WHERE expires_at < $1", [now]);
      await client.query("DELETE FROM oauth_codes WHERE expires_at < $1", [now]);
      await client.query("DELETE FROM usage_counters WHERE expires_at < $1", [now]);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [INIT_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function refreshAggregatesAndRetention(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO daily_analytics_aggregates (
      day, jobs_started, jobs_completed, jobs_failed, confirmed_selections,
      top1_selections, mean_reciprocal_rank, exports_completed, feedback_json,
      latency_p50_seconds, latency_p95_seconds, refreshed_at
    )
    WITH job_facts AS (
      SELECT
        j.*,
        (SELECT count(*) FROM confirmed_selections cs WHERE cs.job_id = j.id) AS selection_count,
        (SELECT count(*) FROM confirmed_selections cs WHERE cs.job_id = j.id AND cs.rank = 1) AS top1_count,
        (SELECT sum(1.0 / cs.rank) FROM confirmed_selections cs WHERE cs.job_id = j.id AND cs.rank > 0) AS reciprocal_rank_sum,
        (SELECT count(*) FROM export_events ee WHERE ee.job_id = j.id AND ee.status = 'completed') AS completed_export_count,
        (SELECT jf.reason FROM job_feedback jf WHERE jf.job_id = j.id) AS feedback_reason
      FROM jobs j
      WHERE j.installation_id IS NOT NULL AND left(j.created_at, 10) < current_date::text
    )
    SELECT
      left(j.created_at, 10) AS day,
      count(*)::int,
      count(*) FILTER (WHERE j.status = 'completed')::int,
      count(*) FILTER (WHERE j.status = 'failed')::int,
      sum(j.selection_count)::int,
      sum(j.top1_count)::int,
      sum(j.reciprocal_rank_sum) / nullif(sum(j.selection_count), 0),
      sum(j.completed_export_count)::int,
      json_build_object(
        'good', count(*) FILTER (WHERE j.feedback_reason = 'good'),
        'person_missing', count(*) FILTER (WHERE j.feedback_reason = 'person_missing'),
        'skeleton_wrong', count(*) FILTER (WHERE j.feedback_reason = 'skeleton_wrong'),
        'candidates_irrelevant', count(*) FILTER (WHERE j.feedback_reason = 'candidates_irrelevant'),
        'export_problem', count(*) FILTER (WHERE j.feedback_reason = 'export_problem'),
        'other', count(*) FILTER (WHERE j.feedback_reason = 'other')
      )::text,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (j.completed_at::timestamptz - j.started_at::timestamptz))
      ) FILTER (WHERE j.completed_at IS NOT NULL AND j.started_at IS NOT NULL),
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (j.completed_at::timestamptz - j.started_at::timestamptz))
      ) FILTER (WHERE j.completed_at IS NOT NULL AND j.started_at IS NOT NULL),
      now()::text
    FROM job_facts j
    GROUP BY left(j.created_at, 10)
    ON CONFLICT (day) DO UPDATE SET
      jobs_started = EXCLUDED.jobs_started,
      jobs_completed = EXCLUDED.jobs_completed,
      jobs_failed = EXCLUDED.jobs_failed,
      confirmed_selections = EXCLUDED.confirmed_selections,
      top1_selections = EXCLUDED.top1_selections,
      mean_reciprocal_rank = EXCLUDED.mean_reciprocal_rank,
      exports_completed = EXCLUDED.exports_completed,
      feedback_json = EXCLUDED.feedback_json,
      latency_p50_seconds = EXCLUDED.latency_p50_seconds,
      latency_p95_seconds = EXCLUDED.latency_p95_seconds,
      refreshed_at = EXCLUDED.refreshed_at
  `);

  const oldJobs = `SELECT id FROM jobs WHERE installation_id IS NOT NULL
    AND created_at::timestamptz < now() - interval '365 days'`;
  await client.query(`DELETE FROM export_events WHERE job_id IN (${oldJobs})`);
  await client.query(`DELETE FROM job_feedback WHERE job_id IN (${oldJobs})`);
  await client.query(`DELETE FROM confirmed_selections WHERE job_id IN (${oldJobs})`);
  await client.query("DELETE FROM analytics_events WHERE occurred_at::timestamptz < now() - interval '365 days'");
  await client.query(`DELETE FROM admin_access_audit WHERE job_id IN (${oldJobs})`);
  // S3 객체 자체는 버킷 lifecycle(90일)과 동의 철회 삭제 스윕이 지운다. 여기서는 대장만 정리한다.
  await client.query(`DELETE FROM refined_artifacts WHERE job_id IN (${oldJobs})`);
  await client.query(`DELETE FROM analysis_candidates WHERE job_id IN (${oldJobs})`);
  await client.query(`DELETE FROM analysis_people WHERE job_id IN (${oldJobs})`);
  await client.query(`DELETE FROM jobs WHERE id IN (${oldJobs})`);
}

export async function runDataMaintenance(): Promise<void> {
  const client = await pool.connect();
  try {
    await refreshAggregatesAndRetention(client);
    await client.query("DELETE FROM usage_counters WHERE expires_at < $1", [
      Math.floor(Date.now() / 1000),
    ]);
    // 분 롤업은 14일만 둔다. 그 이상 거슬러 올라가 분 단위를 볼 일이 없고,
    // 태스크마다 분당 1행이라 방치하면 행 수가 가장 빨리 느는 테이블이 된다.
    await client.query("DELETE FROM ops_metrics WHERE bucket_at < $1", [
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    ]);
  } finally {
    client.release();
  }
}

/** Postgres 유니크 제약 위반(23505) 판별. */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "23505"
  );
}

/** 종료 시 커넥션 정리(SIGTERM 등). */
export async function closeDb(): Promise<void> {
  await pool.end();
}
