// 분 롤업 수집기 검증(계획 3단계).
//
// 여기서 지키려는 성질 둘.
//   1. 진행 중인 분은 저장하지 않는다 — 저장하면 같은 기본키를 두 번 쓰게 되고,
//      두 번째 쓰기가 첫 번째를 덮어 그 분의 앞부분 요청이 사라진다.
//   2. 라우트·에러코드가 폭발해도 메모리와 DB 행이 따라 커지지 않는다.
import assert from "node:assert/strict";
import test from "node:test";
import { LATENCY_BUCKETS_MS, MetricsCollector, bucketKeyOf, percentileFromHistogram } from "./metrics.js";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 7, 18, 12, 0, 0); // 분 경계

test("같은 분의 요청은 한 버킷에 모인다", () => {
  const collector = new MetricsCollector();
  collector.record(T0, { status: 200, durationMs: 30 });
  collector.record(T0 + 5_000, { status: 200, durationMs: 40 });
  collector.record(T0 + 59_999, { status: 500, durationMs: 900, errorCode: "HTTP_500" });

  const [bucket] = collector.closed(T0 + MINUTE);
  assert.ok(bucket);
  assert.equal(bucket.bucketAt, new Date(T0).toISOString());
  assert.equal(bucket.requests, 3);
  assert.equal(bucket.errors5xx, 1);
  assert.equal(bucket.durationSumMs, 970);
  assert.deepEqual(bucket.byError, { HTTP_500: 1 });
});

test("진행 중인 분은 내보내지 않는다", () => {
  const collector = new MetricsCollector();
  collector.record(T0, { status: 200, durationMs: 10 });
  collector.record(T0 + MINUTE, { status: 200, durationMs: 10 });

  const closed = collector.closed(T0 + MINUTE + 1_000);
  assert.equal(closed.length, 1, "지금 분은 아직 끝나지 않았다");
  assert.equal(closed[0]?.bucketAt, new Date(T0).toISOString());
});

test("저장에 성공한 버킷만 버린다", () => {
  const collector = new MetricsCollector();
  collector.record(T0, { status: 200, durationMs: 10 });
  collector.record(T0 + MINUTE, { status: 200, durationMs: 10 });
  assert.equal(collector.size, 2);

  collector.drop([new Date(T0).toISOString()]);
  assert.equal(collector.size, 1, "실패한 버킷은 다음 주기에 다시 시도한다");
});

test("4xx와 5xx를 나눠 센다", () => {
  const collector = new MetricsCollector();
  for (const status of [200, 401, 404, 429, 500, 503]) {
    collector.record(T0, { status, durationMs: 5 });
  }
  const [bucket] = collector.closed(T0 + MINUTE);
  assert.equal(bucket?.errors4xx, 3);
  assert.equal(bucket?.errors5xx, 2);
});

test("라우트가 폭발해도 키 수가 무한히 늘지 않는다", () => {
  const collector = new MetricsCollector();
  for (let i = 0; i < 500; i += 1) {
    collector.record(T0, { status: 200, durationMs: 5, route: `/junk/${i}` });
  }
  const [bucket] = collector.closed(T0 + MINUTE);
  const keys = Object.keys(bucket?.byRoute ?? {});
  assert.ok(keys.length <= 51, `키가 ${keys.length}개로 늘었다`);
  assert.ok(keys.includes("_other"), "상한을 넘은 값은 한 칸으로 접힌다");
  assert.equal(bucket?.requests, 500, "요청 수 자체는 그대로 센다");
});

test("버킷 수 상한을 넘으면 오래된 것부터 버린다", () => {
  const collector = new MetricsCollector(3);
  for (let i = 0; i < 10; i += 1) {
    collector.record(T0 + i * MINUTE, { status: 200, durationMs: 5 });
  }
  assert.equal(collector.size, 3, "저장이 계속 실패해도 메모리는 상한을 지킨다");
});

test("히스토그램에서 읽은 분위수는 버킷 상한이다", () => {
  // 100ms 칸에 90건, 5000ms 칸에 10건.
  const latency = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  latency[1] = 90; // <=100ms
  latency[6] = 10; // <=5000ms

  assert.equal(percentileFromHistogram(latency, 0.5), 100);
  assert.equal(percentileFromHistogram(latency, 0.95), 5000, "꼬리가 상위 칸에 있다");
  assert.equal(percentileFromHistogram(latency.map(() => 0), 0.5), null, "표본이 없으면 값도 없다");
});

test("마지막 칸을 넘으면 상한을 말하지 않는다", () => {
  const latency = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  latency[LATENCY_BUCKETS_MS.length] = 5; // 30초 초과
  assert.equal(percentileFromHistogram(latency, 0.95), null, "숫자를 지어내지 않는다");
});

test("버킷 키는 분 경계로 잘린다", () => {
  assert.equal(bucketKeyOf(T0 + 12_345), new Date(T0).toISOString());
});
