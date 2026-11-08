import { query, queryOne } from '../db.js';
import { seoulDay } from '../marketingCounts.js';

/** Count existing service records only. No new telemetry, creative join or content access. */
export interface MarketingUsage {
  newInstallations: number;
  newStarted: number;
  newCompleted: number;
  activeInstallations: number;
  startedInstallations: number;
  completedInstallations: number;
  jobsStarted: number;
  jobsCompleted: number;
  hideInternal: boolean;
}

export async function marketingUsage(days: number, queriedAt: string): Promise<MarketingUsage> {
  const since = new Date(Date.parse(queriedAt) - days * 86400000).toISOString();
  const result = await queryOne<MarketingUsage>(`
    WITH eligible AS (
      SELECT * FROM ops_count_installations WHERE created_at <= $2
    ), period_jobs AS (
      SELECT * FROM ops_count_jobs WHERE created_at >= $1 AND created_at <= $2
    ), cohort AS (
      SELECT * FROM eligible WHERE created_at >= $1
    )
    SELECT
      (SELECT count(*)::int FROM cohort) AS "newInstallations",
      (SELECT count(*)::int FROM cohort i WHERE EXISTS (
        SELECT 1 FROM period_jobs j WHERE j.installation_id=i.id AND j.created_at >= i.created_at
      )) AS "newStarted",
      (SELECT count(*)::int FROM cohort i WHERE EXISTS (
        SELECT 1 FROM period_jobs j WHERE j.installation_id=i.id AND j.created_at >= i.created_at AND j.status='completed'
      )) AS "newCompleted",
      (SELECT count(*)::int FROM eligible WHERE last_seen_at >= $1) AS "activeInstallations",
      (SELECT count(DISTINCT installation_id)::int FROM period_jobs) AS "startedInstallations",
      (SELECT count(DISTINCT installation_id)::int FROM period_jobs WHERE status='completed') AS "completedInstallations",
      (SELECT count(*)::int FROM period_jobs) AS "jobsStarted",
      (SELECT count(*)::int FROM period_jobs WHERE status='completed') AS "jobsCompleted",
      TRUE AS "hideInternal"
  `, [since, queriedAt]);
  if (!result) throw new Error('marketing_usage_unavailable');
  return result;
}

export interface UsageDay { day: string; newInstallations: number; jobsStarted: number; jobsCompleted: number; jobsFailed: number }
export interface MarketingUsageDetails {
  since: string; until: string; repeatAnalyzers: number; jobsFailed: number; jobsPending: number; trend: UsageDay[];
}

/** Existing service records only; deliberately no new per-install history or ad-source join. */
export async function marketingUsageDetails(days: number, queriedAt: string): Promise<MarketingUsageDetails> {
  if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isFinite(Date.parse(queriedAt))) throw new Error('invalid_window');
  const now = Date.parse(queriedAt), since = new Date(now - days * 86400000).toISOString();
  const [rows, totals] = await Promise.all([
    query<UsageDay>(`
      WITH registrations AS (
        SELECT (created_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date AS day, count(*)::int AS n
        FROM ops_count_installations WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1
      ), jobs AS (
        SELECT (created_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date AS day,
          count(*)::int AS started, count(*) FILTER(WHERE status='completed')::int AS completed,
          count(*) FILTER(WHERE status='failed')::int AS failed
        FROM ops_count_jobs WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1
      ) SELECT COALESCE(r.day,j.day)::text AS day, COALESCE(r.n,0)::int AS "newInstallations",
        COALESCE(j.started,0)::int AS "jobsStarted", COALESCE(j.completed,0)::int AS "jobsCompleted",
        COALESCE(j.failed,0)::int AS "jobsFailed" FROM registrations r FULL OUTER JOIN jobs j ON j.day=r.day
      ORDER BY 1`, [since, queriedAt]),
    queryOne<{ repeatAnalyzers: number; jobsFailed: number; jobsPending: number }>(`
      WITH jobs AS (SELECT * FROM ops_count_jobs WHERE created_at >= $1 AND created_at <= $2)
      SELECT (SELECT count(*)::int FROM (
        SELECT installation_id FROM jobs GROUP BY installation_id
        HAVING count(DISTINCT (created_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date) >= 2
      ) repeated) AS "repeatAnalyzers", count(*) FILTER(WHERE status='failed')::int AS "jobsFailed",
        count(*) FILTER(WHERE status IN ('queued','running'))::int AS "jobsPending" FROM jobs`, [since, queriedAt]),
  ]);
  if (!totals) throw new Error('marketing_usage_details_unavailable');
  const byDay = new Map(rows.map(row => [row.day, row]));
  const trend: UsageDay[] = [];
  // A rolling N-day window touches N+1 calendar dates. Both edge dates are partial.
  for (let date = seoulDay(Date.parse(since)); date <= seoulDay(now);
    date = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    trend.push(byDay.get(date) ?? { day: date, newInstallations: 0, jobsStarted: 0, jobsCompleted: 0, jobsFailed: 0 });
  }
  return { since, until: queriedAt, ...totals, trend };
}
