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
    `SELECT
       (SELECT count(*)::int FROM installations WHERE last_seen_at >= $2) AS active_today,
       (SELECT count(*)::int FROM installations WHERE revoked_at IS NULL) AS total_installations,
       (SELECT count(*)::int FROM export_events
         WHERE status = 'completed' AND occurred_at >= $1) AS downloads,
       (SELECT count(*)::int FROM job_feedback WHERE submitted_at >= $1) AS feedback_count,
       (SELECT count(*)::int FROM job_feedback
         WHERE submitted_at >= $1 AND reason = 'candidates_irrelevant') AS irrelevant_count`,
    [from, dayAgo],
  );
  return (
    row ?? {
      active_today: 0,
      total_installations: 0,
      downloads: 0,
      feedback_count: 0,
      irrelevant_count: 0,
    }
  );
}
