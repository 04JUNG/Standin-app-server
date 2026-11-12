// 검색 결과 활용·사용량 지표의 순수 함수. SQL은 `qualityStore.ts`에 있다.
//
// 동의 범위가 반영된 quality_review 뷰를 날짜별로 집계한다. 철회 후에도 캐시 집계가
// 남지 않도록 원본에서 계산하며, **오늘은 제외**한다(`day < current_date`).

/** `daily_analytics_aggregates` 한 줄. snake_case는 여기서 끝난다. */
export interface DailyAggregateRow {
  day: string;
  jobs_started: number;
  jobs_completed: number;
  jobs_failed: number;
  confirmed_selections: number;
  top1_selections: number;
  mean_reciprocal_rank: number | null;
  exports_completed: number;
  feedback_json: string;
  /** 신규 SQL이 반환하는 작업/인물 표본. 구형 호출은 기존 컬럼으로 복구한다. */
  selected_jobs?: number;
  selected_completed_jobs?: number;
  selection_samples?: number;
  valid_rank_samples?: number;
  exported_selected_jobs?: number;
}

export interface FeedbackShare {
  reason: string;
  count: number;
  /** 피드백을 남긴 건수 대비 비율(%). 분모가 0이면 null. */
  share: number | null;
}

export interface AccuracyMetrics {
  /** 분석이 끝난 Job 중 포즈 사용 확정 기록이 있는 작업 비율(%). 검색 정확도는 아니다. */
  selectionRate: number | null;
  /** 유효 순위가 기록된 인물 선택 중 Top-1 비율(%). */
  top1Rate: number | null;
  /** 선택 순위의 역수 평균. 1에 가까울수록 위쪽에서 고른다. */
  meanReciprocalRank: number | null;
  /** 사용 확정 작업 중 서버 내보내기 완료 기록이 있는 작업 비율(%). 실제 저장과 다르다. */
  exportRate: number | null;
  jobsCompleted: number;
  selections: number;
  feedback: FeedbackShare[];
  /** 피드백을 남긴 Job 비율(%). 지표를 읽을 때 표본 크기를 함께 보라고 둔다. */
  feedbackRate: number | null;
  /** 날짜별 선택률 추이. 화면이 막대로 그린다. */
  trend: Array<{ day: string; selectionRate: number | null; jobsCompleted: number }>;
  /** 집계에 들어간 날 수. 0이면 아직 하루도 마감되지 않았다는 뜻이다. */
  days: number;
  metricKind: "result_usage";
  selectionBasis: "completed_jobs";
  rankSamples: number;
  rankSelectionSamples: number;
  rankCoverageRate: number | null;
  exportBasis: "server_exported_selected_jobs";
}

export interface UsageMetrics {
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
  /** 시작한 Job 중 실패 비율(%). */
  failureRate: number | null;
  /** 기록이 있는 마감 날짜를 분모로 한 평균 분석 건수. 선택 기간 평균과 구분한다. */
  jobsPerDay: number | null;
  /** 활성 설치 하나당 분석 건수. 많이 쓰는 소수가 끌고 가는지 본다. */
  jobsPerActiveInstallation: number | null;
  activeInstallations: number;
  trend: Array<{ day: string; jobsStarted: number; jobsFailed: number }>;
  days: number;
  jobsPerDayBasis: "recorded_days";
  recordedDays: number;
  selectedCalendarDays: number | null;
  jobsPerSelectedCalendarDay: number | null;
  activeInstallationScope: "rolling_window";
}

function rate(numerator: number, denominator: number): number | null {
  // 분모가 0이면 0%가 아니라 "아직 모른다"다. 0으로 적으면 신호가 없는 것과
  // 나쁜 것이 같아 보인다.
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function parseFeedback(raw: string): Record<string, number> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [reason, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) out[reason] = count;
    }
    return out;
  } catch {
    return {};
  }
}

export function toAccuracy(rows: DailyAggregateRow[]): AccuracyMetrics {
  let jobsCompleted = 0;
  let selections = 0;
  let top1 = 0;
  let exports = 0;
  let reciprocalSum = 0;
  let rankSamples = 0;
  let rankSelectionSamples = 0;
  let selectedCompleted = 0;
  const feedbackTotals: Record<string, number> = {};

  for (const row of rows) {
    jobsCompleted += row.jobs_completed;
    selections += row.selected_jobs ?? row.confirmed_selections;
    selectedCompleted += row.selected_completed_jobs ?? row.selected_jobs ?? row.confirmed_selections;
    rankSelectionSamples += row.selection_samples ?? row.confirmed_selections;
    top1 += row.top1_selections;
    exports += row.exported_selected_jobs ?? row.exports_completed;
    // MRR은 날짜별 평균을 다시 평균 내면 안 된다(날마다 선택 수가 다르다).
    // 저장된 평균에 그날의 선택 수를 곱해 합으로 되돌린 뒤 전체로 나눈다.
    if (row.mean_reciprocal_rank !== null && Number.isFinite(Number(row.mean_reciprocal_rank))) {
      const validSamples = row.valid_rank_samples ?? row.selection_samples ?? row.confirmed_selections;
      rankSamples += validSamples;
      reciprocalSum += Number(row.mean_reciprocal_rank) * validSamples;
    }
    for (const [reason, count] of Object.entries(parseFeedback(row.feedback_json))) {
      feedbackTotals[reason] = (feedbackTotals[reason] ?? 0) + count;
    }
  }

  const feedbackCount = Object.values(feedbackTotals).reduce((sum, value) => sum + value, 0);
  const feedback = Object.entries(feedbackTotals)
    .map(([reason, count]) => ({ reason, count, share: rate(count, feedbackCount) }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    selectionRate: rate(selectedCompleted, jobsCompleted),
    top1Rate: rate(top1, rankSamples),
    meanReciprocalRank: rankSamples > 0 ? Math.round((reciprocalSum / rankSamples) * 1000) / 1000 : null,
    exportRate: rate(exports, selections),
    jobsCompleted,
    selections,
    feedback,
    feedbackRate: rate(feedbackCount, jobsCompleted),
    trend: rows.map((row) => ({
      day: row.day,
      selectionRate: rate(row.selected_completed_jobs ?? row.selected_jobs ?? row.confirmed_selections, row.jobs_completed),
      jobsCompleted: row.jobs_completed,
    })),
    days: rows.length,
    metricKind: "result_usage",
    selectionBasis: "completed_jobs",
    rankSamples,
    rankSelectionSamples,
    rankCoverageRate: rate(rankSamples, rankSelectionSamples),
    exportBasis: "server_exported_selected_jobs",
  };
}

export function toUsage(rows: DailyAggregateRow[], activeInstallations: number, selectedCalendarDays?: number): UsageMetrics {
  let started = 0;
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    started += row.jobs_started;
    completed += row.jobs_completed;
    failed += row.jobs_failed;
  }
  return {
    jobsStarted: started,
    jobsCompleted: completed,
    jobsFailed: failed,
    failureRate: rate(failed, started),
    jobsPerDay: rows.length > 0 ? Math.round((started / rows.length) * 10) / 10 : null,
    jobsPerActiveInstallation:
      activeInstallations > 0 ? Math.round((started / activeInstallations) * 10) / 10 : null,
    activeInstallations,
    trend: rows.map((row) => ({
      day: row.day,
      jobsStarted: row.jobs_started,
      jobsFailed: row.jobs_failed,
    })),
    days: rows.length,
    jobsPerDayBasis: "recorded_days",
    recordedDays: rows.length,
    selectedCalendarDays: selectedCalendarDays ?? null,
    jobsPerSelectedCalendarDay: selectedCalendarDays && selectedCalendarDays > 0
      ? Math.round((started / selectedCalendarDays) * 10) / 10 : null,
    activeInstallationScope: "rolling_window",
  };
}
