// 지표 수집 배선(계획 3단계).
//
// BFF 자기 지표는 요청 미들웨어가 넣고, 추론 서버 지표는 여기서 1분마다 긁어 온다.
// 추론 서버는 DB가 없고 내부 전용이라 스스로 저장할 수 없다 — BFF가 수집자를 겸한다.
import { config } from "../config.js";
import { errorFields, log } from "../log.js";
import { MetricsCollector, TASK_ID, type OpsBucket, type RequestSample } from "./metrics.js";
import { upsertBuckets } from "./store.js";

const collector = new MetricsCollector();

/** 요청 미들웨어가 부른다. 절대 throw하지 않는다 — 지표가 요청을 깨면 안 된다. */
export function recordRequest(sample: RequestSample): void {
  try {
    collector.record(Date.now(), sample);
  } catch {
    // 삼킨다. 여기서 로그를 남기면 폭주할 때 로그가 더 큰 문제가 된다.
  }
}

async function flushOwnBuckets(includeCurrentMinute = false): Promise<void> {
  // 평소에는 닫힌 버킷만 쓴다. 진행 중인 분을 쓰면 그 분을 두 번 쓰게 되고, 두 번째
  // 쓰기가 첫 번째를 덮어 앞부분 요청이 사라진다(같은 기본키라 UPDATE가 된다).
  const pending = includeCurrentMinute ? collector.all() : collector.closed(Date.now());
  if (pending.length === 0) return;
  await upsertBuckets("bff", TASK_ID, pending);
  // 저장에 성공한 뒤에만 버린다. 실패하면 다음 주기에 같은 버킷을 다시 시도한다.
  collector.drop(pending.map((bucket) => bucket.bucketAt));
}

interface UpstreamMetrics {
  taskId?: unknown;
  buckets?: unknown;
}

/** 추론 서버 응답을 방어적으로 읽는다. 배포 순서상 구 버전이 응답하는 창이 반드시 생긴다. */
function parseBuckets(payload: unknown): { taskId: string; buckets: OpsBucket[] } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { taskId, buckets } = payload as UpstreamMetrics;
  if (typeof taskId !== "string" || !Array.isArray(buckets)) return null;

  const parsed: OpsBucket[] = [];
  for (const raw of buckets) {
    if (typeof raw !== "object" || raw === null) continue;
    const bucket = raw as Record<string, unknown>;
    if (typeof bucket.bucketAt !== "string") continue;
    parsed.push({
      bucketAt: bucket.bucketAt,
      requests: Number(bucket.requests ?? 0),
      errors4xx: Number(bucket.errors4xx ?? 0),
      errors5xx: Number(bucket.errors5xx ?? 0),
      durationSumMs: Number(bucket.durationSumMs ?? 0),
      latency: Array.isArray(bucket.latency) ? bucket.latency.map(Number) : [],
      byError: (bucket.byError as Record<string, number>) ?? {},
      byRoute: (bucket.byRoute as Record<string, number>) ?? {},
    });
  }
  return { taskId, buckets: parsed };
}

async function pollInference(): Promise<void> {
  const res = await fetch(`${config.inferenceBaseUrl}/ops/metrics`, {
    signal: AbortSignal.timeout(config.healthTimeoutMs),
  });
  // 구 버전 추론 서버에는 이 라우트가 없다. 404는 장애가 아니라 배포 창이다.
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`inference /ops/metrics ${res.status}`);

  const parsed = parseBuckets(await res.json());
  if (!parsed || parsed.buckets.length === 0) return;
  // 추론 서버는 버킷을 지우지 않고 몇 분치를 들고 있다. upsert라 다시 읽어도 안전하다.
  await upsertBuckets("inference", parsed.taskId, parsed.buckets);
}

async function flushOnce(includeCurrentMinute = false): Promise<void> {
  await flushOwnBuckets(includeCurrentMinute).catch((error) =>
    log.error({ type: "ops_flush", errorCode: "OPS_FLUSH_FAILED", ...errorFields(error) }),
  );
  await pollInference().catch((error) =>
    // 추론 지표를 못 긁는 것은 알림 사안이 아니다 — 추론이 죽었으면 inferenceWatch가 이미 알린다.
    log.warn({ type: "ops_flush", errorCode: "INFERENCE_METRICS_FAILED", ...errorFields(error) }),
  );
}

/** 1분마다 롤업을 저장한다. 반환값은 정지 함수(종료용). */
export function startOpsFlush(): () => void {
  const timer = setInterval(() => void flushOnce(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** 종료 직전 호출. 진행 중인 분까지 저장해 마지막 몇 초를 버리지 않는다. */
export async function flushOpsNow(): Promise<void> {
  await flushOnce(true);
}
