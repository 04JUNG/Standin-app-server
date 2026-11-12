// 제품 지표(GET /v1/admin/product)의 순수 함수들 — 기간 검증, 비율 계산, row→응답 매핑.
//
// 운영 대시보드 위쪽이 "서비스가 지금 살아 있나"를 답한다면 여기는 "제품이 자라고
// 있나"를 답한다. 세 가지를 한 화면에 놓는다.
//
//   ① 퍼널   — 어디서 새는가
//   ② 코호트 — 누가 어디서 멈췄는가
//   ③ 신호   — 멈춘 쪽은 무엇이 달랐는가
//
// 낮은 선택률과 함께 관찰된 조건을 비교한다. 원인 판정에는 사용자 피드백과
// 상세 작업 기록이 추가로 필요하다.

export const WINDOW_DAYS_DEFAULT = 7;
export const WINDOW_DAYS_MAX = 90;

export type ParsedWindow = { ok: true; days: number } | { ok: false; message: string };

/**
 * 기간은 일 단위로만 받는다.
 *
 * 상한이 90일인 이유는 `installations/` 버킷 lifecycle과 같다 — 그보다 오래된 구간은
 * 원본이 이미 만료되어 "이 러프가 왜 안 골렸나"를 되짚을 수 없다. 숫자만 남은 구간을
 * 기본 화면에 올리면 판단이 아니라 추측을 하게 된다.
 */
export function parseWindowDays(raw: string | undefined): ParsedWindow {
  if (raw === undefined) return { ok: true, days: WINDOW_DAYS_DEFAULT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WINDOW_DAYS_MAX) {
    return { ok: false, message: `days는 1 이상 ${WINDOW_DAYS_MAX} 이하의 정수여야 합니다.` };
  }
  return { ok: true, days: parsed };
}

/** 분모가 0이면 0%가 아니라 null이다. "아무도 없었다"와 "전부 이탈했다"는 다르다. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

// ── ① 퍼널 ───────────────────────────────────────────────────

export interface FunnelRow {
  active_installations: number;
  jobs_started: number;
  installations_started: number;
  jobs_completed: number;
  installations_completed: number;
  jobs_failed: number;
  jobs_selected: number;
  installations_selected: number;
  jobs_exported: number;
  installations_exported: number;
}

export interface FunnelStage {
  key: string;
  label: string;
  /** 건수. 첫 단계(설치)는 건수 개념이 없어 null이다. */
  jobs: number | null;
  installations: number;
  /** 직전 단계 대비 전환율(%). 첫 단계는 null. */
  fromPrevious: number | null;
  /** 러프를 넣은 설치 대비(%). 퍼널 전체를 한 기준으로 읽기 위한 값. */
  fromStarted: number | null;
  /** 기존 두 비율은 설치 기준이다. 작업 기준 비율은 아래 별도 필드다. */
  rateBasis: "installations";
  jobFromPrevious: number | null;
  jobFromStarted: number | null;
}

export function toFunnel(row: FunnelRow): FunnelStage[] {
  const started = row.installations_started;
  const stages: Array<{ key: string; label: string; jobs: number | null; installations: number }> = [
    { key: "active", label: "활성 설치", jobs: null, installations: row.active_installations },
    { key: "started", label: "러프 투입", jobs: row.jobs_started, installations: started },
    { key: "completed", label: "분석 성공", jobs: row.jobs_completed, installations: row.installations_completed },
    { key: "selected", label: "포즈 사용 확정", jobs: row.jobs_selected, installations: row.installations_selected },
    { key: "exported", label: "서버 내보내기 기록", jobs: row.jobs_exported, installations: row.installations_exported },
  ];

  return stages.map((stage, index) => ({
    ...stage,
    fromPrevious: index === 0 ? null : rate(stage.installations, stages[index - 1].installations),
    fromStarted: index <= 1 ? null : rate(stage.installations, started),
    rateBasis: "installations",
    jobFromPrevious: index <= 1 || stage.jobs === null ? null : rate(stage.jobs, stages[index - 1].jobs ?? 0),
    jobFromStarted: index <= 1 || stage.jobs === null ? null : rate(stage.jobs, row.jobs_started),
  }));
}

// ── ② 코호트 ─────────────────────────────────────────────────

export interface CohortRow {
  installed_only: number;
  failed_only: number;
  pending?: number;
  completed_no_selection: number;
  selected_no_export: number;
  exported: number;
  total: number;
}

export interface CohortItem {
  key: string;
  label: string;
  /** 관찰 범위와 다음에 확인할 기록. 원인을 단정하지 않는다. */
  hint: string;
  count: number;
  share: number | null;
  /** 화면에서 강조할 그룹. 매칭 품질 문제가 가장 먼저 드러나는 자리다. */
  highlight?: boolean;
}

export function toCohorts(row: CohortRow): CohortItem[] {
  const items: Array<Omit<CohortItem, "share">> = [
    { key: "installedOnly", label: "분석 요청 없음", hint: "선택 기간 내 분석 요청 기록 없음 · 중단 이유는 미확인", count: row.installed_only },
    { key: "pending", label: "분석 진행·대기 중", hint: "완료 기록이 없고 대기·실행 중인 작업 있음", count: row.pending ?? 0 },
    { key: "failedOnly", label: "분석 실패만 기록됨", hint: "완료·진행 작업 없이 실패 기록만 있음 · 원인은 상세 오류 확인", count: row.failed_only },
    {
      key: "completedNoSelection",
      label: "완료 후 포즈 사용 확정 없음",
      hint: "결과 열람·조작·선택 여부와 수집 범위 확인 · 원인 미확인",
      count: row.completed_no_selection,
      highlight: true,
    },
    { key: "selectedNoExport", label: "사용 확정 후 서버 내보내기 기록 없음", hint: "실제 디스크 저장 여부는 클라이언트 저장 기록으로 별도 확인", count: row.selected_no_export },
    { key: "exported", label: "서버 내보내기 기록 있음", hint: "실제 디스크 저장 완료와 다름", count: row.exported },
  ];
  return items.map((item) => ({ ...item, share: rate(item.count, row.total) }));
}

// ── ③ 이탈 신호 ──────────────────────────────────────────────

export interface SignalRow {
  selected: boolean;
  jobs: number;
  zero_people_jobs: number;
  shortfall_jobs: number;
  avg_best_distance: number | null;
  avg_people: number | null;
  distance_samples?: number;
}

export interface MatchLevelRow {
  selected: boolean;
  match_level: string;
  count: number;
}

export interface SignalGroup {
  jobs: number;
  /** 인물을 하나도 못 찾은 Job 비율. 완료로 집계되지만 사용자에겐 빈 결과다. */
  zeroPeopleRate: number | null;
  /** 후보가 모자랐던 Job 비율(`candidate_shortfall_reason`). */
  shortfallRate: number | null;
  /**
   * 그 Job에서 **가장 가까운 후보의 거리** 평균. 낮을수록 좋다.
   *
   * 점수(`rerank_score`)가 아니라 거리인 이유: 추론이 `knn_geometric`을 직접 불러
   * rerank 경로를 쓰지 않으므로 `rerank_score`는 항상 비어 있다. 거리 표본 수와
   * 기록률을 함께 봐야 하며, 집단 차이가 품질이나 이탈 원인을 입증하지 않는다.
   */
  avgBestDistance: number | null;
  distanceSamples: number;
  distanceCoverageRate: number | null;
  avgPeople: number | null;
  matchLevels: Array<{ level: string; count: number; share: number | null }>;
}

export interface Dropoff {
  selected: SignalGroup;
  notSelected: SignalGroup;
  feedback: Array<{ reason: string; count: number }>;
  /** 결과가 마음에 들지 않아 다시 돌린 Job 수(클라이언트 이벤트). */
  rerunJobs: number;
}

function group(row: SignalRow | undefined, levels: MatchLevelRow[]): SignalGroup {
  const jobs = row?.jobs ?? 0;
  const mine = levels.filter((level) => level.selected === row?.selected);
  const total = mine.reduce((sum, level) => sum + level.count, 0);
  return {
    jobs,
    zeroPeopleRate: rate(row?.zero_people_jobs ?? 0, jobs),
    shortfallRate: rate(row?.shortfall_jobs ?? 0, jobs),
    avgBestDistance:
      row?.avg_best_distance === null || row?.avg_best_distance === undefined
        ? null
        : Math.round(Number(row.avg_best_distance) * 1000) / 1000,
    distanceSamples: row?.distance_samples ?? 0,
    distanceCoverageRate: rate(row?.distance_samples ?? 0, jobs),
    avgPeople:
      row?.avg_people === null || row?.avg_people === undefined
        ? null
        : Math.round(Number(row.avg_people) * 100) / 100,
    matchLevels: mine
      .map((level) => ({ level: level.match_level, count: level.count, share: rate(level.count, total) }))
      .sort((a, b) => b.count - a.count),
  };
}

export function toDropoff(
  signals: SignalRow[],
  levels: MatchLevelRow[],
  feedback: Array<{ reason: string; count: number }>,
  rerunJobs: number,
): Dropoff {
  return {
    selected: group(signals.find((s) => s.selected === true), levels),
    notSelected: group(signals.find((s) => s.selected === false), levels),
    feedback,
    rerunJobs,
  };
}
