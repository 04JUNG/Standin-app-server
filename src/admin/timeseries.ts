// 시간대별 활동(몇 시에 몇 명이 들어왔고 Job이 몇 개였나). SQL은 `timeseriesStore.ts`에 있다.
//
// 구간 경계는 **한국 시간(KST) 자정**에 맞춘다. 운영자가 읽는 시각이 KST라, UTC로 자르면
// "3시간" 구간이 02:00~05:00처럼 어긋나 읽기 어렵다.

/** 범위 → 고를 수 있는 묶음 단위. 점이 너무 많거나(읽을 수 없다) 적지(모양이 없다) 않게 묶는다. */
export const RANGES = {
  "24h": { seconds: 24 * 3600, buckets: ["1h", "3h"] },
  "7d": { seconds: 7 * 24 * 3600, buckets: ["3h", "6h", "1d"] },
  "30d": { seconds: 30 * 24 * 3600, buckets: ["6h", "1d"] },
  "90d": { seconds: 90 * 24 * 3600, buckets: ["1d"] },
} as const;

export const BUCKETS = { "1h": 3600, "3h": 3 * 3600, "6h": 6 * 3600, "1d": 24 * 3600 } as const;

export type RangeKey = keyof typeof RANGES;
export type BucketKey = keyof typeof BUCKETS;

/** KST = UTC+9. 구간을 KST 자정에 맞추려고 이만큼 밀었다가 되돌린다. */
export const KST_OFFSET_SECONDS = 9 * 3600;

export interface TimeseriesQuery {
  range: RangeKey;
  bucket: BucketKey;
  rangeSeconds: number;
  bucketSeconds: number;
}

export type ParsedTimeseriesQuery =
  | { ok: true; query: TimeseriesQuery }
  | { ok: false; message: string };

export function parseTimeseriesQuery(raw: { range?: string; bucket?: string }): ParsedTimeseriesQuery {
  const range = (raw.range ?? "24h") as RangeKey;
  if (!(range in RANGES)) {
    return { ok: false, message: `range는 ${Object.keys(RANGES).join(", ")} 중 하나여야 합니다.` };
  }
  const allowed = RANGES[range].buckets as readonly string[];
  const bucket = (raw.bucket ?? allowed[0]) as BucketKey;
  if (!allowed.includes(bucket)) {
    // 범위에 안 맞는 단위를 조용히 바꾸지 않는다. 화면이 보낸 값과 다른 그림이 나오면 헷갈린다.
    return { ok: false, message: `${range}에서는 bucket을 ${allowed.join(", ")} 중에서 고르세요.` };
  }
  return {
    ok: true,
    query: { range, bucket, rangeSeconds: RANGES[range].seconds, bucketSeconds: BUCKETS[bucket] },
  };
}

/** `now`가 속한 구간의 시작(KST 경계에 맞춘 UTC epoch 초). */
export function bucketStart(epochSeconds: number, bucketSeconds: number): number {
  return (
    Math.floor((epochSeconds + KST_OFFSET_SECONDS) / bucketSeconds) * bucketSeconds - KST_OFFSET_SECONDS
  );
}

/** SQL이 돌려주는 한 구간. 값이 있는 구간만 온다. */
export interface TimeseriesRow {
  bucket: string;
  active_installations: number | null;
  jobs_started: number | null;
  jobs_completed: number | null;
  jobs_failed: number | null;
  downloads: number | null;
}

export interface TimeseriesPoint {
  start: string;
  end: string;
  activeInstallations: number;
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
  downloads: number;
}

/**
 * 비어 있는 구간을 0으로 채워 이어진 시간축을 만든다.
 *
 * SQL은 값이 있는 구간만 돌려준다. 그대로 그리면 활동이 없던 밤 시간이 빠져 시간축이
 * 건너뛰고, 그 사이를 선이 그대로 이어 "그 시간에도 사람이 있었다"처럼 보인다.
 * 마지막(지금이 속한) 구간도 넣는다 — 아직 진행 중이라 값이 작다는 건 화면이 알린다.
 */
export function fillBuckets(
  rows: TimeseriesRow[],
  nowEpochSeconds: number,
  query: Pick<TimeseriesQuery, "rangeSeconds" | "bucketSeconds">,
): TimeseriesPoint[] {
  const last = bucketStart(nowEpochSeconds, query.bucketSeconds);
  const first = bucketStart(nowEpochSeconds - query.rangeSeconds, query.bucketSeconds) + query.bucketSeconds;
  const byStart = new Map<number, TimeseriesRow>();
  for (const row of rows) {
    const epoch = Math.floor(Date.parse(row.bucket) / 1000);
    if (Number.isFinite(epoch)) byStart.set(epoch, row);
  }
  const points: TimeseriesPoint[] = [];
  for (let start = first; start <= last; start += query.bucketSeconds) {
    const row = byStart.get(start);
    points.push({
      start: new Date(start * 1000).toISOString(),
      end: new Date((start + query.bucketSeconds) * 1000).toISOString(),
      activeInstallations: row?.active_installations ?? 0,
      jobsStarted: row?.jobs_started ?? 0,
      jobsCompleted: row?.jobs_completed ?? 0,
      jobsFailed: row?.jobs_failed ?? 0,
      downloads: row?.downloads ?? 0,
    });
  }
  return points;
}
