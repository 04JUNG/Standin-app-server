// 제품 지표(GET /v1/admin/product)의 순수 함수들 — 기간 검증, 비율 계산, row→응답 매핑.
//
// 운영 대시보드 위쪽이 "서비스가 지금 살아 있나"를 답한다면 여기는 "제품이 자라고
// 있나"를 답한다. 세 가지를 한 화면에 놓는다.
//
//   ① 퍼널   — 어디서 새는가
//   ② 코호트 — 누가 어디서 멈췄는가
//   ③ 신호   — 멈춘 쪽은 무엇이 달랐는가
//
// 셋을 따로 보면 "선택률이 낮다"까지만 알고 끝난다. 이어 놓아야 낮은 선택률이
// 후보 점수 때문인지, 인물 검출 실패 때문인지, 후보가 모자라서인지로 내려간다.

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
}

export function toFunnel(row: FunnelRow): FunnelStage[] {
  const started = row.installations_started;
  const stages: Array<{ key: string; label: string; jobs: number | null; installations: number }> = [
    { key: "active", label: "활성 설치", jobs: null, installations: row.active_installations },
    { key: "started", label: "러프 투입", jobs: row.jobs_started, installations: started },
    { key: "completed", label: "분석 성공", jobs: row.jobs_completed, installations: row.installations_completed },
    { key: "selected", label: "후보 선택", jobs: row.jobs_selected, installations: row.installations_selected },
    { key: "exported", label: "저장 완료", jobs: row.jobs_exported, installations: row.installations_exported },
  ];

  return stages.map((stage, index) => ({
    ...stage,
    fromPrevious: index === 0 ? null : rate(stage.installations, stages[index - 1].installations),
    fromStarted: index <= 1 ? null : rate(stage.installations, started),
  }));
}

// ── ② 코호트 ─────────────────────────────────────────────────

export interface CohortRow {
  installed_only: number;
  failed_only: number;
  completed_no_selection: number;
  selected_no_export: number;
  exported: number;
  total: number;
}

export interface CohortItem {
  key: string;
  label: string;
  /** 이 그룹이 무엇을 의심하게 하는지. 숫자만 놓으면 다음 행동이 안 나온다. */
  hint: string;
  count: number;
  share: number | null;
  /** 화면에서 강조할 그룹. 매칭 품질 문제가 가장 먼저 드러나는 자리다. */
  highlight?: boolean;
}

export function toCohorts(row: CohortRow): CohortItem[] {
  const items: Array<Omit<CohortItem, "share">> = [
    { key: "installedOnly", label: "설치만 · 미투입", hint: "온보딩·첫인상", count: row.installed_only },
    { key: "failedOnly", label: "실패만 경험", hint: "인프라·입력 품질", count: row.failed_only },
    {
      key: "completedNoSelection",
      label: "완료했지만 선택 없음",
      hint: "매칭 품질 — 아래 신호로 내려간다",
      count: row.completed_no_selection,
      highlight: true,
    },
    { key: "selectedNoExport", label: "선택했지만 저장 없음", hint: "저장 UX·변환 실패", count: row.selected_no_export },
    { key: "exported", label: "끝까지 완료", hint: "—", count: row.exported },
  ];
  return items.map((item) => ({ ...item, share: rate(item.count, row.total) }));
}

// ── ③ 이탈 신호 ──────────────────────────────────────────────

export interface SignalRow {
  selected: boolean;
  jobs: number;
  zero_people_jobs: number;
  shortfall_jobs: number;
  avg_best_score: number | null;
  avg_people: number | null;
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
  /** 그 Job에서 가장 높았던 후보 점수의 평균. 두 그룹의 차이가 곧 임계값 단서다. */
  avgBestScore: number | null;
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
    avgBestScore:
      row?.avg_best_score === null || row?.avg_best_score === undefined
        ? null
        : Math.round(Number(row.avg_best_score) * 1000) / 1000,
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
