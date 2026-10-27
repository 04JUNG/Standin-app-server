import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { deleteJobs } from "../retention.js";

export const QUALITY_CONSENT_VERSION = "2026-10-19";
export interface QualityConsentInput {
  version: typeof QUALITY_CONSENT_VERSION;
  personalData: boolean;
  contentLicense: boolean;
}
export interface QualityConsent extends QualityConsentInput {
  consentId: string | null;
  grantedAt: string | null;
}
type Database = Pick<Pool | PoolClient, "query">;

export function parseQualityConsent(
  value: unknown,
): QualityConsentInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return v.version === QUALITY_CONSENT_VERSION &&
    typeof v.personalData === "boolean" &&
    typeof v.contentLicense === "boolean"
    ? {
        version: QUALITY_CONSENT_VERSION,
        personalData: v.personalData,
        contentLicense: v.contentLicense,
      }
    : null;
}

export async function readQualityConsent(
  db: Database,
  installationId: string,
): Promise<QualityConsent> {
  const { rows } = await db.query(
    `SELECT quality_personal_data, quality_content_license, quality_consent_id, quality_granted_at
     FROM installations WHERE id = $1`,
    [installationId],
  );
  const row = rows[0];
  return {
    version: QUALITY_CONSENT_VERSION,
    personalData: row?.quality_personal_data === true,
    contentLicense: row?.quality_content_license === true,
    consentId: row?.quality_consent_id ?? null,
    grantedAt: row?.quality_granted_at ?? null,
  };
}

/** Caller owns the transaction. Lock before jobs, matching all quality writers/job creation. */
export async function writeQualityConsent(
  db: Database,
  installationId: string,
  input: QualityConsentInput,
): Promise<QualityConsent> {
  const locked = await db.query(
    "SELECT id FROM installations WHERE id = $1 FOR UPDATE",
    [installationId],
  );
  if (!locked.rowCount) throw new Error("installation no longer exists");
  const previous = await readQualityConsent(db, installationId);
  if (
    previous.personalData === input.personalData &&
    previous.contentLicense === input.contentLicense
  )
    return previous;
  const enabled = input.personalData && input.contentLicense;
  const consentId = enabled ? randomUUID() : null;
  const now = new Date().toISOString();
  await db.query(
    `UPDATE installations SET quality_personal_data=$2, quality_content_license=$3,
       quality_consent_id=$4, quality_granted_at=$5 WHERE id=$1`,
    [
      installationId,
      input.personalData,
      input.contentLicense,
      consentId,
      enabled ? now : null,
    ],
  );
  // Shared originals/results/selections are still needed for the user's analysis/history/export.
  // Remove their review authorization and quality-only records, without extending their lifetime.
  await db.query(
    "UPDATE jobs SET quality_consent_id = NULL, cut_summary_json = NULL WHERE installation_id = $1",
    [installationId],
  );
  await db.query(
    `UPDATE analysis_people SET raw_scores_json=NULL, person_tags_json=NULL, output_scope_json=NULL,
    rank_distance=NULL, distance_metric=NULL, search_stability=NULL, confidence_threshold=NULL
    WHERE job_id IN (SELECT id FROM jobs WHERE installation_id=$1)`,
    [installationId],
  );
  for (const table of ["analytics_events", "export_events", "job_feedback"]) {
    await db.query(`DELETE FROM ${table} WHERE installation_id = $1`, [
      installationId,
    ]);
  }
  // Once review ends, only the unexpired basic-service purpose can retain a job.
  await deleteJobs(db, {
    ids: "SELECT id FROM jobs WHERE installation_id=$1 AND created_at::timestamptz <= $2::timestamptz",
    params: [
      installationId,
      new Date(Date.parse(now) - 90 * 86_400_000).toISOString(),
    ],
  });
  const subject = createHash("sha256").update(installationId).digest("hex");
  await db.query(
    "UPDATE quality_consent_receipts SET ended_at=$2 WHERE subject_hash=$1 AND ended_at IS NULL",
    [subject, now],
  );
  await db.query(
    `INSERT INTO quality_consent_receipts
       (receipt_id,subject_hash,version,personal_data,content_license,recorded_at,ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      subject,
      input.version,
      input.personalData,
      input.contentLicense,
      now,
      enabled ? null : now,
    ],
  );
  return { ...input, consentId, grantedAt: enabled ? now : null };
}

/** Held until commit so withdrawal cannot be followed by a late quality write. */
export async function lockQualityConsent(
  db: Database,
  installationId: string,
  consentId?: string | null,
  jobId?: string | null,
): Promise<{ consentId: string; grantedAt: string } | null> {
  const { rows } = await db.query(
    `SELECT quality_consent_id, quality_granted_at FROM installations
     WHERE id=$1 AND quality_personal_data AND quality_content_license
       AND quality_consent_id IS NOT NULL AND revoked_at IS NULL AND deletion_requested_at IS NULL
     FOR SHARE`,
    [installationId],
  );
  const row = rows[0];
  if (!row || (consentId !== undefined && row.quality_consent_id !== consentId))
    return null;
  if (jobId) {
    const job = await db.query(
      `SELECT id FROM jobs WHERE id=$1 AND installation_id=$2 AND quality_consent_id=$3
         AND created_at::timestamptz > now() - interval '365 days' FOR SHARE`,
      [jobId, installationId, row.quality_consent_id],
    );
    if (!job.rowCount) return null;
  }
  return {
    consentId: row.quality_consent_id,
    grantedAt: row.quality_granted_at,
  };
}

/** "개발자 제외" 스위치(service_flags). 행이 없으면 켜진 것으로 본다 — 표시해 둔 개발자는 기본으로 뺀다. */
export const HIDE_INTERNAL_FLAG = "hide_internal_installations";

/**
 * installations 행이 개발자 설치로 표시돼 있고 스위치가 켜져 있으면 거짓. 뷰 안에서 쓴다.
 * 표가 작아(팀원 몇 명) 행마다 EXISTS를 돌려도 비용이 없다.
 */
const NOT_HIDDEN_INTERNAL = `(
      NOT EXISTS (SELECT 1 FROM internal_installations x WHERE x.id = installations.id)
      OR coalesce((SELECT value FROM service_flags WHERE key = '${HIDE_INTERNAL_FLAG}'), 'true') <> 'true')`;

/**
 * 관리자 열람 범위를 정하는 뷰. 관리자 SQL은 모두 이 뷰만 읽는다.
 *
 * withoutConsent(`config.reviewWithoutQualityConsent`, 환경 변수로 켜고 끔)이면 동의 조건을 빼고
 * 철회·삭제 요청만 거른다. 뷰는 배포마다 다시 만들어지므로 스위치를 끄고 재배포하면
 * 원래 범위로 돌아간다.
 *
 * 개발자 설치(`internal_installations`)는 "개발자 제외" 스위치가 켜져 있으면 어느 범위든 뺀다.
 */
export function qualityReviewViews(withoutConsent: boolean): string {
  if (withoutConsent) {
    return `
  CREATE OR REPLACE VIEW quality_review_installations AS
    SELECT * FROM installations WHERE revoked_at IS NULL AND deletion_requested_at IS NULL
      AND ${NOT_HIDDEN_INTERNAL};
  CREATE OR REPLACE VIEW quality_review_jobs AS
    SELECT j.* FROM jobs j JOIN quality_review_installations i ON i.id=j.installation_id
    WHERE j.created_at::timestamptz > now() - interval '365 days';
  CREATE OR REPLACE VIEW quality_review_analytics_events AS
    SELECT e.* FROM analytics_events e JOIN quality_review_installations i ON i.id=e.installation_id
    WHERE e.occurred_at::timestamptz > now() - interval '365 days'
      AND (e.job_id IS NULL OR EXISTS (SELECT 1 FROM quality_review_jobs j WHERE j.id=e.job_id));
  ${JOB_SCOPED_VIEWS}`;
  }
  return `
  CREATE OR REPLACE VIEW quality_review_installations AS
    SELECT * FROM installations WHERE quality_personal_data AND quality_content_license
      AND quality_consent_id IS NOT NULL AND revoked_at IS NULL AND deletion_requested_at IS NULL
      AND ${NOT_HIDDEN_INTERNAL};
  CREATE OR REPLACE VIEW quality_review_jobs AS
    SELECT j.* FROM jobs j JOIN quality_review_installations i ON i.id=j.installation_id
    WHERE j.quality_consent_id=i.quality_consent_id
      AND j.created_at::timestamptz > now() - interval '365 days';
  CREATE OR REPLACE VIEW quality_review_analytics_events AS
    SELECT e.* FROM analytics_events e JOIN quality_review_installations i ON i.id=e.installation_id
    WHERE e.quality_consent_id=i.quality_consent_id
      AND e.occurred_at::timestamptz > now() - interval '365 days'
      AND (e.job_id IS NULL OR EXISTS (SELECT 1 FROM quality_review_jobs j WHERE j.id=e.job_id));
  ${JOB_SCOPED_VIEWS}`;
}

/** Job에 딸린 표는 어느 범위든 quality_review_jobs를 따라간다. */
const JOB_SCOPED_VIEWS = [
  "analysis_people",
  "analysis_candidates",
  "confirmed_selections",
  "job_feedback",
  "export_events",
  "refined_artifacts",
]
  .map(
    (table) => `
  CREATE OR REPLACE VIEW quality_review_${table} AS
    SELECT t.* FROM ${table} t JOIN quality_review_jobs j ON j.id=t.job_id;
  `,
  )
  .join("\n");

/**
 * 집계 전용 뷰. 품질 동의와 상관없이 "몇 곳이 몇 건 돌렸나"를 세는 데만 쓴다.
 *
 * 열이 세는 데 필요한 것뿐이다 — 원본 키·결과·작업 상세가 없어 이 뷰로는 내용을 볼 수 없다.
 * 철회·삭제 요청 설치는 뺀다. 개별 설치를 화면에 늘어놓는 SQL은 이 뷰를 쓰지 않는다.
 * "개발자 제외"가 켜져 있으면 개발자 설치도 세지 않는다.
 */
const OPS_COUNT_VIEWS = `
  CREATE OR REPLACE VIEW ops_count_installations AS
    SELECT id, created_at, last_seen_at FROM installations
    WHERE revoked_at IS NULL AND deletion_requested_at IS NULL
      AND ${NOT_HIDDEN_INTERNAL};
  CREATE OR REPLACE VIEW ops_count_jobs AS
    SELECT j.id, j.installation_id, j.status, j.created_at
    FROM jobs j JOIN ops_count_installations i ON i.id = j.installation_id;
`;

export const QUALITY_CONSENT_SCHEMA = `
  ALTER TABLE installations ADD COLUMN IF NOT EXISTS quality_personal_data BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE installations ADD COLUMN IF NOT EXISTS quality_content_license BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE installations ADD COLUMN IF NOT EXISTS quality_consent_id TEXT;
  ALTER TABLE installations ADD COLUMN IF NOT EXISTS quality_granted_at TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quality_consent_id TEXT;
  ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS quality_consent_id TEXT;

  DELETE FROM analytics_events WHERE quality_consent_id IS NULL;
  DELETE FROM job_feedback f WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=f.job_id AND j.quality_consent_id IS NOT NULL);
  DELETE FROM export_events e WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.job_id AND j.quality_consent_id IS NOT NULL);
  UPDATE analysis_people SET raw_scores_json=NULL, person_tags_json=NULL, output_scope_json=NULL,
    rank_distance=NULL, distance_metric=NULL, search_stability=NULL, confidence_threshold=NULL
    WHERE job_id IN (SELECT id FROM jobs WHERE quality_consent_id IS NULL)
      AND (raw_scores_json IS NOT NULL OR person_tags_json IS NOT NULL OR output_scope_json IS NOT NULL
        OR rank_distance IS NOT NULL OR distance_metric IS NOT NULL OR search_stability IS NOT NULL OR confidence_threshold IS NOT NULL);
  UPDATE jobs SET cut_summary_json=NULL WHERE quality_consent_id IS NULL AND cut_summary_json IS NOT NULL;

  -- Minimal consent evidence, isolated from review data and never exposed by admin review APIs.
  CREATE TABLE IF NOT EXISTS quality_consent_receipts (
    receipt_id TEXT PRIMARY KEY, subject_hash TEXT NOT NULL, version TEXT NOT NULL,
    personal_data BOOLEAN NOT NULL, content_license BOOLEAN NOT NULL,
    recorded_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS quality_receipts_subject ON quality_consent_receipts(subject_hash);

  ${qualityReviewViews(config.reviewWithoutQualityConsent)}
  ${OPS_COUNT_VIEWS}
`;
