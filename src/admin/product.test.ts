import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOW_DAYS_DEFAULT,
  WINDOW_DAYS_MAX,
  parseWindowDays,
  rate,
  toCohorts,
  toDropoff,
  toFunnel,
  type FunnelRow,
} from "./product.js";

function funnelRow(overrides: Partial<FunnelRow> = {}): FunnelRow {
  return {
    active_installations: 100,
    jobs_started: 160,
    installations_started: 80,
    jobs_completed: 140,
    installations_completed: 70,
    jobs_failed: 20,
    jobs_selected: 84,
    installations_selected: 42,
    jobs_exported: 40,
    installations_exported: 20,
    ...overrides,
  };
}

test("기간은 1~90일 정수만 받는다", () => {
  const fallback = parseWindowDays(undefined);
  assert.equal(fallback.ok && fallback.days, WINDOW_DAYS_DEFAULT);
  assert.equal(parseWindowDays("0").ok, false);
  assert.equal(parseWindowDays("7.5").ok, false);
  assert.equal(parseWindowDays(String(WINDOW_DAYS_MAX + 1)).ok, false);
  const ok = parseWindowDays("30");
  assert.equal(ok.ok && ok.days, 30);
});

test("분모가 0이면 0%가 아니라 null이다", () => {
  // "아무도 없었다"와 "전부 이탈했다"를 같은 값으로 보여 주면 판단이 뒤집힌다.
  assert.equal(rate(0, 0), null);
  assert.equal(rate(0, 10), 0);
  assert.equal(rate(1, 3), 33.3);
});

test("퍼널은 직전 대비와 투입 대비를 함께 낸다", () => {
  const stages = toFunnel(funnelRow());
  assert.deepEqual(stages.map((s) => s.key), ["active", "started", "completed", "selected", "exported"]);
  // 첫 단계는 비교 대상이 없다
  assert.equal(stages[0].fromPrevious, null);
  assert.equal(stages[0].jobs, null);
  // 러프 투입 80명 → 분석 성공 70명
  assert.equal(stages[2].fromPrevious, 87.5);
  assert.equal(stages[2].fromStarted, 87.5);
  // 선택 42명 / 성공 70명, 투입 80명 대비 52.5%
  assert.equal(stages[3].fromPrevious, 60);
  assert.equal(stages[3].fromStarted, 52.5);
  assert.equal(stages[4].fromStarted, 25);
});

test("활동이 없으면 비율이 전부 null이다", () => {
  const stages = toFunnel(funnelRow({
    active_installations: 0, jobs_started: 0, installations_started: 0,
    jobs_completed: 0, installations_completed: 0, jobs_selected: 0,
    installations_selected: 0, jobs_exported: 0, installations_exported: 0,
  }));
  assert.equal(stages[2].fromPrevious, null);
  assert.equal(stages[3].fromStarted, null);
});

test("코호트는 비중을 내고 문제 그룹을 표시한다", () => {
  const items = toCohorts({
    installed_only: 10, failed_only: 5, completed_no_selection: 25,
    selected_no_export: 10, exported: 50, total: 100,
  });
  assert.equal(items.length, 5);
  const problem = items.find((i) => i.key === "completedNoSelection");
  assert.equal(problem?.share, 25);
  assert.equal(problem?.highlight, true);
  assert.equal(items.find((i) => i.key === "exported")?.share, 50);
});

test("이탈 신호는 선택 여부로 갈라 비교한다", () => {
  const dropoff = toDropoff(
    [
      // 거리는 낮을수록 좋다 — 고른 쪽이 더 가깝다.
      { selected: true, jobs: 40, zero_people_jobs: 0, shortfall_jobs: 2, avg_best_distance: 0.1823, avg_people: 1.5 },
      { selected: false, jobs: 60, zero_people_jobs: 12, shortfall_jobs: 18, avg_best_distance: 0.4567, avg_people: 0.9 },
    ],
    [
      { selected: true, match_level: "exact", count: 30 },
      { selected: true, match_level: "near", count: 10 },
      { selected: false, match_level: "near", count: 45 },
      { selected: false, match_level: "far", count: 15 },
    ],
    [{ reason: "포즈가 달라요", count: 7 }],
    9,
  );

  assert.equal(dropoff.selected.avgBestDistance, 0.182);
  assert.equal(dropoff.notSelected.avgBestDistance, 0.457);
  // 인물 0명이 이탈 쪽에만 쏠린다 — 화면에서 바로 눈에 띄어야 하는 차이
  assert.equal(dropoff.selected.zeroPeopleRate, 0);
  assert.equal(dropoff.notSelected.zeroPeopleRate, 20);
  assert.equal(dropoff.notSelected.shortfallRate, 30);
  // match_level은 자기 집단 안에서의 비중으로 낸다
  assert.deepEqual(dropoff.selected.matchLevels[0], { level: "exact", count: 30, share: 75 });
  assert.equal(dropoff.notSelected.matchLevels[0].level, "near");
  assert.equal(dropoff.rerunJobs, 9);
  assert.equal(dropoff.feedback[0].count, 7);
});

test("한쪽 집단이 비어 있어도 깨지지 않는다", () => {
  // 기간 내 선택이 하나도 없으면 SQL이 그 행을 내지 않는다.
  const dropoff = toDropoff(
    [{ selected: false, jobs: 3, zero_people_jobs: 1, shortfall_jobs: 0, avg_best_distance: null, avg_people: null }],
    [],
    [],
    0,
  );
  assert.equal(dropoff.selected.jobs, 0);
  assert.equal(dropoff.selected.avgBestDistance, null);
  assert.deepEqual(dropoff.selected.matchLevels, []);
  assert.equal(dropoff.notSelected.zeroPeopleRate, 33.3);
});
