import assert from "node:assert/strict";
import test from "node:test";
import { toAccuracy, toUsage, type DailyAggregateRow } from "./quality.js";

function day(overrides: Partial<DailyAggregateRow> = {}): DailyAggregateRow {
  return {
    day: "2026-10-01",
    jobs_started: 10,
    jobs_completed: 8,
    jobs_failed: 2,
    confirmed_selections: 4,
    top1_selections: 3,
    mean_reciprocal_rank: 0.8,
    exports_completed: 2,
    feedback_json: "{}",
    ...overrides,
  };
}

test("선택률은 완료된 Job 대비다", () => {
  const accuracy = toAccuracy([day({ jobs_completed: 8, confirmed_selections: 4 })]);
  assert.equal(accuracy.selectionRate, 50);
  assert.equal(accuracy.jobsCompleted, 8);
  assert.equal(accuracy.selections, 4);
});

test("Top-1 비율은 고른 것 대비다", () => {
  // 완료 건수가 아니라 선택 건수가 분모다 — 고르지 않은 Job은 순위를 말할 수 없다.
  const accuracy = toAccuracy([day({ confirmed_selections: 4, top1_selections: 3 })]);
  assert.equal(accuracy.top1Rate, 75);
});

test("분모가 0이면 0%가 아니라 null이다", () => {
  // 0%로 적으면 "신호가 없다"와 "나쁘다"가 같아 보인다.
  const accuracy = toAccuracy([day({ jobs_completed: 0, confirmed_selections: 0, top1_selections: 0 })]);
  assert.equal(accuracy.selectionRate, null);
  assert.equal(accuracy.top1Rate, null);
  assert.equal(accuracy.meanReciprocalRank, null);
});

test("평균 역순위는 날짜별 평균을 다시 평균 내지 않는다", () => {
  // 선택이 1건인 날과 99건인 날을 같은 무게로 더하면 숫자가 왜곡된다.
  const rows = [
    day({ day: "2026-10-01", confirmed_selections: 1, mean_reciprocal_rank: 1 }),
    day({ day: "2026-10-02", confirmed_selections: 99, mean_reciprocal_rank: 0.5 }),
  ];
  const accuracy = toAccuracy(rows);
  const expected = (1 * 1 + 99 * 0.5) / 100;
  assert.equal(accuracy.meanReciprocalRank, Math.round(expected * 1000) / 1000);
});

test("역순위가 비어 있는 날은 합계에서 빠진다", () => {
  const rows = [
    day({ confirmed_selections: 2, mean_reciprocal_rank: null }),
    day({ day: "2026-10-02", confirmed_selections: 2, mean_reciprocal_rank: 1 }),
  ];
  // 선택 4건 중 2건만 순위를 안다. 아는 쪽만 더해 전체로 나눈다.
  assert.equal(toAccuracy(rows).meanReciprocalRank, 0.5);
});

test("피드백은 사유별로 합치고 비중을 낸다", () => {
  const rows = [
    day({ feedback_json: JSON.stringify({ good: 3, candidates_irrelevant: 1 }) }),
    day({ day: "2026-10-02", feedback_json: JSON.stringify({ candidates_irrelevant: 2, other: 2 }) }),
  ];
  const accuracy = toAccuracy(rows);
  assert.deepEqual(accuracy.feedback, [
    { reason: "candidates_irrelevant", count: 3, share: 37.5 },
    { reason: "good", count: 3, share: 37.5 },
    { reason: "other", count: 2, share: 25 },
  ]);
});

test("깨진 피드백 JSON이 지표 전체를 막지 않는다", () => {
  const accuracy = toAccuracy([day({ feedback_json: "{" }), day({ day: "2026-10-02" })]);
  assert.deepEqual(accuracy.feedback, []);
  assert.equal(accuracy.selectionRate, 50);
});

test("0건 이하의 사유는 버린다", () => {
  const accuracy = toAccuracy([day({ feedback_json: JSON.stringify({ good: 0, other: 1 }) })]);
  assert.deepEqual(accuracy.feedback.map((row) => row.reason), ["other"]);
});

test("피드백 비율은 완료 Job 대비라 표본 크기가 드러난다", () => {
  const accuracy = toAccuracy([day({ jobs_completed: 8, feedback_json: JSON.stringify({ good: 2 }) })]);
  assert.equal(accuracy.feedbackRate, 25);
});

test("추이는 날짜 순서를 그대로 둔다", () => {
  const rows = [day({ day: "2026-10-01" }), day({ day: "2026-10-02", confirmed_selections: 8 })];
  assert.deepEqual(toAccuracy(rows).trend.map((point) => point.day), ["2026-10-01", "2026-10-02"]);
  assert.equal(toAccuracy(rows).trend[1].selectionRate, 100);
});

test("마감된 날이 없으면 days가 0이다", () => {
  // 화면이 "아직 집계가 없다"와 "0%"를 구분할 수 있어야 한다.
  const accuracy = toAccuracy([]);
  assert.equal(accuracy.days, 0);
  assert.equal(accuracy.selectionRate, null);
});

test("사용률은 하루 평균과 설치당 건수를 낸다", () => {
  const rows = [day({ jobs_started: 10 }), day({ day: "2026-10-02", jobs_started: 30 })];
  const usage = toUsage(rows, 8);
  assert.equal(usage.jobsStarted, 40);
  assert.equal(usage.jobsPerDay, 20);
  assert.equal(usage.jobsPerActiveInstallation, 5);
  assert.equal(usage.days, 2);
});

test("활성 설치가 0이면 설치당 건수는 null이다", () => {
  assert.equal(toUsage([day()], 0).jobsPerActiveInstallation, null);
});

test("실패율은 시작한 Job 대비다", () => {
  const usage = toUsage([day({ jobs_started: 10, jobs_failed: 2 })], 1);
  assert.equal(usage.failureRate, 20);
});
