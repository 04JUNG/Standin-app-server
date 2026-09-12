import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { execute, query, queryOne, transaction } from "../db.js";
import type { RosterQuery, RosterRow } from "../admin/installationList.js";

export interface InstallationMetadata {
  consentVersion: string;
  consentedAt: string;
  appVersion: string;
  osName: string;
  osVersion: string;
  architecture: string;
  locale: string;
}

interface InstallationRow {
  id: string;
  token_hash: string;
  consent_version: string;
  revoked_at: string | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createInstallation(metadata: InstallationMetadata): Promise<{
  installationId: string;
  deviceToken: string;
}> {
  const installationId = `inst_${randomUUID()}`;
  const deviceToken = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO installations
      (id, token_hash, consent_version, consented_at, created_at, last_seen_at,
       app_version, os_name, os_version, architecture, locale)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10)`,
    [
      installationId,
      tokenHash(deviceToken),
      metadata.consentVersion,
      metadata.consentedAt,
      now,
      metadata.appVersion,
      metadata.osName,
      metadata.osVersion,
      metadata.architecture,
      metadata.locale,
    ],
  );
  return { installationId, deviceToken };
}

export async function authenticateInstallation(
  installationId: string,
  deviceToken: string,
): Promise<{ id: string; consentVersion: string } | null> {
  const row = await queryOne<InstallationRow>(
    "SELECT id, token_hash, consent_version, revoked_at FROM installations WHERE id = $1",
    [installationId],
  );
  if (!row || row.revoked_at) return null;
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(tokenHash(deviceToken), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await execute("UPDATE installations SET last_seen_at = $2 WHERE id = $1", [
    installationId,
    new Date().toISOString(),
  ]);
  return { id: row.id, consentVersion: row.consent_version };
}

async function deleteRows(client: PoolClient, installationId: string): Promise<void> {
  await client.query(
    "DELETE FROM export_events WHERE installation_id = $1",
    [installationId],
  );
  await client.query(
    "DELETE FROM job_feedback WHERE installation_id = $1",
    [installationId],
  );
  await client.query(
    "DELETE FROM confirmed_selections WHERE installation_id = $1",
    [installationId],
  );
  await client.query(
    "DELETE FROM analytics_events WHERE installation_id = $1",
    [installationId],
  );
  await client.query(
    "DELETE FROM admin_access_audit WHERE job_id IN (SELECT id FROM jobs WHERE installation_id = $1)",
    [installationId],
  );
  await client.query(
    "DELETE FROM analysis_candidates WHERE job_id IN (SELECT id FROM jobs WHERE installation_id = $1)",
    [installationId],
  );
  await client.query(
    "DELETE FROM analysis_people WHERE job_id IN (SELECT id FROM jobs WHERE installation_id = $1)",
    [installationId],
  );
  await client.query("DELETE FROM jobs WHERE installation_id = $1", [installationId]);
}

/**
 * 관리자 검토 화면이 목록 위에 띄우는 설치 요약.
 *
 * 토큰 해시는 뽑지 않는다 — 검토자에게 필요한 것은 "어떤 클라이언트가, 언제까지
 * 살아 있었나"뿐이고, 해시는 있어 봐야 재현에 쓸 수 없으면서 유출 표면만 넓힌다.
 * 탈퇴·철회한 설치도 돌려준다. `revoked_at`이 찍힌 설치의 남은 Job이야말로
 * 삭제 스윕이 제대로 돌았는지 확인하는 자리이기 때문이다.
 */
export interface InstallationSummary {
  installationId: string;
  createdAt: string;
  lastSeenAt: string;
  appVersion: string;
  osName: string;
  osVersion: string;
  locale: string;
  consentVersion: string;
  revokedAt: string | null;
  deletionRequestedAt: string | null;
}

/**
 * 설치 명부. 최근 접속 순으로 한 페이지씩 준다.
 *
 * Job 집계는 **페이지에 실제로 실린 행에 대해서만** LATERAL로 센다. 전체를 GROUP BY로
 * 말아 두고 자르면 설치가 늘수록 한 페이지를 여는 비용이 전체 Job 수에 비례한다.
 *
 * 철회·삭제 요청 설치도 기본으로 포함한다 — 그 설치의 남은 기록이야말로 삭제 스윕이
 * 제대로 돌았는지 확인하는 자리다. 가릴 때는 `activeOnly=true`를 쓴다.
 */
export async function listInstallations({
  limit,
  cursor,
  activeOnly,
}: RosterQuery): Promise<RosterRow[]> {
  return query<RosterRow>(
    `SELECT i.id, i.created_at, i.last_seen_at, i.app_version, i.os_name, i.os_version,
            i.locale, i.consent_version, i.revoked_at, i.deletion_requested_at,
            j.job_count, j.failed_count, j.last_job_at
     FROM installations i
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS job_count,
              count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              max(created_at) AS last_job_at
       FROM jobs WHERE jobs.installation_id = i.id
     ) j ON TRUE
     WHERE ($1::boolean IS NOT TRUE
            OR (i.revoked_at IS NULL AND i.deletion_requested_at IS NULL))
       AND ($2::text IS NULL OR (i.last_seen_at, i.id) < ($2, $3))
     ORDER BY i.last_seen_at DESC, i.id DESC
     LIMIT $4`,
    [activeOnly, cursor?.lastSeenAt ?? null, cursor?.id ?? null, limit + 1],
  );
}

export async function getInstallationSummary(
  installationId: string,
): Promise<InstallationSummary | null> {
  const row = await queryOne<{
    id: string;
    created_at: string;
    last_seen_at: string;
    app_version: string;
    os_name: string;
    os_version: string;
    locale: string;
    consent_version: string;
    revoked_at: string | null;
    deletion_requested_at: string | null;
  }>(
    `SELECT id, created_at, last_seen_at, app_version, os_name, os_version,
            locale, consent_version, revoked_at, deletion_requested_at
     FROM installations WHERE id = $1`,
    [installationId],
  );
  if (!row) return null;
  return {
    installationId: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    appVersion: row.app_version,
    osName: row.os_name,
    osVersion: row.os_version,
    locale: row.locale,
    consentVersion: row.consent_version,
    revokedAt: row.revoked_at,
    deletionRequestedAt: row.deletion_requested_at,
  };
}

export async function revokeAndDeleteInstallationData(installationId: string): Promise<void> {
  await transaction(async (client) => {
    await deleteRows(client, installationId);
    // Removing the installation row invalidates the token and erases the final link.
    await client.query("DELETE FROM installations WHERE id = $1", [installationId]);
  });
}
