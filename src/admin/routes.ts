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

export const adminRoutes = new Hono<AppEnv>();

function validAdminToken(value: string): boolean {
  if (!config.betaReviewAdminToken || !value) return false;
  const actual = createHash("sha256").update(value).digest();
  const expected = createHash("sha256").update(config.betaReviewAdminToken).digest();
  return timingSafeEqual(actual, expected);
}

adminRoutes.use("*", async (c, next) => {
  if (!validAdminToken(c.req.header("X-Beta-Admin-Token") ?? "")) {
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
