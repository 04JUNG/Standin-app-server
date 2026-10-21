import assert from "node:assert/strict";
import test from "node:test";
import { toOverviewKpis, type OverviewExtraRow } from "./overview.js";
import type { FunnelRow } from "./product.js";

function funnel(overrides: Partial<FunnelRow> = {}): FunnelRow {
  return {
    active_installations: 9,
    jobs_started: 40,
    installations_started: 7,
    jobs_completed: 36,
    installations_completed: 7,
    jobs_failed: 4,
    jobs_selected: 18,
    installations_selected: 5,
    jobs_exported: 9,
    installations_exported: 4,
    ...overrides,
  };
}

function extra(overrides: Partial<OverviewExtraRow> = {}): OverviewExtraRow {
  return {
    active_period: 12,
    active_today: 3,
    total_installations: 25,
    jobs_started: 60,
    jobs_completed: 50,
    jobs_failed: 6,
    downloads: 14,
    feedback_count: 10,
    irrelevant_count: 3,
    ...overrides,
  };
}

test("핵심 숫자를 그대로 옮긴다", () => {
  const kpis = toOverviewKpis(funnel(), extra());
  // 설치·분석 수는 동의와 상관없는 전체(extra)에서, 선택·내보내기는 동의 범위(funnel)에서 온다.
  assert.equal(kpis.activeInstallations, 12);
  assert.equal(kpis.activeToday, 3);
  assert.equal(kpis.totalInstallations, 25);
  assert.equal(kpis.jobsStarted, 60);
  assert.equal(kpis.jobsSelected, 18);
  assert.equal(kpis.downloads, 14);
});

test("선택률은 완료 대비다", () => {
  assert.equal(toOverviewKpis(funnel({ jobs_completed: 36, jobs_selected: 18 }), extra()).selectionRate, 50);
});

test("실패율은 시작 대비다", () => {
  assert.equal(toOverviewKpis(funnel(), extra({ jobs_started: 40, jobs_failed: 4 })).failureRate, 10);
});

test("내보내기 전환은 고른 Job 대비다", () => {
  // 다운로드 이벤트 수가 아니라 내보낸 Job 수로 센다. 같은 Job을 두 번 받아도 한 번이다.
  assert.equal(toOverviewKpis(funnel({ jobs_selected: 18, jobs_exported: 9 }), extra()).exportRate, 50);
});

test("관련 없음 비율은 피드백 대비다", () => {
  assert.equal(toOverviewKpis(funnel(), extra({ feedback_count: 10, irrelevant_count: 3 })).irrelevantRate, 30);
});

test("분모가 0이면 null이다", () => {
  // 0%로 적으면 "아직 신호가 없다"와 "나쁘다"가 같아 보인다.
  const kpis = toOverviewKpis(
    funnel({ jobs_started: 0, jobs_completed: 0, jobs_failed: 0, jobs_selected: 0, jobs_exported: 0 }),
    extra({ feedback_count: 0, irrelevant_count: 0, jobs_started: 0, jobs_failed: 0 }),
  );
  assert.equal(kpis.selectionRate, null);
  assert.equal(kpis.failureRate, null);
  assert.equal(kpis.exportRate, null);
  assert.equal(kpis.irrelevantRate, null);
});
