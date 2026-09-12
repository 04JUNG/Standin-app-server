// 제품 지표 쿼리. 합산은 전부 SQL에서 한다 — 앱으로 행을 다 가져오면 화면 한 번
// 여는 비용이 서비스보다 커진다(`ops/store.ts`와 같은 원칙).
import { query, queryOne } from "../db.js";
import type { FunnelRow, MatchLevelRow, SignalRow } from "./product.js";

/** 기간 경계. `created_at`이 TEXT라 ISO 문자열 비교가 곧 시간 비교다. */
function since(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * ① 퍼널. 건수와 **설치 수**를 함께 센다.
 *
 * 건수만 보면 한 사람이 열 번 돌린 것과 열 사람이 한 번씩 돌린 것이 같아 보인다.
 * 이탈을 이야기하려면 사람 기준이 필요하고, 부하를 이야기하려면 건수가 필요하다.
 */
export async function funnelCounts(days: number): Promise<FunnelRow> {
  const from = since(days);
  const row = await queryOne<FunnelRow>(
    `WITH window_jobs AS (
       SELECT j.id, j.installation_id, j.status
       FROM jobs j
       WHERE j.created_at >= $1 AND j.installation_id IS NOT NULL
     ),
     selected AS (
       SELECT DISTINCT cs.job_id FROM confirmed_selections cs
       JOIN window_jobs w ON w.id = cs.job_id
     ),
     exported AS (
       SELECT DISTINCT e.job_id FROM export_events e
       JOIN window_jobs w ON w.id = e.job_id
       WHERE e.status = 'completed'
     )
     SELECT
       (SELECT count(*)::int FROM installations WHERE last_seen_at >= $1) AS active_installations,
       (SELECT count(*)::int FROM window_jobs) AS jobs_started,
       (SELECT count(DISTINCT installation_id)::int FROM window_jobs) AS installations_started,
       (SELECT count(*)::int FROM window_jobs WHERE status = 'completed') AS jobs_completed,
       (SELECT count(DISTINCT installation_id)::int FROM window_jobs WHERE status = 'completed')
         AS installations_completed,
       (SELECT count(*)::int FROM window_jobs WHERE status = 'failed') AS jobs_failed,
       (SELECT count(*)::int FROM selected) AS jobs_selected,
       (SELECT count(DISTINCT w.installation_id)::int FROM window_jobs w
         JOIN selected s ON s.job_id = w.id) AS installations_selected,
       (SELECT count(*)::int FROM exported) AS jobs_exported,
       (SELECT count(DISTINCT w.installation_id)::int FROM window_jobs w
         JOIN exported e ON e.job_id = w.id) AS installations_exported`,
    [from],
  );
  return (
    row ?? {
      active_installations: 0, jobs_started: 0, installations_started: 0,
      jobs_completed: 0, installations_completed: 0, jobs_failed: 0,
      jobs_selected: 0, installations_selected: 0, jobs_exported: 0, installations_exported: 0,
    }
  );
}

/** 클라이언트 이벤트 쪽 단계 수. 서버 기록과 나란히 놓아 계측 유실을 드러낸다. */
export async function clientStageCounts(days: number): Promise<
  Array<{ event_name: string; events: number; installations: number }>
> {
  return query(
    `SELECT event_name, count(*)::int AS events, count(DISTINCT installation_id)::int AS installations
     FROM analytics_events
     WHERE occurred_at >= $1
     GROUP BY event_name
     ORDER BY count(*) DESC`,
    [since(days)],
  );
}

/**
 * ② 코호트. 설치마다 **마지막으로 도달한 단계**로 분류한다.
 *
 * 집계를 LATERAL로 설치당 한 번씩만 돌린다. `confirmed_selections`는 인물마다 한 행,
 * `export_events`는 시도마다 한 행이라 그냥 조인하면 Job 수가 부풀려진다 — 그래서
 * 전부 `count(DISTINCT j.id)`로 센다.
 */
export async function cohortCounts(days: number): Promise<{
  installed_only: number;
  failed_only: number;
  completed_no_selection: number;
  selected_no_export: number;
  exported: number;
  total: number;
}> {
  const from = since(days);
  const row = await queryOne<{
    installed_only: number; failed_only: number; completed_no_selection: number;
    selected_no_export: number; exported: number; total: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE a.jobs = 0)::int AS installed_only,
       count(*) FILTER (WHERE a.jobs > 0 AND a.completed = 0)::int AS failed_only,
       count(*) FILTER (WHERE a.completed > 0 AND a.selected = 0)::int AS completed_no_selection,
       count(*) FILTER (WHERE a.selected > 0 AND a.exported = 0)::int AS selected_no_export,
       count(*) FILTER (WHERE a.exported > 0)::int AS exported,
       count(*)::int AS total
     FROM installations i
     LEFT JOIN LATERAL (
       SELECT
         count(DISTINCT j.id)::int AS jobs,
         count(DISTINCT j.id) FILTER (WHERE j.status = 'completed')::int AS completed,
         count(DISTINCT cs.job_id)::int AS selected,
         count(DISTINCT ee.job_id)::int AS exported
       FROM jobs j
       LEFT JOIN confirmed_selections cs ON cs.job_id = j.id
       LEFT JOIN export_events ee ON ee.job_id = j.id AND ee.status = 'completed'
       WHERE j.installation_id = i.id AND j.created_at >= $1
     ) a ON TRUE
     WHERE i.last_seen_at >= $1 OR a.jobs > 0`,
    [from],
  );
  return row ?? {
    installed_only: 0, failed_only: 0, completed_no_selection: 0,
    selected_no_export: 0, exported: 0, total: 0,
  };
}

/**
 * ③ 이탈 신호. 완료된 Job을 **선택 있음/없음** 두 집단으로 갈라 비교한다.
 *
 * 한 집단만 보면 "점수 0.7"이 높은지 낮은지 알 수 없다. 두 집단의 차이가 곧
 * "어느 선 아래로 내려가면 사용자가 고르지 않는가"의 단서다.
 */
export async function dropoffSignals(days: number): Promise<SignalRow[]> {
  return query<SignalRow>(
    `WITH scoped AS (
       SELECT j.id, (cs.job_id IS NOT NULL) AS selected
       FROM jobs j
       LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
       WHERE j.created_at >= $1 AND j.status = 'completed' AND j.installation_id IS NOT NULL
     )
     SELECT
       s.selected,
       count(*)::int AS jobs,
       count(*) FILTER (WHERE p.person_count = 0)::int AS zero_people_jobs,
       count(*) FILTER (WHERE p.shortfall > 0)::int AS shortfall_jobs,
       avg(c.best_score) AS avg_best_score,
       avg(p.person_count) AS avg_people
     FROM scoped s
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS person_count,
              count(*) FILTER (WHERE ap.candidate_shortfall_reason IS NOT NULL)::int AS shortfall
       FROM analysis_people ap WHERE ap.job_id = s.id
     ) p ON TRUE
     LEFT JOIN LATERAL (
       SELECT max(ac.rerank_score) AS best_score
       FROM analysis_candidates ac WHERE ac.job_id = s.id
     ) c ON TRUE
     GROUP BY s.selected`,
    [since(days)],
  );
}

/** 1순위 후보의 match_level 분포. 선택 여부로 갈라 본다. */
export async function matchLevelSplit(days: number): Promise<MatchLevelRow[]> {
  return query<MatchLevelRow>(
    `WITH scoped AS (
       SELECT j.id, (cs.job_id IS NOT NULL) AS selected
       FROM jobs j
       LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
       WHERE j.created_at >= $1 AND j.status = 'completed' AND j.installation_id IS NOT NULL
     )
     SELECT s.selected, ac.match_level, count(*)::int AS count
     FROM scoped s
     JOIN analysis_candidates ac ON ac.job_id = s.id AND ac.rank = 1
     GROUP BY s.selected, ac.match_level`,
    [since(days)],
  );
}

/** 선택하지 않은 Job에 달린 피드백. "왜 안 골랐나"에 사용자가 직접 답한 유일한 값이다. */
export async function noSelectionFeedback(
  days: number,
): Promise<Array<{ reason: string; count: number }>> {
  return query(
    `SELECT f.reason, count(*)::int AS count
     FROM job_feedback f
     JOIN jobs j ON j.id = f.job_id
     LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
     WHERE j.created_at >= $1 AND cs.job_id IS NULL
     GROUP BY f.reason
     ORDER BY count(*) DESC
     LIMIT 10`,
    [since(days)],
  );
}

/** 결과가 마음에 들지 않아 다시 돌린 Job 수. */
export async function rerunJobCount(days: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(DISTINCT job_id)::int AS count
     FROM analytics_events
     WHERE event_name = 'rerun_requested' AND occurred_at >= $1`,
    [since(days)],
  );
  return row?.count ?? 0;
}
