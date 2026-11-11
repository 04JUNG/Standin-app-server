import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "../db.js";

type Executor = Pick<Pool | PoolClient, "query">;
export function accessCodeHash(code: string): string | null {
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^STDN[A-F0-9]{32}$/.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export async function readAccessRegistration(installationId: string, db: Executor = pool) {
  const result = await db.query<{ created_at: string; registered: boolean; active: boolean }>(
    `SELECT i.created_at,
      EXISTS(SELECT 1 FROM supporter_access_codes c WHERE c.installation_id=i.id) AS registered,
      EXISTS(SELECT 1 FROM supporter_access_codes c WHERE c.installation_id=i.id AND c.revoked_at IS NULL) AS active
     FROM installations i WHERE i.id=$1`,
    [installationId],
  );
  return result.rows[0] ?? { created_at: null, registered: false, active: false };
}

export async function consumeAccessAttempt(installationId: string, db: Executor = pool) {
  const result = await db.query(`
    INSERT INTO supporter_access_attempts(installation_id,started_at,attempts) VALUES($1,now(),1)
    ON CONFLICT(installation_id) DO UPDATE SET
      attempts=CASE WHEN supporter_access_attempts.started_at<=now()-interval '10 minutes'
                    THEN 1 ELSE supporter_access_attempts.attempts+1 END,
      started_at=CASE WHEN supporter_access_attempts.started_at<=now()-interval '10 minutes'
                      THEN now() ELSE supporter_access_attempts.started_at END
    WHERE supporter_access_attempts.started_at<=now()-interval '10 minutes'
       OR supporter_access_attempts.attempts<10 RETURNING installation_id`, [installationId]);
  return result.rows.length > 0;
}

export async function redeemAccessCode(installationId: string, code: string, db: Executor = pool) {
  const digest = accessCodeHash(code);
  if (!digest) return false;
  const result = await db.query(`
    UPDATE supporter_access_codes SET installation_id=$1,redeemed_at=coalesce(redeemed_at,now())
    WHERE code_hash=$2 AND revoked_at IS NULL AND (installation_id IS NULL OR installation_id=$1)
    RETURNING id`, [installationId, digest]);
  return result.rows.length > 0;
}
