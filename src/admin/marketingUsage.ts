import { queryOne } from '../db.js';
import { HIDE_INTERNAL_FLAG } from '../installations/qualityConsent.js';

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
      COALESCE((SELECT value='true' FROM service_flags WHERE key=$3),true) AS "hideInternal"
  `, [since, queriedAt, HIDE_INTERNAL_FLAG]);
  if (!result) throw new Error('marketing_usage_unavailable');
  return result;
}
