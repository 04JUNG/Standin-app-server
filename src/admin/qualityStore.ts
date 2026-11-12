import { query } from "../db.js";
import type { DailyAggregateRow } from "./quality.js";

// Live consent-scoped facts: cached aggregates cannot enforce withdrawal.
export async function dailyAggregates(
  days: number,
): Promise<DailyAggregateRow[]> {
  return query<DailyAggregateRow>(DAILY_AGGREGATES_SQL, [days]);
}

export const DAILY_AGGREGATES_SQL = `WITH job_facts AS (
      SELECT
        j.*,
        (SELECT count(*) FROM quality_review_confirmed_selections cs WHERE cs.job_id = j.id) AS selection_count,
        (SELECT count(*) FROM quality_review_confirmed_selections cs WHERE cs.job_id = j.id AND cs.rank > 0) AS valid_rank_count,
        (SELECT count(*) FROM quality_review_confirmed_selections cs WHERE cs.job_id = j.id AND cs.rank = 1) AS top1_count,
        (SELECT sum(1.0 / cs.rank) FROM quality_review_confirmed_selections cs WHERE cs.job_id = j.id AND cs.rank > 0) AS reciprocal_rank_sum,
        (SELECT count(*) FROM quality_review_export_events ee WHERE ee.job_id = j.id AND ee.status = 'completed') AS completed_export_count,
        (SELECT jf.reason FROM quality_review_job_feedback jf WHERE jf.job_id = j.id) AS feedback_reason
      FROM quality_review_jobs j
      WHERE left(j.created_at, 10) < current_date::text AND j.created_at::timestamptz >= current_date - $1::int
    )
    SELECT
      left(j.created_at, 10) AS day,
      count(*)::int AS jobs_started,
      count(*) FILTER (WHERE j.status = 'completed')::int AS jobs_completed,
      count(*) FILTER (WHERE j.status = 'failed')::int AS jobs_failed,
      sum(j.selection_count)::int AS confirmed_selections,
      count(*) FILTER (WHERE j.selection_count > 0)::int AS selected_jobs,
      count(*) FILTER (WHERE j.selection_count > 0 AND j.status = 'completed')::int AS selected_completed_jobs,
      sum(j.selection_count)::int AS selection_samples,
      sum(j.valid_rank_count)::int AS valid_rank_samples,
      sum(j.top1_count)::int AS top1_selections,
      sum(j.reciprocal_rank_sum) / nullif(sum(j.valid_rank_count), 0) AS mean_reciprocal_rank,
      sum(j.completed_export_count)::int AS exports_completed,
      count(*) FILTER (WHERE j.completed_export_count > 0 AND j.selection_count > 0)::int AS exported_selected_jobs,
      json_build_object(
        'good', count(*) FILTER (WHERE j.feedback_reason = 'good'),
        'person_missing', count(*) FILTER (WHERE j.feedback_reason = 'person_missing'),
        'skeleton_wrong', count(*) FILTER (WHERE j.feedback_reason = 'skeleton_wrong'),
        'candidates_irrelevant', count(*) FILTER (WHERE j.feedback_reason = 'candidates_irrelevant'),
        'export_problem', count(*) FILTER (WHERE j.feedback_reason = 'export_problem'),
        'other', count(*) FILTER (WHERE j.feedback_reason = 'other')
      )::text AS feedback_json
    FROM job_facts j GROUP BY left(j.created_at, 10) ORDER BY day`;
