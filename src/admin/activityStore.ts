// 사용자(설치)별 활동 SQL. 날짜는 KST로 자른다. 변환은 `activity.ts`.
import { query } from "../db.js";
import type { ActivityJobRow } from "./activity.js";

const KST_DATE = (column: string) =>
  `to_char((${column}::timestamptz AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD')`;

/** 설치 하나의 날짜별 흔적 수(앱 이벤트 + Job). 0인 날은 오지 않는다. */
export async function visitDays(installationId: string, since: string): Promise<Array<{ day: string; events: number }>> {
  return query<{ day: string; events: number }>(
    `SELECT ${KST_DATE("at")} AS day, count(*)::int AS events
       FROM (
         SELECT occurred_at AS at FROM analytics_events WHERE installation_id = $1 AND occurred_at >= $2
         UNION ALL
         SELECT created_at FROM jobs WHERE installation_id = $1 AND created_at >= $2
       ) seen
      GROUP BY 1`,
    [installationId, since],
  );
}

/** 설치 하나의 최근 Job과 그 결과. 최대 100건. */
export async function activityJobs(installationId: string, since: string): Promise<ActivityJobRow[]> {
  return query<ActivityJobRow>(
    `SELECT j.id, j.created_at, j.status, j.error_code,
            coalesce(p.n, 0)::int AS person_count,
            coalesce(s.n, 0)::int AS selection_count,
            EXISTS (SELECT 1 FROM export_events e WHERE e.job_id = j.id AND e.status = 'completed') AS exported,
            EXISTS (SELECT 1 FROM refined_artifacts r WHERE r.job_id = j.id AND r.refined) AS refined,
            f.reason AS feedback
       FROM jobs j
       LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM analysis_people ap WHERE ap.job_id = j.id) p ON TRUE
       LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM confirmed_selections cs WHERE cs.job_id = j.id) s ON TRUE
       LEFT JOIN job_feedback f ON f.job_id = j.id
      WHERE j.installation_id = $1 AND j.created_at >= $2
      ORDER BY j.created_at DESC
      LIMIT 100`,
    [installationId, since],
  );
}

/** 여러 설치의 날짜별 흔적(출석 점용). ids는 호출하는 쪽이 50개 이하로 자른다. */
export async function visitStrips(
  ids: string[],
  since: string,
): Promise<Array<{ installation_id: string; day: string; events: number; jobs: number }>> {
  if (ids.length === 0) return [];
  return query<{ installation_id: string; day: string; events: number; jobs: number }>(
    `SELECT installation_id, ${KST_DATE("at")} AS day,
            count(*)::int AS events,
            count(*) FILTER (WHERE kind = 'job')::int AS jobs
       FROM (
         SELECT installation_id, occurred_at AS at, 'event' AS kind FROM analytics_events
          WHERE installation_id = ANY($1) AND occurred_at >= $2
         UNION ALL
         SELECT installation_id, created_at, 'job' FROM jobs
          WHERE installation_id = ANY($1) AND created_at >= $2
       ) seen
      GROUP BY 1, 2`,
    [ids, since],
  );
}
