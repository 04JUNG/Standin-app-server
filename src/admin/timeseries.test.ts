import assert from "node:assert/strict";
import test from "node:test";
import { bucketStart, fillBuckets, parseTimeseriesQuery, type TimeseriesRow } from "./timeseries.js";

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("범위와 단위가 맞으면 받는다", () => {
  const parsed = parseTimeseriesQuery({ range: "7d", bucket: "6h" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.query.bucketSeconds, 6 * 3600);
    assert.equal(parsed.query.rangeSeconds, 7 * 24 * 3600);
  }
});

test("단위를 안 주면 그 범위의 첫 단위를 쓴다", () => {
  const parsed = parseTimeseriesQuery({ range: "30d" });
  assert.equal(parsed.ok && parsed.query.bucket, "6h");
  const fallback = parseTimeseriesQuery({});
  assert.equal(fallback.ok && fallback.query.range, "24h");
});

test("범위에 안 맞는 단위는 바꾸지 않고 거절한다", () => {
  // 90일을 1시간 단위로 그리면 2,160개 점이라 읽을 수 없다.
  assert.equal(parseTimeseriesQuery({ range: "90d", bucket: "1h" }).ok, false);
  assert.equal(parseTimeseriesQuery({ range: "1y" }).ok, false);
});

test("구간은 KST 자정에 맞춘다", () => {
  // KST 10.09 02:30 = UTC 10.08 17:30. 3시간 구간은 KST 00:00(UTC 10.08 15:00)에서 시작한다.
  const start = bucketStart(epoch("2026-10-08T17:30:00Z"), 3 * 3600);
  assert.equal(new Date(start * 1000).toISOString(), "2026-10-08T15:00:00.000Z");
  // 하루 구간도 KST 자정(UTC 15:00)에서 시작한다.
  const day = bucketStart(epoch("2026-10-09T03:00:00Z"), 24 * 3600);
  assert.equal(new Date(day * 1000).toISOString(), "2026-10-08T15:00:00.000Z");
});

function row(bucket: string, overrides: Partial<TimeseriesRow> = {}): TimeseriesRow {
  return {
    bucket,
    active_installations: 3,
    jobs_started: 5,
    jobs_completed: 4,
    jobs_failed: 1,
    downloads: 2,
    ...overrides,
  };
}

test("빈 구간을 0으로 채워 시간축이 끊기지 않는다", () => {
  // 활동이 없던 밤이 빠지면 선이 그 사이를 그대로 이어 "그때도 사람이 있었다"처럼 보인다.
  const now = epoch("2026-10-09T05:30:00Z");
  const points = fillBuckets(
    [row("2026-10-09T02:00:00Z"), row("2026-10-09T05:00:00Z", { active_installations: 7 })],
    now,
    { rangeSeconds: 6 * 3600, bucketSeconds: 3600 },
  );
  assert.equal(points.length, 6);
  assert.deepEqual(points.map((p) => p.activeInstallations), [0, 0, 3, 0, 0, 7]);
  assert.equal(points[0].start, "2026-10-09T00:00:00.000Z");
  assert.equal(points[5].end, "2026-10-09T06:00:00.000Z");
});

test("지금이 속한 구간까지 들어간다", () => {
  const now = epoch("2026-10-09T05:59:00Z");
  const points = fillBuckets([], now, { rangeSeconds: 3 * 3600, bucketSeconds: 3600 });
  assert.equal(points[points.length - 1].start, "2026-10-09T05:00:00.000Z");
});

test("SQL이 null을 줘도 0으로 읽는다", () => {
  const now = epoch("2026-10-09T01:30:00Z");
  const points = fillBuckets(
    [row("2026-10-09T01:00:00Z", { downloads: null, jobs_failed: null })],
    now,
    { rangeSeconds: 3600, bucketSeconds: 3600 },
  );
  assert.equal(points[0].downloads, 0);
  assert.equal(points[0].jobsFailed, 0);
  assert.equal(points[0].jobsStarted, 5);
});

test("범위 밖이나 잘못된 시각의 행은 무시한다", () => {
  const now = epoch("2026-10-09T01:30:00Z");
  const points = fillBuckets(
    [row("not-a-date"), row("2026-10-01T00:00:00Z")],
    now,
    { rangeSeconds: 3600, bucketSeconds: 3600 },
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].activeInstallations, 0);
});
