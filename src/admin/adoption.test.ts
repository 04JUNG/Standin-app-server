import assert from "node:assert/strict";
import test from "node:test";
import { ATTEMPT_CAP, toAttemptCurve, toFirstRunFunnel, toRetry } from "./adoption.js";

test("첫 실행 도달률과 시간 분포를 낸다", () => {
  const funnel = toFirstRunFunnel({
    installs: 29, reached: 18,
    within_10m: 9, within_1h: 4, within_1d: 3, within_3d: 1, later: 1,
    idle_fresh: 2, idle_week: 3, idle_stale: 6,
  });
  assert.equal(funnel.reachRate, 62.1);
  // 분포의 분모는 전체가 아니라 **도달한 설치**다. 안 돌린 사람을 섞으면 비율이 흐려진다.
  assert.equal(funnel.timeToFirst[0].share, 50);
  assert.equal(funnel.timeToFirst.reduce((sum, item) => sum + item.count, 0), 18);
  assert.equal(funnel.idle[2].count, 6);
});

test("설치가 없으면 비율은 null이다", () => {
  const funnel = toFirstRunFunnel({
    installs: 0, reached: 0, within_10m: 0, within_1h: 0, within_1d: 0,
    within_3d: 0, later: 0, idle_fresh: 0, idle_week: 0, idle_stale: 0,
  });
  assert.equal(funnel.reachRate, null);
  assert.equal(funnel.timeToFirst[0].share, null);
});

test("시도 곡선은 순번순이고 6회 이상을 묶는다", () => {
  const curve = toAttemptCurve([
    { attempt: 2, jobs: 30, selected: 9 },
    { attempt: 1, jobs: 50, selected: 10 },
    { attempt: ATTEMPT_CAP, jobs: 12, selected: 6 },
  ]);
  assert.deepEqual(curve.map((row) => row.attempt), ["1회차", "2회차", "6회 이상"]);
  assert.equal(curve[0].selectionRate, 20);
  assert.equal(curve[1].selectionRate, 30);
  assert.equal(curve[2].selectionRate, 50);
});

test("처음 고르기까지의 분포는 설치 기준 비중을 낸다", () => {
  const retry = toRetry(
    [{ attempt: 1, jobs: 10, selected: 4 }],
    [
      { attempt_at_first: 1, installations: 4 },
      { attempt_at_first: 3, installations: 1 },
    ],
    7,
    40,
  );
  assert.equal(retry.firstSelection[0].share, 80);
  assert.equal(retry.firstSelection[1].attempt, "3회차");
  assert.equal(retry.rerunRate, 17.5);
});

test("Job이 없으면 재실행 비율은 null이다", () => {
  const retry = toRetry([], [], 0, 0);
  assert.equal(retry.rerunRate, null);
  assert.deepEqual(retry.curve, []);
  assert.deepEqual(retry.firstSelection, []);
});
