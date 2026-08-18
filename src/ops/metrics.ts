// 요청 지표를 분 단위로 모은다(계획 3단계).
//
// 요청마다 DB를 쓰지 않는 이유: 분석 1건에 수십 요청이 붙는데 그때마다 INSERT를 하면
// 지표 수집이 서비스보다 무거워진다. 태스크마다 1분 버킷을 메모리에 모아 1분에 한 번만
// 쓴다. 태스크가 여러 개면 행도 여러 개 생기고, 합치는 것은 조회 시점에 한다.
//
// 지연시간을 p50/p95 값으로 저장하지 않고 **히스토그램**으로 저장한다. 태스크별 p95를
// 나중에 평균 내는 것은 통계적으로 의미가 없기 때문이다(p95의 평균은 p95가 아니다).
// 버킷 카운트는 더하면 되므로 태스크·시간을 가로질러 합산해도 값이 성립한다.
// 대신 분위수는 버킷 경계까지만 정확하다(Prometheus 히스토그램과 같은 절충).

/** 지연시간 히스토그램 경계(ms). 마지막 칸은 이 값을 넘은 요청이다. */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000] as const;

/**
 * 라우트·에러코드는 원래 유한하지만, 버그나 공격으로 값이 폭발하면 이 맵이 메모리를
 * 먹고 DB 행도 커진다. 상한을 넘으면 나머지는 한 칸으로 접는다.
 */
const MAX_KEYS = 50;
const OVERFLOW_KEY = "_other";

export interface OpsBucket {
  /** 분 경계 ISO 문자열. 이 값이 DB 기본키의 일부다. */
  bucketAt: string;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  /** 평균을 정확히 내기 위해 합도 함께 둔다(히스토그램만으로는 평균이 근사값이다). */
  durationSumMs: number;
  /** 길이 = LATENCY_BUCKETS_MS.length + 1. 마지막 칸이 초과분이다. */
  latency: number[];
  byError: Record<string, number>;
  byRoute: Record<string, number>;
}

export interface RequestSample {
  status: number;
  durationMs: number;
  route?: string;
  errorCode?: string;
}

export function bucketKeyOf(timestampMs: number): string {
  return new Date(Math.floor(timestampMs / 60_000) * 60_000).toISOString();
}

function bump(map: Record<string, number>, key: string): void {
  if (map[key] === undefined && Object.keys(map).length >= MAX_KEYS) {
    map[OVERFLOW_KEY] = (map[OVERFLOW_KEY] ?? 0) + 1;
    return;
  }
  map[key] = (map[key] ?? 0) + 1;
}

function emptyBucket(bucketAt: string): OpsBucket {
  return {
    bucketAt,
    requests: 0,
    errors4xx: 0,
    errors5xx: 0,
    durationSumMs: 0,
    latency: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
    byError: {},
    byRoute: {},
  };
}

function latencyIndex(durationMs: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    if (durationMs <= LATENCY_BUCKETS_MS[i]!) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

/**
 * 분 버킷 수집기. 시간을 인자로 받으므로 타이머 없이 검증할 수 있다.
 *
 * 닫힌 버킷만 내보낸다 — 진행 중인 분을 쓰면 같은 분에 두 번 쓰게 되고, 두 번째 쓰기가
 * 첫 번째를 덮어 앞부분 요청이 사라진다.
 */
export class MetricsCollector {
  private readonly buckets = new Map<string, OpsBucket>();

  /** 메모리 상한. flush가 계속 실패해도 오래된 버킷부터 버리고 서비스는 계속 돈다. */
  constructor(private readonly maxBuckets = 30) {}

  record(nowMs: number, sample: RequestSample): void {
    const key = bucketKeyOf(nowMs);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = emptyBucket(key);
      this.buckets.set(key, bucket);
      this.evictOldest();
    }

    bucket.requests += 1;
    bucket.durationSumMs += Math.max(0, Math.round(sample.durationMs));
    bucket.latency[latencyIndex(sample.durationMs)]! += 1;
    if (sample.status >= 500) bucket.errors5xx += 1;
    else if (sample.status >= 400) bucket.errors4xx += 1;
    if (sample.errorCode) bump(bucket.byError, sample.errorCode);
    if (sample.route) bump(bucket.byRoute, sample.route);
  }

  /** 진행 중인 분을 제외한 버킷들. 오래된 순. */
  closed(nowMs: number): OpsBucket[] {
    const current = bucketKeyOf(nowMs);
    return [...this.buckets.values()]
      .filter((bucket) => bucket.bucketAt !== current)
      .sort((a, b) => a.bucketAt.localeCompare(b.bucketAt));
  }

  /** 진행 중인 분까지 포함한 전부. 종료 직전에만 쓴다 — 마지막 몇 초를 버리지 않기 위해서다. */
  all(): OpsBucket[] {
    return [...this.buckets.values()].sort((a, b) => a.bucketAt.localeCompare(b.bucketAt));
  }

  /** 저장에 성공한 버킷을 버린다. 실패하면 부르지 않아 다음 주기에 다시 시도한다. */
  drop(bucketAts: readonly string[]): void {
    for (const bucketAt of bucketAts) this.buckets.delete(bucketAt);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOldest(): void {
    while (this.buckets.size > this.maxBuckets) {
      const oldest = [...this.buckets.keys()].sort()[0];
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}

/**
 * 히스토그램에서 분위수를 읽는다. 반환값은 **버킷 상한**이다.
 *
 * 정확한 값이 아니라 "이 값 이하"라는 뜻이다 — 히스토그램의 대가이며, 운영 판단
 * (느려졌나?)에는 충분하다. 마지막 칸을 넘으면 null을 준다(상한을 모른다).
 */
export function percentileFromHistogram(latency: readonly number[], quantile: number): number | null {
  const total = latency.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const target = total * quantile;
  let seen = 0;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    seen += latency[i] ?? 0;
    if (seen >= target) return LATENCY_BUCKETS_MS[i]!;
  }
  return null; // 마지막 칸(30초 초과)에 걸렸다 — 상한을 말할 수 없다.
}

/** 이 프로세스를 식별한다. 태스크마다 다른 행을 쓰기 위한 값이라 무작위면 충분하다. */
export const TASK_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
