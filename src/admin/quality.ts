// 정확도·사용률 지표의 순수 함수. SQL은 `qualityStore.ts`에 있다.
//
// 원본은 `daily_analytics_aggregates`다 — 하루가 끝난 뒤 한 번 계산해 두는 표라, 같은
// 창을 몇 번 열어도 365일치 원본을 다시 훑지 않는다. 대신 **오늘은 들어 있지 않다**
// (`day < current_date`). 화면도 "어제까지"라고 적는다.

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
}

export interface FeedbackShare {
  reason: string;
  count: number;
  /** 피드백을 남긴 건수 대비 비율(%). 분모가 0이면 null. */
  share: number | null;
}

export interface AccuracyMetrics {
  /** 분석이 끝난 Job 중 사용자가 후보를 고른 비율(%). */
  selectionRate: number | null;
  /** 고른 것 중 Top-1이었던 비율(%). 검색이 첫 줄에 맞혔는가. */
  top1Rate: number | null;
  /** 선택 순위의 역수 평균. 1에 가까울수록 위쪽에서 고른다. */
  meanReciprocalRank: number | null;
  /** 고른 뒤 실제로 내보낸 비율(%). 고르고 버린 경우를 가른다. */
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
}

export interface UsageMetrics {
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
  /** 시작한 Job 중 실패 비율(%). */
  failureRate: number | null;
  /** 하루 평균 분석 건수. */
  jobsPerDay: number | null;
  /** 활성 설치 하나당 분석 건수. 많이 쓰는 소수가 끌고 가는지 본다. */
  jobsPerActiveInstallation: number | null;
  activeInstallations: number;
  trend: Array<{ day: string; jobsStarted: number; jobsFailed: number }>;
  days: number;
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
  const feedbackTotals: Record<string, number> = {};

  for (const row of rows) {
    jobsCompleted += row.jobs_completed;
    selections += row.confirmed_selections;
    top1 += row.top1_selections;
    exports += row.exports_completed;
    // MRR은 날짜별 평균을 다시 평균 내면 안 된다(날마다 선택 수가 다르다).
    // 저장된 평균에 그날의 선택 수를 곱해 합으로 되돌린 뒤 전체로 나눈다.
    if (row.mean_reciprocal_rank !== null) {
      reciprocalSum += row.mean_reciprocal_rank * row.confirmed_selections;
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
    selectionRate: rate(selections, jobsCompleted),
    top1Rate: rate(top1, selections),
    meanReciprocalRank: selections > 0 ? Math.round((reciprocalSum / selections) * 1000) / 1000 : null,
    exportRate: rate(exports, selections),
    jobsCompleted,
    selections,
    feedback,
    feedbackRate: rate(feedbackCount, jobsCompleted),
    trend: rows.map((row) => ({
      day: row.day,
      selectionRate: rate(row.confirmed_selections, row.jobs_completed),
      jobsCompleted: row.jobs_completed,
    })),
    days: rows.length,
  };
}

export function toUsage(rows: DailyAggregateRow[], activeInstallations: number): UsageMetrics {
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
  };
}
