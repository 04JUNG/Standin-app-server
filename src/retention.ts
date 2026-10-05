// 사용자 데이터를 지우는 세 경로가 쓰는 하나의 목록.
//
// - 작업 삭제: jobs/store.ts::deleteOwnedJob
// - 동의 철회: installations/store.ts::revokeAndDeleteInstallationData
// - 365일 보관 만료: db.ts::refreshAggregatesAndRetention
//
// 경로마다 목록을 따로 들고 있으면 테이블이 늘 때 한 곳만 고쳐진다. 실제로 동의 철회가
// 조정본 대장(refined_artifacts)과 설치 단위 관리자 열람 기록을 남기고 있었다.
// retention.test.ts가 SCHEMA에서 job_id·installation_id 칸이 있는 테이블을 모두 찾아
// 이 목록과 맞춰 보므로, 새 테이블을 만들면 여기에 넣어야 테스트가 통과한다.

/** 이 모듈이 쓰는 클라이언트 기능. pg의 PoolClient가 그대로 들어온다. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/** job_id로 작업에 딸린 테이블. jobs 행보다 먼저 지운다. */
export const JOB_SCOPED_TABLES = [
  "export_events",
  "job_feedback",
  "confirmed_selections",
  "analytics_events",
  "admin_access_audit",
  "refined_artifacts",
  "analysis_candidates",
  "analysis_people",
] as const;

/** jobs(id) ON DELETE CASCADE라 jobs 행과 함께 사라지는 테이블. */
export const CASCADE_TABLES = ["job_outbox"] as const;

/**
 * installation_id 칸이 있는 테이블. 작업 밖 분석 이벤트, 작업 없는 export 기록, 설치 단위
 * 관리자 열람처럼 job_id가 빈 행은 작업을 따라 지워지지 않으므로 이 칸으로 지운다.
 */
export const INSTALLATION_SCOPED_TABLES = [
  "export_events",
  "job_feedback",
  "confirmed_selections",
  "analytics_events",
  "admin_access_audit",
] as const;

/**
 * 행마다 시각이 있는 기록 테이블과 그 시각 칸. job_id가 빈 행이 있으므로 작업 만료와 따로
 * 자기 시각으로 자른다. 작업에 딸린 행은 작업보다 늦게 생기므로 이 기준 때문에 작업보다
 * 먼저 지워지는 일은 없다.
 */
export const EVENT_LOG_TABLES = {
  analytics_events: "occurred_at",
  export_events: "occurred_at",
  admin_access_audit: "occurred_at",
} as const;

export const RETENTION_DAYS = 365;

/**
 * 지울 작업을 고르는 SQL 조각. `id IN (…)` 괄호 안에 그대로 들어간다. `$1` 하나이거나
 * `SELECT id FROM jobs WHERE …` 서브쿼리다. 값은 params로만 넘긴다.
 */
export interface JobSelection {
  ids: string;
  params: unknown[];
}

/**
 * 고른 작업과 그 작업에 딸린 행을 지운다.
 *
 * 먼저 작업 행을 잠근다. 워커의 persistAnalysisRecords와 조정본 저장(refine/store.ts)도 같은
 * 행을 잠근 뒤에 쓰므로 둘은 차례로만 지나간다. 잠그지 않으면 여기서 analysis_people을 지운
 * 뒤에 워커가 결과를 커밋해, 존재하지 않는 job_id의 관절 행이 남는다. 그런 행은 어떤 삭제
 * 경로도 다시 찾지 못한다. 트랜잭션 밖(보관 만료 스윕)에서는 잠금이 바로 풀리지만, 그쪽은
 * 1년 지난 작업이라 동시에 쓰는 쪽이 없다.
 */
export async function deleteJobs(client: SqlClient, selection: JobSelection): Promise<void> {
  await client.query(
    `SELECT id FROM jobs WHERE id IN (${selection.ids}) ORDER BY id FOR UPDATE`,
    selection.params,
  );
  for (const table of JOB_SCOPED_TABLES) {
    await client.query(
      `DELETE FROM ${table} WHERE job_id IN (${selection.ids})`,
      selection.params,
    );
  }
  // job_outbox는 jobs(id) ON DELETE CASCADE로 함께 지워진다.
  await client.query(`DELETE FROM jobs WHERE id IN (${selection.ids})`, selection.params);
}

/**
 * 설치 하나에 묶인 데이터를 모두 지운다. installations 행은 호출자가 같은 트랜잭션에서 지운다.
 * S3 객체(입력 원본·조정본)는 inputStorage.deleteInstallationObjects가 맡는다.
 */
export async function deleteInstallationData(
  client: SqlClient,
  installationId: string,
): Promise<void> {
  await deleteJobs(client, {
    ids: "SELECT id FROM jobs WHERE installation_id = $1",
    params: [installationId],
  });
  for (const table of INSTALLATION_SCOPED_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE installation_id = $1`, [installationId]);
  }
  // 주간 쿼터 카운터는 subject가 설치 ID다. 창이 끝나면 만료 청소가 지우지만, 철회한 설치의
  // ID를 그때까지 남길 이유가 없다.
  await client.query(
    "DELETE FROM usage_counters WHERE scope = 'installation_week' AND subject = $1",
    [installationId],
  );
}

/**
 * 보관 기간이 지난 작업과 기록을 지운다.
 *
 * 기준 시각은 한 번만 정해 모든 문장에 넘긴다. 문장마다 now()를 다시 읽으면, 그 사이에 365일을
 * 넘긴 작업이 딸린 행은 남긴 채 jobs에서만 지워진다. 그렇게 남은 행은 다음 스윕도 찾지 못한다.
 */
export async function deleteExpiredRows(client: SqlClient, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await deleteJobs(client, {
    ids:
      "SELECT id FROM jobs WHERE installation_id IS NOT NULL" +
      " AND created_at::timestamptz < $1::timestamptz",
    params: [cutoff],
  });
  for (const [table, column] of Object.entries(EVENT_LOG_TABLES)) {
    await client.query(
      `DELETE FROM ${table} WHERE ${column}::timestamptz < $1::timestamptz`,
      [cutoff],
    );
  }
}
