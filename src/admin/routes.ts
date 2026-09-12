import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { execute, query, queryOne } from "../db.js";
import type { AppEnv } from "../env.js";
import { signedInputUrl } from "../inputStorage.js";
import { getAnalysisFlag, setAnalysisEnabled } from "../limits/flags.js";
import { dailyWindow } from "../limits/policy.js";
import { currentUsage } from "../limits/store.js";
import { errorEnvelope } from "../mapping.js";
import { getInstallationSummary, listInstallations } from "../installations/store.js";
import { parseRosterQuery, toRosterPage } from "./installationList.js";
import { DEFAULT_REVIEWER, matchReviewer, parseReviewers } from "./reviewers.js";
import { parseWindowDays, toCohorts, toDropoff, toFunnel } from "./product.js";
import { toColumnHealth, toDistanceBuckets, toStageGaps } from "./instrumentation.js";
import {
  clientStageCounts,
  cohortCounts,
  dropoffSignals,
  funnelCounts,
  matchLevelSplit,
  noSelectionFeedback,
  rerunJobCount,
  columnHealth,
  serverStageCounts,
  distanceBuckets,
} from "./productStore.js";
import { isInstallationId, parseHistoryQuery, toHistoryPage } from "../jobs/history.js";
import { listJobHistory } from "../jobs/store.js";
import { getPoseThumbnail, health } from "../inference.js";
import { DASHBOARD_HTML } from "../ops/dashboard.js";
import {
  activeTasks,
  hourSeries,
  minuteSeries,
  topErrors,
  topRoutes,
  totals,
} from "../ops/store.js";

export const adminRoutes = new Hono<AppEnv>();

/**
 * 검토자 목록은 기동 시 한 번만 만든다. 시크릿은 ECS가 태스크를 띄울 때 주입하므로
 * 값을 바꾸면 어차피 재배포가 필요하다 — 요청마다 다시 파싱할 이유가 없다.
 */
const REVIEWERS = parseReviewers(config.betaReviewAdminToken);

/**
 * 대시보드만 쿼리스트링 토큰을 허용한다.
 *
 * 브라우저 주소창으로 여는 화면이라 헤더를 붙일 방법이 없다. 대신 페이지가 로드 즉시
 * history.replaceState로 토큰을 주소에서 지우고 sessionStorage로 옮긴다 — 히스토리와
 * 리퍼러에 남지 않는다. API(`/ops`)는 여전히 헤더만 받는다.
 */
const DASHBOARD_PATH = "/v1/admin/ops/dashboard";

adminRoutes.use("*", async (c, next) => {
  const supplied =
    c.req.header("X-Beta-Admin-Token") ??
    (c.req.path === DASHBOARD_PATH ? c.req.query("token") ?? "" : "");
  const reviewer = matchReviewer(REVIEWERS, supplied);
  if (!reviewer) {
    // 401이 아니라 404다 — 관리자 API가 존재한다는 사실 자체를 노출하지 않는다.
    return c.json(errorEnvelope("NOT_FOUND", "not found", c.get("requestId")), 404);
  }
  c.set("reviewer", reviewer);
  await next();
});

/**
 * 관리자 접근을 남긴다.
 *
 * 대상을 `jobId` 하나로 받지 않는 이유: 설치 단위 조회는 Job 하나를 여는 것보다 넓게
 * 본다(그 설치의 기록 전체가 목록에 뜬다). 대상 칸을 비워 두면 감사 로그만 봐서는
 * "누가 무엇을 열람했나"를 복원할 수 없다.
 */
async function audit(
  c: Context<AppEnv>,
  action: string,
  target: { jobId?: string | null; installationId?: string | null } = {},
): Promise<void> {
  await execute(
    `INSERT INTO admin_access_audit
      (audit_id, reviewer, action, job_id, installation_id, request_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      `audit_${randomUUID()}`,
      // 시크릿이 JSON이면 사람 이름, 단일 토큰이면 DEFAULT_REVIEWER가 들어온다.
      c.get("reviewer") ?? DEFAULT_REVIEWER,
      action,
      target.jobId ?? null,
      target.installationId ?? null,
      c.get("requestId"),
      new Date().toISOString(),
    ],
  );
}

// GET /v1/admin/ops/dashboard — 의존성 없는 정적 대시보드 한 장.
// 데이터는 담지 않는다. 화면이 열린 뒤 아래 /ops를 토큰 헤더로 호출해 채운다.
adminRoutes.get("/ops/dashboard", (c) => c.html(DASHBOARD_HTML));

/**
 * GET /v1/admin/ops — 대시보드가 읽는 집계(계획 3단계).
 *
 * 합산은 전부 SQL에서 한다. 24시간이면 태스크당 1440행이라 앱으로 다 가져오면
 * 대시보드를 한 번 여는 비용이 서비스보다 커진다.
 */
adminRoutes.get("/ops", async (c) => {
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const day = dailyWindow(now);

  const [
    bffMinutes, bffHours, bffTotals,
    inferenceTotals, errors, routes, tasks,
    flag, quotaUsed, inferenceHealthy, jobs,
  ] = await Promise.all([
    minuteSeries(hourAgo, "bff"),
    hourSeries(dayAgo, "bff"),
    totals(hourAgo, "bff"),
    totals(hourAgo, "inference"),
    topErrors(hourAgo),
    topRoutes(hourAgo),
    activeTasks(hourAgo),
    getAnalysisFlag(),
    currentUsage("global_day", "all", day),
    health(),
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM jobs
       WHERE created_at >= $1 GROUP BY status ORDER BY count(*) DESC`,
      [hourAgo],
    ),
  ]);

  return c.json({
    now: new Date(now).toISOString(),
    // 화면에 누구로 보고 있는지 띄운다. 토큰을 나눠 쓰던 습관이 남아 있으면
    // "내 이름으로 열람 기록이 남는다"는 사실이 눈에 보여야 한다.
    reviewer: c.get("reviewer") ?? DEFAULT_REVIEWER,
    inferenceHealthy,
    analysisEnabled: flag.enabled,
    analysisReason: flag.reason,
    tasks,
    bff: { hour: bffTotals, minutes: bffMinutes, hours: bffHours },
    inference: { hour: inferenceTotals },
    topErrors: errors,
    topRoutes: routes,
    jobs: jobs.map((row) => ({ key: row.status, count: Number(row.count) })),
    quota: { day: day.key, used: quotaUsed, limit: config.quotaGlobalDaily },
  });
});

// GET /v1/admin/flags — 현재 운영 스위치와 오늘 전체 사용량.
adminRoutes.get("/flags", async (c) => {
  const day = dailyWindow(Date.now());
  const flag = await getAnalysisFlag();
  return c.json({
    analysisEnabled: flag.enabled,
    reason: flag.reason,
    updatedAt: flag.updatedAt,
    globalDaily: {
      day: day.key,
      used: await currentUsage("global_day", "all", day),
      limit: config.quotaGlobalDaily,
    },
  });
});

/**
 * PUT /v1/admin/flags/analysis_enabled — 분석 즉시 중단·재개(kill switch).
 * 다른 태스크에는 캐시 TTL(5초) 안에 전파된다.
 */
adminRoutes.put("/flags/analysis_enabled", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.enabled !== "boolean") {
    return c.json(
      errorEnvelope("INVALID_INPUT", "enabled(boolean)이 필요합니다.", c.get("requestId")),
      400,
    );
  }
  const reason =
    typeof body.reason === "string" && body.reason.length > 0 && body.reason.length <= 256
      ? body.reason
      : null;
  const flag = await setAnalysisEnabled(body.enabled, reason);
  await audit(c, body.enabled ? "resume_analysis" : "pause_analysis");
  return c.json({
    analysisEnabled: flag.enabled,
    reason: flag.reason,
    updatedAt: flag.updatedAt,
    propagationSeconds: 5,
  });
});

/**
 * GET /v1/admin/product — 제품 지표(퍼널 · 코호트 · 이탈 신호).
 *
 * 위쪽 `/ops`가 "서비스가 지금 살아 있나"를 답한다면 여기는 "제품이 자라고 있나"를
 * 답한다. 셋을 한 응답에 담는 이유는 화면에서 이어 읽히기 때문이다 — 퍼널에서 어디가
 * 새는지 보고, 코호트에서 누가 거기 멈췄는지 세고, 신호에서 그들이 무엇이 달랐는지로
 * 내려간다. 따로 부르면 세 번 왕복하면서 기간이 어긋날 수 있다.
 */
adminRoutes.get("/product", async (c) => {
  const parsed = parseWindowDays(c.req.query("days"));
  if (!parsed.ok) {
    return c.json(errorEnvelope("INVALID_INPUT", parsed.message, c.get("requestId")), 400);
  }
  const { days } = parsed;
  const [
    funnelRow, clientStages, cohortRow, signals, levels, feedback, rerunJobs,
    columns, serverStages, buckets,
  ] = await Promise.all([
    funnelCounts(days),
    clientStageCounts(days),
    cohortCounts(days),
    dropoffSignals(days),
    matchLevelSplit(days),
    noSelectionFeedback(days),
    rerunJobCount(days),
    columnHealth(days),
    serverStageCounts(days),
    distanceBuckets(days),
  ]);

  const clientByName: Record<string, number> = {};
  for (const stage of clientStages) clientByName[stage.event_name] = stage.events;

  await audit(c, "review_product_metrics", {});
  return c.json({
    windowDays: days,
    since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    funnel: toFunnel(funnelRow),
    jobsFailed: funnelRow.jobs_failed,
    clientStages: clientStages.map((stage) => ({
      event: stage.event_name,
      events: stage.events,
      installations: stage.installations,
    })),
    cohorts: toCohorts(cohortRow),
    dropoff: toDropoff(signals, levels, feedback, rerunJobs),
    /**
     * 지표를 믿어도 되는지부터 보여 준다. 2026-09-13에 `rerank_score`가 전부 비어
     * 있는 것을 눈으로 찾느라 한참 걸렸는데, 그 사실이 화면에 있었으면 바로 끝났다.
     */
    instrumentation: {
      columns: toColumnHealth(columns),
      stageGaps: toStageGaps(serverStages, clientByName),
      distanceBuckets: toDistanceBuckets(buckets),
    },
  });
});

/**
 * GET /v1/admin/review/installations — 설치 명부.
 *
 * 아래 작업 기록 조회는 설치 id를 이미 알아야 쓴다. id를 처음 얻을 길이 S3 prefix를
 * 훑는 것뿐이었는데, 어떤 설치가 있는지 알자고 사용자 원본 이미지 버킷을 여는 것은
 * 접근 범위가 과하다. 최근 접속 순으로 명부를 준다.
 *
 * Job 수·실패 수를 함께 실어 "누구를 열어 볼지"를 이 목록에서 정할 수 있게 한다.
 * 여기서 한 번 더 좁히지 않으면 운영자가 설치를 하나씩 열어 보게 된다.
 */
adminRoutes.get("/review/installations", async (c) => {
  const parsed = parseRosterQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
    activeOnly: c.req.query("activeOnly"),
  });
  if (!parsed.ok) {
    return c.json(errorEnvelope("INVALID_INPUT", parsed.message, c.get("requestId")), 400);
  }
  const rows = await listInstallations(parsed.query);
  await audit(c, "review_installation_list", {});
  return c.json(toRosterPage(rows, parsed.query.limit));
});

/**
 * GET /v1/admin/review/installations/:id/jobs — 설치 하나의 작업 기록.
 *
 * 이 목록이 없으면 아래 `/review/jobs/:id`를 쓰기 위해 jobId를 이미 알고 있어야 한다.
 * RDS는 isolated 서브넷이라 직접 질의할 수 없으므로, jobId를 모르는 운영자에게 남는
 * 길은 컨테이너 로그·디스코드 알림·S3 prefix를 뒤지는 것뿐이었다. 어떤 설치가 무엇을
 * 돌렸고 무엇이 실패했는지 보려고 원본 이미지 버킷을 여는 것은 접근 범위가 과하다.
 *
 * 응답의 items는 사용자용 `GET /v1/analysis/jobs`와 **같은 모양**이다(`listJobHistory`를
 * 그대로 쓴다). 검토자가 사용자와 다른 화면을 보면 "사용자에게 지금 뭐가 보이나"를
 * 판단할 수 없다. 두 가지만 알아 두면 된다.
 *
 * - `thumbnailUrl`은 설치 토큰이 필요한 경로다. 관리자 토큰으로는 열리지 않는다.
 * - 원본 러프는 목록에 싣지 않는다. `inputAvailable`이 true인 Job을 아래 상세로 열면
 *   5분짜리 서명 URL이 나온다. 20건에 서명 URL을 달면 한 번의 조회가 그 설치의 사진
 *   전부를 한꺼번에 꺼내는 열쇠가 된다.
 */
adminRoutes.get("/review/installations/:id/jobs", async (c) => {
  const installationId = c.req.param("id");
  if (!isInstallationId(installationId)) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "installationId 형식이 아닙니다.", c.get("requestId")),
      400,
    );
  }
  const parsed = parseHistoryQuery({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
    status: c.req.query("status"),
  });
  if (!parsed.ok) {
    return c.json(errorEnvelope("INVALID_INPUT", parsed.message, c.get("requestId")), 400);
  }

  // 없는 설치와 "기록이 0건인 설치"를 구분한다. 빈 배열만 돌려주면 운영자는 id를 잘못
  // 옮겨 적은 것인지 정말 아무것도 안 돌린 것인지 알 수 없다.
  const installation = await getInstallationSummary(installationId);
  if (!installation) {
    return c.json(errorEnvelope("NOT_FOUND", "unknown installationId", c.get("requestId")), 404);
  }

  const rows = await listJobHistory(installationId, parsed.query);
  await audit(c, "review_installation_jobs", { installationId });
  return c.json({ installation, ...toHistoryPage(rows, parsed.query.limit) });
});

adminRoutes.get("/review/jobs/:id", async (c) => {
  const jobId = c.req.param("id");
  const job = await queryOne<{
    id: string;
    status: string;
    created_at: string;
    input_s3_key: string | null;
    inference_metadata_json: string | null;
  }>(
    `SELECT id, status, created_at, input_s3_key, inference_metadata_json
     FROM jobs WHERE id = $1 AND installation_id IS NOT NULL`,
    [jobId],
  );
  if (!job) return c.json(errorEnvelope("NOT_FOUND", "unknown jobId", c.get("requestId")), 404);

  const [people, candidates, selections, feedback, refinedRows] = await Promise.all([
    query("SELECT * FROM analysis_people WHERE job_id = $1 ORDER BY person_index", [jobId]),
    query(
      "SELECT * FROM analysis_candidates WHERE job_id = $1 ORDER BY person_index, rank",
      [jobId],
    ),
    query("SELECT * FROM confirmed_selections WHERE job_id = $1 ORDER BY person_index", [jobId]),
    queryOne<{ reason: string }>("SELECT reason FROM job_feedback WHERE job_id = $1", [jobId]),
    query<{
      person_index: number;
      candidate_id: string;
      pose_id: string;
      refined: boolean;
      reason: string;
      object_key: string | null;
      thumbnail_key: string | null;
      limbs_json: string;
      created_at: string;
    }>(
      `SELECT person_index, candidate_id, pose_id, refined, reason, object_key,
              thumbnail_key, limbs_json, created_at
       FROM refined_artifacts WHERE job_id = $1 ORDER BY person_index, candidate_id`,
      [jobId],
    ),
  ]);

  /**
   * refine 산출물은 키만 DB에 있고 본체는 betaData 버킷에 있다. 검토 화면이 바로
   * 볼 수 있게 서명해 내려보낸다.
   *
   * `refined=false`인 행도 뺴지 않는다 — 왜 조정하지 않았는지(`reason`)가 조정 결과
   * 만큼이나 중요하다. 그 경우 키가 비어 URL은 null이 된다.
   */
  const refined = await Promise.all(
    refinedRows.map(async (row) => ({
      personIndex: row.person_index,
      candidateId: row.candidate_id,
      poseId: row.pose_id,
      refined: row.refined,
      reason: row.reason,
      limbs: JSON.parse(row.limbs_json || "[]"),
      createdAt: row.created_at,
      bvhUrl: row.object_key ? await signedInputUrl(row.object_key) : null,
      thumbnailUrl: row.thumbnail_key ? await signedInputUrl(row.thumbnail_key) : null,
    })),
  );

  await audit(c, "review_job", { jobId });
  return c.json({
    jobId: job.id,
    status: job.status,
    createdAt: job.created_at,
    inputUrl: job.input_s3_key ? await signedInputUrl(job.input_s3_key) : null,
    inputUrlExpiresInSeconds: job.input_s3_key ? 300 : null,
    inferenceMetadata: job.inference_metadata_json
      ? JSON.parse(job.inference_metadata_json)
      : null,
    people,
    candidates,
    selections,
    refined,
    feedback: feedback?.reason ?? null,
  });
});

/**
 * GET /v1/admin/review/pose-candidates/:id/thumbnail?view=front — 관리자용 썸네일.
 *
 * 사용자 경로(`/v1/pose-candidates/:id/thumbnail`)는 설치 토큰을 요구하므로 검토자가
 * 열 수 없다. 후보 그림을 못 보면 "이 결과가 말이 되는가"를 판단할 수 없어 상세
 * 화면의 값이 절반으로 준다.
 *
 * 프록시 본체는 사용자 경로와 같은 `getPoseThumbnail`이다. 포즈 라이브러리는 사용자
 * 데이터가 아니라 공용 자산이라 서명 URL을 만들 것도 없다.
 */
adminRoutes.get("/review/pose-candidates/:id/thumbnail", async (c) => {
  const view = c.req.query("view");
  if (!view) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "view 쿼리 파라미터가 필요합니다.", c.get("requestId")),
      400,
    );
  }
  const upstream = await getPoseThumbnail(c.req.param("id"), view, c.req.header("if-none-match"));
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
    "Cache-Control": upstream.headers.get("Cache-Control") ?? "private, max-age=86400",
  };
  const etag = upstream.headers.get("ETag");
  if (etag) headers["ETag"] = etag;
  if (upstream.status === 304) return new Response(null, { status: 304, headers });
  return new Response(upstream.body, { status: upstream.status, headers });
});
