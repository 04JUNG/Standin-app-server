// 제품 지표 쿼리. 합산은 전부 SQL에서 한다 — 앱으로 행을 다 가져오면 화면 한 번
// 여는 비용이 서비스보다 커진다(`ops/store.ts`와 같은 원칙).
import { query, queryOne } from "../db.js";
import type { FunnelRow, MatchLevelRow, SignalRow } from "./product.js";
import type { ColumnHealthRow, DistanceBucketRow } from "./instrumentation.js";
import type {
  AttemptRow,
  CaptureFailureRow,
  FirstRunRow,
  FirstSelectionRow,
  TopFailingInstallRow,
} from "./adoption.js";

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
       avg(c.best_distance) AS avg_best_distance,
       avg(p.person_count) AS avg_people
     FROM scoped s
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS person_count,
              count(*) FILTER (WHERE ap.candidate_shortfall_reason IS NOT NULL)::int AS shortfall
       FROM analysis_people ap WHERE ap.job_id = s.id
     ) p ON TRUE
     LEFT JOIN LATERAL (
       -- 점수가 아니라 거리다. 프로덕션 파이프라인은 knn_geometric을 직접 불러
       -- rerank_score를 채우지 않는다(rerank는 쓰이지 않는 선택 경로다).
       SELECT min(ac.distance) AS best_distance
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

/**
 * 계측 건강도 — 지표가 기대는 컬럼이 실제로 채워지고 있는가.
 *
 * `rerank_score`가 전부 비어 있는 것을 눈으로 찾느라 한참 걸렸다. 비어 있다는 사실
 * 자체를 화면에 올려 두면 다음 사람은 그 단계를 건너뛴다.
 */
export async function columnHealth(days: number): Promise<ColumnHealthRow[]> {
  const from = since(days);
  const [candidates, people, jobs, exports] = await Promise.all([
    queryOne<{ rows: number; rerank_nulls: number; distance_nulls: number }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE ac.rerank_score IS NULL)::int AS rerank_nulls,
              count(*) FILTER (WHERE ac.distance IS NULL)::int AS distance_nulls
       FROM analysis_candidates ac JOIN jobs j ON j.id = ac.job_id
       WHERE j.created_at >= $1`,
      [from],
    ),
    queryOne<{ rows: number; confidence_nulls: number; skeleton_nulls: number }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE ap.confidence IS NULL)::int AS confidence_nulls,
              count(*) FILTER (WHERE ap.skeleton_json IS NULL)::int AS skeleton_nulls
       FROM analysis_people ap JOIN jobs j ON j.id = ap.job_id
       WHERE j.created_at >= $1`,
      [from],
    ),
    queryOne<{ rows: number; size_nulls: number; completed_nulls: number }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE input_width IS NULL)::int AS size_nulls,
              count(*) FILTER (WHERE status = 'completed' AND completed_at IS NULL)::int AS completed_nulls
       FROM jobs WHERE created_at >= $1`,
      [from],
    ),
    queryOne<{ rows: number; format_nulls: number; variant_nulls: number }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE format IS NULL)::int AS format_nulls,
              count(*) FILTER (WHERE variant IS NULL)::int AS variant_nulls
       FROM export_events WHERE status = 'completed' AND occurred_at >= $1`,
      [from],
    ),
  ]);

  return [
    { label: "analysis_candidates.rerank_score", rows: candidates?.rows ?? 0, nulls: candidates?.rerank_nulls ?? 0 },
    { label: "analysis_candidates.distance", rows: candidates?.rows ?? 0, nulls: candidates?.distance_nulls ?? 0 },
    { label: "analysis_people.confidence", rows: people?.rows ?? 0, nulls: people?.confidence_nulls ?? 0 },
    { label: "analysis_people.skeleton_json", rows: people?.rows ?? 0, nulls: people?.skeleton_nulls ?? 0 },
    { label: "jobs.input_width", rows: jobs?.rows ?? 0, nulls: jobs?.size_nulls ?? 0 },
    { label: "jobs.completed_at (완료인데 비어 있음)", rows: jobs?.rows ?? 0, nulls: jobs?.completed_nulls ?? 0 },
    { label: "export_events.format", rows: exports?.rows ?? 0, nulls: exports?.format_nulls ?? 0 },
    { label: "export_events.variant (조정본/베이스)", rows: exports?.rows ?? 0, nulls: exports?.variant_nulls ?? 0 },
  ];
}

/** 서버 기록 쪽 단계 수. 클라이언트 이벤트와 짝지어 어긋남을 본다. */
export async function serverStageCounts(days: number): Promise<Record<string, number>> {
  const from = since(days);
  const row = await queryOne<{ jobs: number; failed: number; selections: number; exports: number }>(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE created_at >= $1) AS jobs,
       (SELECT count(*)::int FROM jobs WHERE created_at >= $1 AND status = 'failed') AS failed,
       (SELECT count(DISTINCT cs.job_id)::int FROM confirmed_selections cs
         JOIN jobs j ON j.id = cs.job_id WHERE j.created_at >= $1) AS selections,
       (SELECT count(DISTINCT e.job_id)::int FROM export_events e
         WHERE e.status = 'completed' AND e.occurred_at >= $1) AS exports`,
    [from],
  );
  return { jobs: row?.jobs ?? 0, failed: row?.failed ?? 0, selections: row?.selections ?? 0, exports: row?.exports ?? 0 };
}

/**
 * 거리 구간별 선택률.
 *
 * Job마다 **가장 가까운 후보의 distance**로 구간을 정한다. 사용자가 고르는 기준은
 * 평균이 아니라 "제일 나은 하나가 쓸 만한가"이기 때문이다.
 */
export async function distanceBuckets(days: number): Promise<DistanceBucketRow[]> {
  return query<DistanceBucketRow>(
    `WITH scoped AS (
       SELECT j.id, (cs.job_id IS NOT NULL) AS selected
       FROM jobs j
       LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
       WHERE j.created_at >= $1 AND j.status = 'completed' AND j.installation_id IS NOT NULL
     ),
     best AS (
       SELECT s.id, s.selected, (SELECT min(ac.distance) FROM analysis_candidates ac
                                  WHERE ac.job_id = s.id) AS best
       FROM scoped s
     )
     SELECT
       CASE
         WHEN best IS NULL THEN '없음'
         WHEN best <= 0.15 THEN '≤0.15'
         WHEN best <= 0.25 THEN '≤0.25'
         WHEN best <= 0.35 THEN '≤0.35'
         WHEN best <= 0.45 THEN '≤0.45'
         ELSE '>0.45'
       END AS bucket,
       count(*)::int AS jobs,
       count(*) FILTER (WHERE selected)::int AS selected
     FROM best
     GROUP BY 1`,
    [since(days)],
  );
}

/**
 * ① 첫 실행 퍼널 — 설치하고 첫 러프까지.
 *
 * 기간 내에 **새로 만들어진 설치**만 본다. 오래전에 설치한 사람이 오늘 처음 돌린
 * 경우를 섞으면 "설치 후 얼마 만에 쓰나"가 흐려진다.
 *
 * 아직 안 돌린 설치를 마지막 접속 기준으로 가르는 이유: 오늘 설치한 사람을 이탈로
 * 세면 온보딩 문제를 실제보다 크게 본다.
 */
export async function firstRunFunnel(days: number): Promise<FirstRunRow> {
  const from = since(days);
  const row = await queryOne<FirstRunRow>(
    `WITH cohort AS (
       SELECT i.id, i.created_at, i.last_seen_at,
              (SELECT min(j.created_at) FROM jobs j WHERE j.installation_id = i.id) AS first_job_at
       FROM installations i
       WHERE i.created_at >= $1
     ),
     gapped AS (
       SELECT *,
              CASE WHEN first_job_at IS NULL THEN NULL
                   ELSE extract(epoch FROM (first_job_at::timestamptz - created_at::timestamptz))
              END AS to_first,
              extract(epoch FROM (now() - last_seen_at::timestamptz)) AS idle_seconds,
              extract(epoch FROM (now() - created_at::timestamptz)) AS age_seconds
       FROM cohort
     )
     SELECT
       count(*)::int AS installs,
       count(*) FILTER (WHERE first_job_at IS NOT NULL)::int AS reached,
       count(*) FILTER (WHERE to_first <= 600)::int AS within_10m,
       count(*) FILTER (WHERE to_first > 600 AND to_first <= 3600)::int AS within_1h,
       count(*) FILTER (WHERE to_first > 3600 AND to_first <= 86400)::int AS within_1d,
       count(*) FILTER (WHERE to_first > 86400 AND to_first <= 259200)::int AS within_3d,
       count(*) FILTER (WHERE to_first > 259200)::int AS later,
       count(*) FILTER (WHERE first_job_at IS NULL AND age_seconds <= 86400)::int AS idle_fresh,
       count(*) FILTER (WHERE first_job_at IS NULL AND age_seconds > 86400
                          AND idle_seconds <= 604800)::int AS idle_week,
       count(*) FILTER (WHERE first_job_at IS NULL AND age_seconds > 86400
                          AND idle_seconds > 604800)::int AS idle_stale
     FROM gapped`,
    [from],
  );
  return row ?? {
    installs: 0, reached: 0, within_10m: 0, within_1h: 0, within_1d: 0,
    within_3d: 0, later: 0, idle_fresh: 0, idle_week: 0, idle_stale: 0,
  };
}

/** 캡처 실패 코드 분포. 첫 실행에 닿지 못한 이유 중 유일하게 기록이 남는 쪽이다. */
export async function captureFailures(days: number): Promise<CaptureFailureRow[]> {
  return query<CaptureFailureRow>(
    `SELECT properties_json::jsonb ->> 'code' AS code,
            count(*)::int AS events,
            count(DISTINCT installation_id)::int AS installations
     FROM analytics_events
     WHERE event_name = 'capture_failed' AND occurred_at >= $1
     GROUP BY 1
     ORDER BY count(*) DESC
     LIMIT 10`,
    [since(days)],
  );
}

/**
 * 캡처 실패가 몰린 설치.
 *
 * 오늘 프로덕션에서 `capture_failed` 36건이 **설치 1곳**에서 나왔다. 집계만 보면
 * "36건 실패"지만 실제로는 한 사람이 계속 막혀 있는 것이다 — 둘은 대응이 다르다.
 */
export async function topCaptureFailures(days: number): Promise<TopFailingInstallRow[]> {
  return query<TopFailingInstallRow>(
    `SELECT installation_id, count(*)::int AS events
     FROM analytics_events
     WHERE event_name = 'capture_failed' AND occurred_at >= $1
     GROUP BY installation_id
     ORDER BY count(*) DESC
     LIMIT 5`,
    [since(days)],
  );
}

/**
 * ② 몇 번째 시도에서 고르나.
 *
 * 설치 안에서 Job의 순번을 매겨 순번별 선택률을 낸다. 1회차 선택률이 낮고 뒤로 갈수록
 * 오른다면 "여러 번 돌려야 건진다"는 뜻이고, 순번과 무관하게 낮다면 매칭 자체 문제다.
 */
export async function attemptCurve(days: number): Promise<AttemptRow[]> {
  return query<AttemptRow>(
    `WITH scoped AS (
       SELECT j.id, j.installation_id,
              row_number() OVER (PARTITION BY j.installation_id ORDER BY j.created_at, j.id) AS attempt,
              (cs.job_id IS NOT NULL) AS selected
       FROM jobs j
       LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
       WHERE j.created_at >= $1 AND j.installation_id IS NOT NULL
     )
     SELECT least(attempt, 6)::int AS attempt,
            count(*)::int AS jobs,
            count(*) FILTER (WHERE selected)::int AS selected
     FROM scoped
     GROUP BY 1
     ORDER BY 1`,
    [since(days)],
  );
}

/** 처음 고르기까지 몇 번을 돌렸나(설치 기준). */
export async function firstSelectionAttempt(days: number): Promise<FirstSelectionRow[]> {
  return query<FirstSelectionRow>(
    `WITH scoped AS (
       SELECT j.installation_id,
              row_number() OVER (PARTITION BY j.installation_id ORDER BY j.created_at, j.id) AS attempt,
              (cs.job_id IS NOT NULL) AS selected
       FROM jobs j
       LEFT JOIN (SELECT DISTINCT job_id FROM confirmed_selections) cs ON cs.job_id = j.id
       WHERE j.created_at >= $1 AND j.installation_id IS NOT NULL
     )
     SELECT least(min(attempt), 6)::int AS attempt_at_first,
            count(*)::int AS installations
     FROM (
       SELECT installation_id, min(attempt) AS attempt
       FROM scoped WHERE selected GROUP BY installation_id
     ) first
     GROUP BY least(attempt, 6)
     ORDER BY 1`,
    [since(days)],
  );
}

/** 명시적으로 다시 돌린 Job 비율(`rerun_of`). */
export async function rerunRatio(days: number): Promise<{ reruns: number; jobs: number }> {
  const row = await queryOne<{ reruns: number; jobs: number }>(
    `SELECT count(*) FILTER (WHERE rerun_of IS NOT NULL)::int AS reruns,
            count(*)::int AS jobs
     FROM jobs WHERE created_at >= $1`,
    [since(days)],
  );
  return row ?? { reruns: 0, jobs: 0 };
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
