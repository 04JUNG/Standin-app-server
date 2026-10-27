import { lockQualityConsent } from "../installations/qualityConsent.js";
import { randomUUID } from "node:crypto";
import { queryOne, transaction } from "../db.js";
import type { ExportFormat } from "../types.js";

/**
 * 이벤트 이름 → 저장할 속성 키.
 *
 * ⚠ 이름과 속성은 **엄격함이 다르다.** 모르는 이름은 배치 전체를 400으로 거절하지만(routes.ts),
 * 모르는 속성 키는 `sanitizeEventProperties`가 조용히 버린다. 그래서 속성을 빠뜨리면
 * 아무도 오류를 보지 못한 채 지표만 비어 있게 된다.
 */
export const CLIENT_EVENT_PROPERTIES: Record<string, readonly string[]> = {
  app_started: ["appVersion", "osName", "osVersion", "architecture", "locale"],
  input_confirmed: [
    "source",
    "width",
    "height",
    "size",
    "mime",
    "surface",
    "characterId",
  ],
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
  // characterId·format은 **저장 결과의 성질**이다. 없으면 "FBX를 실제로 쓰는가",
  // "여성 체형을 고르는가"를 지표에서 알 수 없다. 모르는 키는 400이 아니라 조용히
  // 버려지므로(sanitizeEventProperties), 빠져 있어도 아무도 눈치채지 못한다.
  export_completed: ["fileCount", "surface", "format", "characterId"],
  export_failed: ["code", "surface"],
  capture_failed: ["code", "surface"],
  // 자동 업데이트 계열(클라 ADR-011). 업데이터는 실사용에서 검증된 적이 없는 경로라
  // 성공만 세면 "왜 옛 버전에 남아 있는가"에 답할 수 없다.
  //
  // ⚠ 클라이언트보다 **먼저** 배포해야 한다. 여기 없는 이름이 배치에 하나라도 섞이면
  // routes.ts가 배치 전체를 400으로 거절하고, 클라이언트는 4xx를 영구 거절로 보고
  // 배치를 버린다 — 같이 실린 다른 이벤트까지 사라진다.
  update_check: ["trigger", "result"],
  update_installed: ["fromVersion", "toVersion"],
  update_failed: ["phase", "reason"],
} as const;

export const FEATURE_NAMES = ["hand_library", "semantic_search", "body_selection", "body_custom", "history", "capture", "file_input", "clipboard", "analysis", "pose_selection", "export"] as const;
export const FEATURE_ACTIONS = ["exposure", "open", "search_started", "search_completed", "search_failed", "cancelled", "selected", "applied", "adjusted", "reset", "creation_started", "saved", "reused", "failed", "upload_started", "upload_completed", "upload_failed", "preview_started", "preview_completed", "preview_failed"] as const;
const JOURNEY_COMMON = ["telemetryVersion", "sessionId", "appVersion", "surface", "attemptId", "osName", "feature", "errorCategory", "httpStatus", "source", "code", "elapsedMs"];
const ATTRIBUTION = ["usedHandLibrary", "usedBodySelection", "usedBodyCustom", "fromHistory", "fromSemanticSearch"];
for (const name of Object.keys(CLIENT_EVENT_PROPERTIES)) {
  CLIENT_EVENT_PROPERTIES[name] = [...CLIENT_EVENT_PROPERTIES[name], ...JOURNEY_COMMON];
}
for (const name of ["input_started", "input_cancelled", "input_failed", "review_viewed", "preparation_started", "preparation_ready", "preparation_failed", "export_requested", "export_cancelled", "thumbnail_failed", "selection_failed"]) {
  CLIENT_EVENT_PROPERTIES[name] = [...JOURNEY_COMMON, "source", "format", "phase", "code", "elapsedMs", "selectionCount"];
}
CLIENT_EVENT_PROPERTIES.results_viewed = [...CLIENT_EVENT_PROPERTIES.results_viewed, "entryPoint", "inputId", "source", "zeroCandidatePeople", "peopleWithCandidates"];
CLIENT_EVENT_PROPERTIES.input_confirmed = [...CLIENT_EVENT_PROPERTIES.input_confirmed, "inputAttemptId", "inputId"];
CLIENT_EVENT_PROPERTIES.export_requested = [...CLIENT_EVENT_PROPERTIES.export_requested, "trigger"];
CLIENT_EVENT_PROPERTIES.thumbnail_failed = [...CLIENT_EVENT_PROPERTIES.thumbnail_failed, "candidateId"];
CLIENT_EVENT_PROPERTIES.export_completed = [...CLIENT_EVENT_PROPERTIES.export_completed, "nativeDiskWrite", "elapsedMs", "writingElapsedMs", "phase"];
CLIENT_EVENT_PROPERTIES.export_failed = [...CLIENT_EVENT_PROPERTIES.export_failed, "elapsedMs", "phase"];

CLIENT_EVENT_PROPERTIES.feature_action = [...JOURNEY_COMMON, "action", "resultCount", "selectionCount", "personIndex", "rank", "format", "entryPoint", "bodyKind", "searchOrdinal", "inputId", "phase"];
CLIENT_EVENT_PROPERTIES.analysis_failed = [...CLIENT_EVENT_PROPERTIES.analysis_failed, "inputId"];
CLIENT_EVENT_PROPERTIES.journey_exit = [...JOURNEY_COMMON, "phase", "reason"];
for (const name of ["export_requested", "export_completed", "export_failed"]) CLIENT_EVENT_PROPERTIES[name] = [...CLIENT_EVENT_PROPERTIES[name], ...ATTRIBUTION];

export function sanitizeEventProperties(
  eventName: string,
  input: unknown,
): Record<string, string | number | boolean | null> | null {
  const allowed = CLIENT_EVENT_PROPERTIES[eventName];
  if (
    !allowed ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    return null;
  const source = input as Record<string, unknown>;
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const value = source[key];
    if (key === "feature" && !(FEATURE_NAMES as readonly unknown[]).includes(value)) continue;
    if (key === "action" && !(FEATURE_ACTIONS as readonly unknown[]).includes(value)) continue;
    if (key === "errorCategory" && !["server","network","permission","validation","client","unknown"].includes(String(value))) continue;
    if (key === "osName" && !["macos","windows","linux","unknown"].includes(String(value))) continue;
    if (key === "source" && !["capture","file","semantic","clipboard","history","unknown"].includes(String(value))) continue;
    if (key === "httpStatus" && (typeof value !== "number" || !Number.isInteger(value) || value < 400 || value > 599)) continue;
    if (key === "searchOrdinal" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100000)) continue;
    if (["resultCount","selectionCount","personIndex","rank","zeroCandidatePeople","peopleWithCandidates","peopleCount","candidateCount","selectedCount"].includes(key) && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100000)) continue;
    if (ATTRIBUTION.includes(key) && typeof value !== "boolean") continue;
    if (eventName === "journey_exit" && key === "reason" && !["back","home","close","cancel"].includes(String(value))) continue;
    if (key === "bodyKind" && !["preset","custom","male","female","child","unknown"].includes(String(value))) continue;
    if (key === "telemetryVersion" && value !== 2) continue;
    if ((key === "sessionId" || key === "attemptId" || key === "inputId" || key === "inputAttemptId") && (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))) continue;
    if (key === "nativeDiskWrite" && typeof value !== "boolean") continue;
    if ((key === "elapsedMs" || key === "writingElapsedMs") && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86400000)) continue;
    if (key === "surface" && value !== "app" && value !== "bar") continue;
    if ((key === "phase" || key === "code") && typeof value === "string" && !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) continue;
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
  qualityConsentId: string | null;
  eventId: string;
  installationId: string;
  sequence: number;
  name: string;
  occurredAt: string;
  jobId: string | null;
  properties: Record<string, unknown>;
}): Promise<boolean> {
  return transaction(async (client) => {
    const consent = await lockQualityConsent(
      client,
      event.installationId,
      event.qualityConsentId,
      event.jobId,
    );
    if (
      !consent ||
      Date.parse(event.occurredAt) < Date.parse(consent.grantedAt) ||
      Date.parse(event.occurredAt) > Date.now() + 60_000
    )
      return false;
    const result = await client.query(
      `INSERT INTO analytics_events
      (event_id, installation_id, sequence_number, event_name, occurred_at, received_at,
       job_id, properties_json, quality_consent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
        consent.consentId,
      ],
    );
    return result.rowCount === 1;
  });
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
      "SELECT id FROM jobs WHERE id = $1 AND installation_id = $2 FOR UPDATE",
      [jobId, installationId],
    );
    if (owner.rowCount !== 1) return false;
    const confirmedAt = new Date().toISOString();
    const validated: Array<{
      personIndex: number;
      candidateId: string;
      rank: number;
    }> = [];
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
    // PUT replaces the job's confirmed set. A person the user stopped exporting must
    // not come back as "confirmed" when the job is reopened from history.
    await client.query(
      `DELETE FROM confirmed_selections
       WHERE job_id = $1 AND NOT (person_index = ANY($2::int[]))`,
      [jobId, validated.map((s) => s.personIndex)],
    );
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
  qualityConsentId: string | null = null,
): Promise<boolean> {
  return transaction(async (client) => {
    if (
      !(await lockQualityConsent(
        client,
        installationId,
        qualityConsentId,
        jobId,
      ))
    )
      return false;
    await client.query(
      `INSERT INTO job_feedback (job_id, installation_id, reason, submitted_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (job_id) DO UPDATE
     SET installation_id = EXCLUDED.installation_id, reason = EXCLUDED.reason,
         submitted_at = EXCLUDED.submitted_at`,
      [jobId, installationId, reason, new Date().toISOString()],
    );
    return true;
  });
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
  /** 사용자가 고른 저장 포맷. FBX 변환 실패를 BVH 저장과 섞어 세지 않기 위한 값이다. */
  format?: ExportFormat;
}): Promise<void> {
  await transaction(async (client) => {
    if (
      !event.jobId ||
      !(await lockQualityConsent(
        client,
        event.installationId,
        undefined,
        event.jobId,
      ))
    )
      return;
    await client.query(
      `INSERT INTO export_events
      (event_id, installation_id, job_id, person_index, candidate_id, status, occurred_at,
       error_code, variant, fallback_reason, format)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
        event.format ?? null,
      ],
    );
  });
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

/** Explicit author choice, distinct from merely exposed analysis_candidates membership. */
export async function validateConfirmedSelection(owner: string, jobId: string, index: number, candidateId: string): Promise<boolean> {
  return !!await queryOne(
    `SELECT s.candidate_id FROM confirmed_selections s JOIN jobs j ON j.id=s.job_id
     WHERE s.job_id=$1 AND s.person_index=$2 AND s.candidate_id=$3
       AND s.installation_id=$4 AND j.installation_id=$4 AND j.status='completed'
       AND j.created_at::timestamptz > now() - interval '90 days'`,
    [jobId, index, candidateId, owner],
  );
}
