// ① 첫 실행 퍼널과 ② 재시도 패턴의 순수 함수들.
//
// 2026-09-13 프로덕션 30일 수치가 이 둘을 요구했다.
//
//   · 설치 29명 중 11명(37.9%)이 러프를 한 번도 넣지 않았다 — 퍼널의 가장 큰 구멍인데
//     그 안이 깜깜했다. ①이 "언제 멈췄나, 아직 살아 있나"를 가른다.
//   · 사람 기준 선택률 61%인데 건 기준은 27.8%였다. 즉 여러 번 돌려야 하나 건진다.
//     ②가 "몇 번째에 건지나"를 그린다.

export interface FirstRunRow {
  installs: number;
  reached: number;
  within_10m: number;
  within_1h: number;
  within_1d: number;
  within_3d: number;
  later: number;
  /** 아직 한 번도 안 돌린 설치를 마지막 접속 기준으로 가른다. */
  idle_fresh: number;
  idle_week: number;
  idle_stale: number;
}

export interface FirstRunFunnel {
  installs: number;
  reached: number;
  reachRate: number | null;
  /** 첫 러프까지 걸린 시간 분포. 도달한 설치만 센다. */
  timeToFirst: Array<{ bucket: string; count: number; share: number | null }>;
  /**
   * 아직 안 돌린 설치. "이탈"과 "아직 기회가 있음"을 가른다 — 설치 당일 사람을
   * 이탈로 세면 온보딩 문제를 과대평가한다.
   */
  idle: Array<{ bucket: string; count: number; hint: string }>;
}

function share(count: number, total: number): number | null {
  if (!total) return null;
  return Math.round((count / total) * 1000) / 10;
}

export function toFirstRunFunnel(row: FirstRunRow): FirstRunFunnel {
  const reached = row.reached;
  return {
    installs: row.installs,
    reached,
    reachRate: share(reached, row.installs),
    timeToFirst: [
      { bucket: "10분 이내", count: row.within_10m },
      { bucket: "1시간 이내", count: row.within_1h },
      { bucket: "하루 이내", count: row.within_1d },
      { bucket: "3일 이내", count: row.within_3d },
      { bucket: "그 이후", count: row.later },
    ].map((item) => ({ ...item, share: share(item.count, reached) })),
    idle: [
      { bucket: "하루 이내 설치", count: row.idle_fresh, hint: "아직 기회가 있다" },
      { bucket: "마지막 접속 7일 이내", count: row.idle_week, hint: "돌아올 수 있다" },
      { bucket: "7일 넘게 조용함", count: row.idle_stale, hint: "사실상 이탈" },
    ],
  };
}

export interface CaptureFailureRow {
  code: string | null;
  events: number;
  installations: number;
}

export interface TopFailingInstallRow {
  installation_id: string;
  events: number;
}

export interface AttemptRow {
  attempt: number;
  jobs: number;
  selected: number;
}

export interface AttemptCurve {
  /** 6회 이상은 한 칸으로 묶는다 — 꼬리가 길어도 화면이 읽힌다. */
  attempt: string;
  jobs: number;
  selected: number;
  selectionRate: number | null;
}

export const ATTEMPT_CAP = 6;

export function toAttemptCurve(rows: AttemptRow[]): AttemptCurve[] {
  return rows
    .slice()
    .sort((a, b) => a.attempt - b.attempt)
    .map((row) => ({
      attempt: row.attempt >= ATTEMPT_CAP ? ATTEMPT_CAP + "회 이상" : row.attempt + "회차",
      jobs: row.jobs,
      selected: row.selected,
      selectionRate: share(row.selected, row.jobs),
    }));
}

export interface FirstSelectionRow {
  attempt_at_first: number;
  installations: number;
}

export interface Retry {
  curve: AttemptCurve[];
  /** 처음 고르기까지 몇 번을 돌렸나. 1회차가 낮으면 첫인상이 나쁘다는 뜻이다. */
  firstSelection: Array<{ attempt: string; installations: number; share: number | null }>;
  rerunJobs: number;
  totalJobs: number;
  rerunRate: number | null;
}

export function toRetry(
  curve: AttemptRow[],
  firstSelection: FirstSelectionRow[],
  rerunJobs: number,
  totalJobs: number,
): Retry {
  const installs = firstSelection.reduce((sum, row) => sum + row.installations, 0);
  return {
    curve: toAttemptCurve(curve),
    firstSelection: firstSelection
      .slice()
      .sort((a, b) => a.attempt_at_first - b.attempt_at_first)
      .map((row) => ({
        attempt: row.attempt_at_first >= ATTEMPT_CAP ? ATTEMPT_CAP + "회 이상" : row.attempt_at_first + "회차",
        installations: row.installations,
        share: share(row.installations, installs),
      })),
    rerunJobs,
    totalJobs,
    rerunRate: share(rerunJobs, totalJobs),
  };
}
