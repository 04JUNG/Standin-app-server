// 사용자(설치)별 활동: 언제 왔고, 무엇을 돌렸고, 결과가 어땠나. SQL은 `activityStore.ts`.
//
// 날짜는 한국 시간(KST)으로 자른다. 운영자가 "오늘 왔나"를 묻는 기준이 KST 하루라서다.

const KST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** KST 기준 YYYY-MM-DD. */
export function kstDay(date: Date): string {
  return KST_DAY.format(date);
}

/** 오늘(KST)부터 거꾸로 n일. 오래된 날이 앞이다. */
export function lastDays(today: string, n: number): string[] {
  const [y, m, d] = today.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Job 하나의 결과. 화면 색과 폴더 이름이 이 값을 쓴다. */
export type OutcomeKey = "selected" | "no_selection" | "zero_people" | "failed" | "in_progress";

export const OUTCOME_LABELS: Record<OutcomeKey, string> = {
  selected: "후보 선택",
  no_selection: "선택 안 함",
  zero_people: "인물 0명",
  failed: "실패",
  in_progress: "진행 중",
};

export interface ActivityJobRow {
  id: string;
  created_at: string;
  status: string;
  error_code: string | null;
  person_count: number;
  selection_count: number;
  exported: boolean;
  refined: boolean;
  feedback: string | null;
}

export function outcomeOf(row: Pick<ActivityJobRow, "status" | "person_count" | "selection_count">): OutcomeKey {
  if (row.status === "failed") return "failed";
  if (row.status !== "completed") return "in_progress";
  if (row.person_count === 0) return "zero_people";
  return row.selection_count > 0 ? "selected" : "no_selection";
}

export interface ActivityDay {
  date: string;
  /** 앱 이벤트나 Job이 하나라도 있었나. */
  visited: boolean;
  jobs: number;
  selected: number;
  failed: number;
  exported: number;
  /** 그날을 한 단어로: 칸 색을 정한다. 우선순위는 선택 > 선택 없음 > 실패 > 방문만 > 없음. */
  tone: "selected" | "no_selection" | "failed" | "visit_only" | "none";
}

export interface ActivityJob {
  jobId: string;
  createdAt: string;
  day: string;
  outcome: OutcomeKey;
  outcomeLabel: string;
  personCount: number;
  selectionCount: number;
  exported: boolean;
  refined: boolean;
  feedback: string | null;
  errorCode: string | null;
}

export interface ActivitySummary {
  days: ActivityDay[];
  jobs: ActivityJob[];
  visitedDays: number;
  lastVisit: string | null;
  jobsTotal: number;
  jobsSelected: number;
}

export function buildActivity(
  dayRows: Array<{ day: string; events: number }>,
  jobRows: ActivityJobRow[],
  today: string,
  n: number,
): ActivitySummary {
  const window = lastDays(today, n);
  const inWindow = new Set(window);
  const visits = new Map<string, number>();
  for (const row of dayRows) if (inWindow.has(row.day)) visits.set(row.day, row.events);

  const jobs: ActivityJob[] = jobRows
    .map((row) => {
      const outcome = outcomeOf(row);
      return {
        jobId: row.id,
        createdAt: row.created_at,
        day: kstDay(new Date(row.created_at)),
        outcome,
        outcomeLabel: OUTCOME_LABELS[outcome],
        personCount: row.person_count,
        selectionCount: row.selection_count,
        exported: row.exported,
        refined: row.refined,
        feedback: row.feedback,
        errorCode: row.error_code,
      };
    })
    .filter((job) => inWindow.has(job.day))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const days: ActivityDay[] = window.map((date) => {
    const todays = jobs.filter((job) => job.day === date);
    const selected = todays.filter((job) => job.outcome === "selected").length;
    const failed = todays.filter((job) => job.outcome === "failed").length;
    const visited = (visits.get(date) ?? 0) > 0 || todays.length > 0;
    const tone: ActivityDay["tone"] =
      selected > 0 ? "selected"
      : todays.some((job) => job.outcome === "no_selection" || job.outcome === "zero_people") ? "no_selection"
      : failed > 0 ? "failed"
      : visited ? "visit_only"
      : "none";
    return {
      date,
      visited,
      jobs: todays.length,
      selected,
      failed,
      exported: todays.filter((job) => job.exported).length,
      tone,
    };
  });

  const visitedDates = days.filter((day) => day.visited).map((day) => day.date);
  return {
    days,
    jobs,
    visitedDays: visitedDates.length,
    lastVisit: visitedDates.length ? visitedDates[visitedDates.length - 1] : null,
    jobsTotal: jobs.length,
    jobsSelected: jobs.filter((job) => job.outcome === "selected").length,
  };
}

/** 설치 목록의 7일 출석 점. 설치마다 날짜순 칸. */
export function buildStrips(
  rows: Array<{ installation_id: string; day: string; events: number; jobs: number }>,
  ids: string[],
  today: string,
  n: number,
): Record<string, Array<{ date: string; visited: boolean; jobs: number }>> {
  const window = lastDays(today, n);
  const out: Record<string, Array<{ date: string; visited: boolean; jobs: number }>> = {};
  for (const id of ids) out[id] = window.map((date) => ({ date, visited: false, jobs: 0 }));
  for (const row of rows) {
    const cells = out[row.installation_id];
    const cell = cells?.find((item) => item.date === row.day);
    if (cell) {
      cell.visited = row.events > 0 || row.jobs > 0;
      cell.jobs = row.jobs;
    }
  }
  return out;
}
