// KPI 띠가 퍼널 말고 따로 세는 값. 합산은 SQL에서 끝낸다(행을 앱으로 가져오지 않는다).
import { queryOne } from "../db.js";
import type { OverviewExtraRow } from "./overview.js";

/** 기간 경계. `created_at`·`occurred_at`이 TEXT라 ISO 문자열 비교가 곧 시간 비교다. */
function since(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function overviewExtras(days: number): Promise<OverviewExtraRow> {
  const from = since(days);
  const dayAgo = since(1);
  const row = await queryOne<OverviewExtraRow>(
    // 설치·분석 수는 집계 전용 뷰(ops_count_*)로 전체를 센다. 나머지는 동의 범위다.
    `SELECT
       (SELECT count(*)::int FROM ops_count_installations WHERE last_seen_at >= $1) AS active_period,
       (SELECT count(*)::int FROM ops_count_installations WHERE last_seen_at >= $2) AS active_today,
       (SELECT count(*)::int FROM ops_count_installations) AS total_installations,
       (SELECT count(*)::int FROM ops_count_jobs WHERE created_at >= $1) AS jobs_started,
       (SELECT count(*)::int FROM ops_count_jobs WHERE created_at >= $1 AND status = 'completed') AS jobs_completed,
       (SELECT count(*)::int FROM ops_count_jobs WHERE created_at >= $1 AND status = 'failed') AS jobs_failed,
       (SELECT count(*)::int FROM quality_review_export_events
         WHERE status = 'completed' AND occurred_at >= $1) AS downloads,
       (SELECT count(*)::int FROM quality_review_job_feedback WHERE submitted_at >= $1) AS feedback_count,
       (SELECT count(*)::int FROM quality_review_job_feedback
         WHERE submitted_at >= $1 AND reason = 'candidates_irrelevant') AS irrelevant_count`,
    [from, dayAgo],
  );
  return (
    row ?? {
      active_period: 0,
      active_today: 0,
      total_installations: 0,
      jobs_started: 0,
      jobs_completed: 0,
      jobs_failed: 0,
      downloads: 0,
      feedback_count: 0,
      irrelevant_count: 0,
    }
  );
}
