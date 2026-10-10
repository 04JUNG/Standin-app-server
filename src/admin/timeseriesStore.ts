// 시간대별 활동 집계 SQL. 구간 나누기·빈 구간 채우기는 `timeseries.ts`가 한다.
import { query } from "../db.js";
import { KST_OFFSET_SECONDS, type TimeseriesQuery, type TimeseriesRow } from "./timeseries.js";

/**
 * 구간마다 서로 다른 설치 수, Job 수(상태별), 완료된 다운로드 수.
 *
 * "들어온 사람"은 `installations.last_seen_at`으로 셀 수 없다 — 마지막 접속 하나만 남아,
 * 어제 왔다가 오늘 다시 온 사람이 어제 칸에서 사라진다. 그래서 그 구간에 앱 이벤트나
 * Job을 하나라도 남긴 설치를 센다. 이벤트 시각은 기기가 보낸 `occurred_at`이다.
 *
 * 구간 시작은 KST 자정에 맞춘다(`bucketStart`와 같은 식). 합산은 전부 SQL에서 끝낸다.
 */
export async function activityTimeseries(params: TimeseriesQuery, nowMs = Date.now()): Promise<TimeseriesRow[]> {
  const since = new Date(nowMs - params.rangeSeconds * 1000).toISOString();
  const step = params.bucketSeconds;
  const bucketExpr = (column: string) =>
    `to_timestamp(floor((extract(epoch FROM ${column}::timestamptz) + ${KST_OFFSET_SECONDS}) / $2) * $2 - ${KST_OFFSET_SECONDS})`;
  return query<TimeseriesRow>(
    `WITH seen AS (
       SELECT installation_id, occurred_at AS at FROM analytics_events WHERE occurred_at >= $1
       UNION ALL
       SELECT installation_id, created_at FROM jobs
        WHERE created_at >= $1 AND installation_id IS NOT NULL
     ),
     active AS (
       SELECT ${bucketExpr("at")} AS bucket, count(DISTINCT installation_id)::int AS active_installations
         FROM seen GROUP BY 1
     ),
     job_counts AS (
       SELECT ${bucketExpr("created_at")} AS bucket,
              count(*)::int AS jobs_started,
              count(*) FILTER (WHERE status = 'completed')::int AS jobs_completed,
              count(*) FILTER (WHERE status = 'failed')::int AS jobs_failed
         FROM jobs WHERE created_at >= $1 AND installation_id IS NOT NULL GROUP BY 1
     ),
     download_counts AS (
       SELECT ${bucketExpr("occurred_at")} AS bucket, count(*)::int AS downloads
         FROM export_events WHERE status = 'completed' AND occurred_at >= $1 GROUP BY 1
     ),
     buckets AS (
       SELECT bucket FROM active UNION SELECT bucket FROM job_counts UNION SELECT bucket FROM download_counts
     )
     SELECT to_char(b.bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
            a.active_installations, j.jobs_started, j.jobs_completed, j.jobs_failed, d.downloads
       FROM buckets b
       LEFT JOIN active a ON a.bucket = b.bucket
       LEFT JOIN job_counts j ON j.bucket = b.bucket
       LEFT JOIN download_counts d ON d.bucket = b.bucket
      ORDER BY b.bucket`,
    [since, step],
  );
}
