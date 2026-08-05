import { randomUUID } from "node:crypto";
import { execute, queryOne, transaction } from "../db.js";

export const CLIENT_EVENT_PROPERTIES: Record<string, readonly string[]> = {
  app_started: ["appVersion", "osName", "osVersion", "architecture", "locale"],
  input_confirmed: ["source", "width", "height", "size", "mime", "surface"],
  results_viewed: ["surface", "peopleCount", "candidateCount"],
  candidate_selected: [
    "personIndex",
    "candidateId",
    "previousCandidateId",
    "rank",
    "surface",
  ],
  selection_confirmed: ["selectionCount"],
  // 아래는 실패·이탈 계열. 성공 경로만 있으면 "왜 안 쓰는가"에 답할 수 없다.
  // 값은 전부 코드형 열거라 자유 텍스트가 섞이지 않는다.
  analysis_failed: ["reason", "surface", "elapsedMs"],
  rerun_requested: ["surface", "selectedCount", "peopleCount"],
  export_completed: ["fileCount", "surface"],
  export_failed: ["code", "surface"],
  capture_failed: ["code", "surface"],
} as const;

export function sanitizeEventProperties(
  eventName: string,
  input: unknown,
): Record<string, string | number | boolean | null> | null {
  const allowed = CLIENT_EVENT_PROPERTIES[eventName];
  if (!allowed || typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const value = source[key];
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 128)
    ) {
      output[key] = value;
    }
  }
  return output;
}

export async function insertClientEvent(event: {
  eventId: string;
  installationId: string;
  sequence: number;
  name: string;
  occurredAt: string;
  jobId: string | null;
  properties: Record<string, unknown>;
}): Promise<boolean> {
  const count = await execute(
    `INSERT INTO analytics_events
      (event_id, installation_id, sequence_number, event_name, occurred_at, received_at,
       job_id, properties_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.eventId,
      event.installationId,
      event.sequence,
      event.name,
      event.occurredAt,
      new Date().toISOString(),
      event.jobId,
      JSON.stringify(event.properties),
    ],
  );
  return count === 1;
}

export async function eventJobBelongsToInstallation(
  jobId: string,
  installationId: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM jobs WHERE id = $1 AND installation_id = $2",
    [jobId, installationId],
  );
  return Boolean(row);
}

interface CandidateRow {
  candidate_id: string;
  rank: number;
}

export async function confirmSelections(
  installationId: string,
  jobId: string,
  selections: Array<{ personIndex: number; candidateId: string }>,
): Promise<boolean> {
  return transaction(async (client) => {
    const owner = await client.query<{ id: string }>(
      "SELECT id FROM jobs WHERE id = $1 AND installation_id = $2",
      [jobId, installationId],
    );
    if (owner.rowCount !== 1) return false;
    const confirmedAt = new Date().toISOString();
    const validated: Array<{ personIndex: number; candidateId: string; rank: number }> = [];
    for (const selection of selections) {
      const candidate = await client.query<CandidateRow>(
        `SELECT candidate_id, rank FROM analysis_candidates
         WHERE job_id = $1 AND person_index = $2 AND candidate_id = $3`,
        [jobId, selection.personIndex, selection.candidateId],
      );
      const row = candidate.rows[0];
      if (!row) return false;
      validated.push({
        personIndex: selection.personIndex,
        candidateId: row.candidate_id,
        rank: row.rank,
      });
    }
    for (const selection of validated) {
      await client.query(
        `INSERT INTO confirmed_selections
          (job_id, person_index, installation_id, candidate_id, rank, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (job_id, person_index) DO UPDATE
         SET candidate_id = EXCLUDED.candidate_id, rank = EXCLUDED.rank,
             installation_id = EXCLUDED.installation_id, confirmed_at = EXCLUDED.confirmed_at`,
        [
          jobId,
          selection.personIndex,
          installationId,
          selection.candidateId,
          selection.rank,
          confirmedAt,
        ],
      );
    }
    return true;
  });
}

export async function saveFeedback(
  installationId: string,
  jobId: string,
  reason: string,
): Promise<boolean> {
  const job = await queryOne<{ id: string }>(
    "SELECT id FROM jobs WHERE id = $1 AND installation_id = $2",
    [jobId, installationId],
  );
  if (!job) return false;
  await execute(
    `INSERT INTO job_feedback (job_id, installation_id, reason, submitted_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (job_id) DO UPDATE
     SET installation_id = EXCLUDED.installation_id, reason = EXCLUDED.reason,
         submitted_at = EXCLUDED.submitted_at`,
    [jobId, installationId, reason, new Date().toISOString()],
  );
  return true;
}

export async function recordExport(event: {
  installationId: string;
  jobId: string | null;
  personIndex: number | null;
  candidateId: string;
  status: "requested" | "completed" | "failed";
  errorCode?: string;
  /** 실제로 내려간 것이 조정본인지 베이스인지(BFF-06). requested 단계에서는 아직 미정. */
  variant?: "refined" | "base";
  /** 조정본을 쓰려다 베이스로 내려온 사유. 정상 베이스와 구분하기 위한 값이다. */
  fallbackReason?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO export_events
      (event_id, installation_id, job_id, person_index, candidate_id, status, occurred_at,
       error_code, variant, fallback_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      `export_${randomUUID()}`,
      event.installationId,
      event.jobId,
      event.personIndex,
      event.candidateId,
      event.status,
      new Date().toISOString(),
      event.errorCode ?? null,
      event.variant ?? null,
      event.fallbackReason ?? null,
    ],
  );
}

export async function validateExportCandidate(
  installationId: string,
  jobId: string,
  personIndex: number,
  candidateId: string,
): Promise<boolean> {
  const row = await queryOne<{ candidate_id: string }>(
    `SELECT c.candidate_id
     FROM analysis_candidates c
     JOIN jobs j ON j.id = c.job_id
     WHERE c.job_id = $1 AND c.person_index = $2 AND c.candidate_id = $3
       AND j.installation_id = $4`,
    [jobId, personIndex, candidateId, installationId],
  );
  return Boolean(row);
}
