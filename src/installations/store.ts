import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { execute, queryOne, transaction } from "../db.js";

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

export async function revokeAndDeleteInstallationData(installationId: string): Promise<void> {
  await transaction(async (client) => {
    await deleteRows(client, installationId);
    // Removing the installation row invalidates the token and erases the final link.
    await client.query("DELETE FROM installations WHERE id = $1", [installationId]);
  });
}
