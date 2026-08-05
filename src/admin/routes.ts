import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "../config.js";
import { execute, query, queryOne } from "../db.js";
import type { AppEnv } from "../env.js";
import { signedInputUrl } from "../inputStorage.js";
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
  await execute(
    `INSERT INTO admin_access_audit
      (audit_id, reviewer, action, job_id, request_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      `audit_${randomUUID()}`,
      "beta-reviewer",
      "review_job",
      jobId,
      c.get("requestId"),
      new Date().toISOString(),
    ],
  );
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
