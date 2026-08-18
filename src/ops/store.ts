// ops_metrics 읽기·쓰기(계획 3단계).
//
// 쓰기는 태스크별 upsert다. 같은 (분, 서비스, 태스크) 행을 두 번 써도 결과가 같아야
// 추론 서버 지표를 다시 긁어와도 안전하다.
// 읽기는 전부 SQL에서 합친다 — 24시간이면 태스크당 1440행이라 앱으로 다 가져오면
// 대시보드 한 번 여는 비용이 서비스보다 커진다.
import { execute, query } from "../db.js";
import { LATENCY_BUCKETS_MS, percentileFromHistogram, type OpsBucket } from "./metrics.js";

const LATENCY_COLUMNS = [
  "lat_50",
  "lat_100",
  "lat_250",
  "lat_500",
  "lat_1000",
  "lat_2500",
  "lat_5000",
  "lat_10000",
  "lat_30000",
  "lat_inf",
] as const;

export interface SeriesPoint {
  at: string;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface CountedKey {
  key: string;
  count: number;
}

interface AggregateRow {
  at: string;
  requests: string;
  errors_4xx: string;
  errors_5xx: string;
  duration_sum: string;
  [key: string]: string;
}

/** 한 태스크의 닫힌 버킷들을 저장한다. 같은 행을 다시 써도 결과가 같다. */
export async function upsertBuckets(
  service: string,
  taskId: string,
  buckets: readonly OpsBucket[],
): Promise<void> {
  for (const bucket of buckets) {
    await execute(
      `INSERT INTO ops_metrics (
         bucket_at, service, task_id, requests, errors_4xx, errors_5xx, duration_sum,
         ${LATENCY_COLUMNS.join(", ")}, by_error, by_route
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (bucket_at, service, task_id) DO UPDATE SET
         requests = EXCLUDED.requests,
         errors_4xx = EXCLUDED.errors_4xx,
         errors_5xx = EXCLUDED.errors_5xx,
         duration_sum = EXCLUDED.duration_sum,
         ${LATENCY_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(", ")},
         by_error = EXCLUDED.by_error,
         by_route = EXCLUDED.by_route`,
      [
        bucket.bucketAt,
        service,
        taskId,
        bucket.requests,
        bucket.errors4xx,
        bucket.errors5xx,
        bucket.durationSumMs,
        ...LATENCY_COLUMNS.map((_, index) => bucket.latency[index] ?? 0),
        JSON.stringify(bucket.byError),
        JSON.stringify(bucket.byRoute),
      ],
    );
  }
}

function toPoint(row: AggregateRow): SeriesPoint {
  const latency = LATENCY_COLUMNS.map((column) => Number(row[column] ?? 0));
  const requests = Number(row.requests);
  return {
    at: row.at,
    requests,
    errors4xx: Number(row.errors_4xx),
    errors5xx: Number(row.errors_5xx),
    meanMs: requests > 0 ? Math.round(Number(row.duration_sum) / requests) : null,
    p50Ms: percentileFromHistogram(latency, 0.5),
    p95Ms: percentileFromHistogram(latency, 0.95),
  };
}

const SUM_COLUMNS = `
  sum(requests)::text AS requests,
  sum(errors_4xx)::text AS errors_4xx,
  sum(errors_5xx)::text AS errors_5xx,
  sum(duration_sum)::text AS duration_sum,
  ${LATENCY_COLUMNS.map((column) => `sum(${column})::text AS ${column}`).join(",\n  ")}
`;

/**
 * 분 단위 시계열. 서비스별로 나눠서 본다 — BFF가 멀쩡한데 추론만 느린 경우가
 * 실제 운영에서 가장 흔한 그림이고, 합쳐 놓으면 그게 안 보인다.
 */
export async function minuteSeries(sinceIso: string, service: string): Promise<SeriesPoint[]> {
  const rows = await query<AggregateRow>(
    `SELECT bucket_at AS at, ${SUM_COLUMNS}
     FROM ops_metrics
     WHERE bucket_at >= $1 AND service = $2
     GROUP BY bucket_at
     ORDER BY bucket_at`,
    [sinceIso, service],
  );
  return rows.map(toPoint);
}

/** 시간 단위 시계열(24시간 뷰). 분 단위로 1440점을 그리면 읽을 수 없다. */
export async function hourSeries(sinceIso: string, service: string): Promise<SeriesPoint[]> {
  const rows = await query<AggregateRow>(
    `SELECT substring(bucket_at from 1 for 13) || ':00:00.000Z' AS at, ${SUM_COLUMNS}
     FROM ops_metrics
     WHERE bucket_at >= $1 AND service = $2
     GROUP BY substring(bucket_at from 1 for 13)
     ORDER BY 1`,
    [sinceIso, service],
  );
  return rows.map(toPoint);
}

export async function totals(sinceIso: string, service: string): Promise<SeriesPoint> {
  const rows = await query<AggregateRow>(
    `SELECT $1::text AS at, ${SUM_COLUMNS}
     FROM ops_metrics
     WHERE bucket_at >= $1 AND service = $2`,
    [sinceIso, service],
  );
  const row = rows[0];
  if (!row || row.requests === null) {
    return { at: sinceIso, requests: 0, errors4xx: 0, errors5xx: 0, meanMs: null, p50Ms: null, p95Ms: null };
  }
  return toPoint({ ...row, requests: row.requests ?? "0" });
}

/** jsonb 맵을 SQL에서 펼쳐 합친다. 상위 몇 개만 보면 되므로 앱으로 다 가져오지 않는다. */
async function topKeys(sinceIso: string, column: "by_error" | "by_route", limit: number): Promise<CountedKey[]> {
  const rows = await query<{ key: string; count: string }>(
    `SELECT entry.key AS key, sum(entry.value::int)::text AS count
     FROM ops_metrics, jsonb_each_text(${column}) AS entry
     WHERE bucket_at >= $1
     GROUP BY entry.key
     ORDER BY sum(entry.value::int) DESC
     LIMIT ${limit}`,
    [sinceIso],
  );
  return rows.map((row) => ({ key: row.key, count: Number(row.count) }));
}

export const topErrors = (sinceIso: string) => topKeys(sinceIso, "by_error", 10);
export const topRoutes = (sinceIso: string) => topKeys(sinceIso, "by_route", 10);

/** 최근에 지표를 쓴 태스크 수. 롤링 배포·태스크 교체를 눈으로 확인하는 값이다. */
export async function activeTasks(sinceIso: string): Promise<Record<string, number>> {
  const rows = await query<{ service: string; tasks: string }>(
    `SELECT service, count(DISTINCT task_id)::text AS tasks
     FROM ops_metrics WHERE bucket_at >= $1 GROUP BY service`,
    [sinceIso],
  );
  return Object.fromEntries(rows.map((row) => [row.service, Number(row.tasks)]));
}

export { LATENCY_BUCKETS_MS };
