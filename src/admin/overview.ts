// 대시보드 첫 화면의 KPI 띠. 순수 변환만 여기 두고 SQL은 `overviewStore.ts`에 둔다.
//
// 정확도 블록(`quality.ts`)과 다른 점: 저쪽은 하루가 끝난 일별 집계라 **오늘이 없고**,
// 여기는 원본을 바로 세서 **오늘까지 들어간다**. 첫 화면은 "지금 어떤가"를 보여야 하므로
// 원본을 쓴다. 두 선택률이 조금 다르면 그 차이는 대개 오늘 하루치다.

import type { FunnelRow } from "./product.js";

/** KPI 띠가 퍼널 말고 따로 세는 값들. */
export interface OverviewExtraRow {
  active_today: number;
  total_installations: number;
  downloads: number;
  feedback_count: number;
  irrelevant_count: number;
}

export interface OverviewKpis {
  /** 기간 안에 한 번이라도 접속한 설치. */
  activeInstallations: number;
  /** 최근 24시간 안에 접속한 설치. */
  activeToday: number;
  /** 철회되지 않은 전체 설치. */
  totalInstallations: number;
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
  /** 시작 대비 실패(%). */
  failureRate: number | null;
  /** 완료된 Job 중 후보를 고른 Job(%). 오늘 포함. */
  selectionRate: number | null;
  jobsSelected: number;
  /** 완료된 내보내기 이벤트 수. 같은 Job을 여러 번 받으면 여러 번 센다. */
  downloads: number;
  /** 내보내기까지 간 Job 수. */
  jobsExported: number;
  /** 고른 Job 중 내보낸 Job(%). */
  exportRate: number | null;
  feedbackCount: number;
  /** 피드백 중 "후보가 관련 없다"(%). 검색 품질의 가장 직접적인 불만이다. */
  irrelevantRate: number | null;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function toOverviewKpis(funnel: FunnelRow, extra: OverviewExtraRow): OverviewKpis {
  return {
    activeInstallations: funnel.active_installations,
    activeToday: extra.active_today,
    totalInstallations: extra.total_installations,
    jobsStarted: funnel.jobs_started,
    jobsCompleted: funnel.jobs_completed,
    jobsFailed: funnel.jobs_failed,
    failureRate: rate(funnel.jobs_failed, funnel.jobs_started),
    selectionRate: rate(funnel.jobs_selected, funnel.jobs_completed),
    jobsSelected: funnel.jobs_selected,
    downloads: extra.downloads,
    jobsExported: funnel.jobs_exported,
    exportRate: rate(funnel.jobs_exported, funnel.jobs_selected),
    feedbackCount: extra.feedback_count,
    irrelevantRate: rate(extra.irrelevant_count, extra.feedback_count),
  };
}
