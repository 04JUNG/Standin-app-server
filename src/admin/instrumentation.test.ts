import assert from "node:assert/strict";
import test from "node:test";
import { toColumnHealth, toDistanceBuckets, toStageGaps } from "./instrumentation.js";

test("전부 비어 있는 컬럼을 표시한다", () => {
  const health = toColumnHealth([
    { label: "analysis_candidates.rerank_score", rows: 120, nulls: 120 },
    { label: "analysis_candidates.distance", rows: 120, nulls: 0 },
    { label: "jobs.input_width", rows: 40, nulls: 4 },
  ]);
  // 오늘 실제로 겪은 경우 — rerank는 쓰이지 않는 경로라 항상 비어 있다.
  assert.equal(health[0].empty, true);
  assert.equal(health[0].nullRate, 100);
  assert.equal(health[1].empty, false);
  assert.equal(health[2].nullRate, 10);
  assert.equal(health[2].empty, false);
});

test("행이 없으면 비율은 null이고 비어 있다고 하지 않는다", () => {
  const health = toColumnHealth([{ label: "export_events.format", rows: 0, nulls: 0 }]);
  assert.equal(health[0].nullRate, null);
  // 기록이 0건인 것과 "컬럼이 안 채워진다"는 다르다.
  assert.equal(health[0].empty, false);
});

test("단계별 서버·클라 차이를 낸다", () => {
  const gaps = toStageGaps(
    { jobs: 128, failed: 31, selections: 27, exports: 22 },
    { input_confirmed: 152, analysis_failed: 51, selection_confirmed: 29, export_completed: 21 },
  );
  assert.equal(gaps.length, 4);
  // 클라가 더 많다 = 서버에 닿지 못한 시도가 있었다
  assert.equal(gaps[0].gap, 24);
  assert.equal(gaps[1].gap, 20);
  // 클라가 더 적다 = 이벤트 유실
  assert.equal(gaps[3].gap, -1);
});

test("없는 이벤트는 0으로 센다", () => {
  const gaps = toStageGaps({ jobs: 5 }, {});
  assert.equal(gaps[0].server, 5);
  assert.equal(gaps[0].client, 0);
  assert.equal(gaps[0].gap, -5);
});

test("거리 구간은 정해진 순서로 나오고 빈 구간은 뺀다", () => {
  const buckets = toDistanceBuckets([
    { bucket: ">0.45", jobs: 30, selected: 3 },
    { bucket: "≤0.15", jobs: 10, selected: 9 },
    { bucket: "없음", jobs: 5, selected: 0 },
  ]);
  assert.deepEqual(buckets.map((b) => b.bucket), ["≤0.15", ">0.45", "없음"]);
  assert.equal(buckets[0].selectionRate, 90);
  assert.equal(buckets[1].selectionRate, 10);
  assert.equal(buckets[2].selectionRate, 0);
});
