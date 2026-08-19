import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { execute, query, queryOne } from "../db.js";
import type { AppEnv } from "../env.js";
import { signedInputUrl } from "../inputStorage.js";
import { getAnalysisFlag, setAnalysisEnabled } from "../limits/flags.js";
import { dailyWindow } from "../limits/policy.js";
import { currentUsage } from "../limits/store.js";
import { errorEnvelope } from "../mapping.js";
import { health } from "../inference.js";
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

function validAdminToken(value: string): boolean {
  if (!config.betaReviewAdminToken || !value) return false;
  const actual = createHash("sha256").update(value).digest();
  const expected = createHash("sha256").update(config.betaReviewAdminToken).digest();
  return timingSafeEqual(actual, expected);
}

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
  if (!validAdminToken(supplied)) {
    // 401이 아니라 404다 — 관리자 API가 존재한다는 사실 자체를 노출하지 않는다.
    return c.json(errorEnvelope("NOT_FOUND", "not found", c.get("requestId")), 404);
  }
  await next();
});

async function audit(
  c: Context<AppEnv>,
  action: string,
  jobId: string | null,
): Promise<void> {
  await execute(
    `INSERT INTO admin_access_audit
      (audit_id, reviewer, action, job_id, request_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      `audit_${randomUUID()}`,
      "beta-reviewer",
      action,
      jobId,
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
  await audit(c, body.enabled ? "resume_analysis" : "pause_analysis", null);
  return c.json({
    analysisEnabled: flag.enabled,
    reason: flag.reason,
    updatedAt: flag.updatedAt,
    propagationSeconds: 5,
  });
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

  const [people, candidates, selections, feedback] = await Promise.all([
    query("SELECT * FROM analysis_people WHERE job_id = $1 ORDER BY person_index", [jobId]),
    query(
      "SELECT * FROM analysis_candidates WHERE job_id = $1 ORDER BY person_index, rank",
      [jobId],
    ),
    query("SELECT * FROM confirmed_selections WHERE job_id = $1 ORDER BY person_index", [jobId]),
    queryOne<{ reason: string }>("SELECT reason FROM job_feedback WHERE job_id = $1", [jobId]),
  ]);
  await audit(c, "review_job", jobId);
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
    feedback: feedback?.reason ?? null,
  });
});
