import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { queryOne } from "../db.js";
import { errorEnvelope } from "../mapping.js";

export async function canReviewJob(
  jobId: string,
  asset: boolean,
): Promise<boolean> {
  return Boolean(
    await queryOne(
      `SELECT id FROM quality_review_jobs WHERE id=$1
       AND ($2::boolean IS FALSE OR COALESCE(input_stored_at, created_at)::timestamptz > now() - interval '90 days')`,
      [jobId, asset],
    ),
  );
}

/** Every job-specific endpoint, including direct guesses, derived files and slow conversions. */
export function qualityReviewGuard(
  check = canReviewJob,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const target = /\/review\/jobs\/([^/]+)(\/.*)?$/.exec(c.req.path);
    const allowed = () =>
      !target || check(decodeURIComponent(target[1]), Boolean(target[2]));
    if (!(await allowed()))
      return c.json(
        errorEnvelope("NOT_FOUND", "not found", c.get("requestId")),
        404,
      );
    await next();
    // Hono has finalized the downstream response: replace it explicitly after next().
    if (!(await allowed()))
      c.res = c.json(
        errorEnvelope("NOT_FOUND", "not found", c.get("requestId")),
        404,
      );
  };
}
