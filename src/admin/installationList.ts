// 설치 명부(GET /v1/admin/review/installations)의 순수 함수들 — 커서 인코딩, 쿼리
// 검증, row→응답 매핑.
//
// `jobs/history.ts`와 같은 이유로 분리했다. DB를 띄우는 통합 테스트가 없으므로
// 페이지 경계와 입력 검증은 순수 함수로 빼야 `node --test`로 확인할 수 있다.

/**
 * 커서는 `(last_seen_at, id)` 복합 키다.
 *
 * 정렬 기준이 `last_seen_at`인 이유: 운영자가 명부를 여는 목적은 "최근에 쓴 사람"을
 * 찾는 것이다. `created_at` 순으로 주면 오래전에 설치하고 오늘 쓴 사람이 뒤로 밀린다.
 *
 * `last_seen_at`은 설치가 API를 부를 때마다 갱신되므로 페이지를 넘기는 도중에도 값이
 * 바뀔 수 있다. 그 경우 해당 행이 첫 페이지로 올라가며 뒤쪽 페이지에서 사라진다 —
 * 중복·누락 없이 "지금 기준"을 보여 주는 편이 낫다고 보고 고정 스냅샷을 만들지 않았다.
 */
export interface RosterCursor {
  lastSeenAt: string;
  id: string;
}

const CURSOR_SEPARATOR = "|";

export function encodeRosterCursor(cursor: RosterCursor): string {
  return Buffer.from(`${cursor.lastSeenAt}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/** ISO 8601 UTC 고정 폭. `new Date().toISOString()`이 내는 형태만 받는다. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 서버가 발급한 설치 id. `createInstallation`이 `inst_${randomUUID()}`로 만든다. */
const INSTALLATION_ID = /^inst_[0-9a-f-]{36}$/;

export function decodeRosterCursor(raw: string): RosterCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator === -1) return null;
  const lastSeenAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!ISO_INSTANT.test(lastSeenAt) || !INSTALLATION_ID.test(id)) return null;
  return { lastSeenAt, id };
}

export const ROSTER_LIMIT_DEFAULT = 20;
export const ROSTER_LIMIT_MAX = 50;

export interface RosterQuery {
  limit: number;
  cursor: RosterCursor | null;
  /** true면 동의를 철회했거나 삭제를 요청한 설치는 뺀다. */
  activeOnly: boolean;
}

export type ParsedRosterQuery =
  | { ok: true; query: RosterQuery }
  | { ok: false; message: string };

export function parseRosterQuery(raw: {
  limit?: string;
  cursor?: string;
  activeOnly?: string;
}): ParsedRosterQuery {
  let limit = ROSTER_LIMIT_DEFAULT;
  if (raw.limit !== undefined) {
    // 범위 밖 값을 조용히 클램프하지 않는다(history와 같은 이유).
    const parsed = Number(raw.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ROSTER_LIMIT_MAX) {
      return { ok: false, message: `limit은 1 이상 ${ROSTER_LIMIT_MAX} 이하의 정수여야 합니다.` };
    }
    limit = parsed;
  }

  let cursor: RosterCursor | null = null;
  if (raw.cursor !== undefined) {
    cursor = decodeRosterCursor(raw.cursor);
    if (!cursor) return { ok: false, message: "cursor가 올바르지 않습니다." };
  }

  let activeOnly = false;
  if (raw.activeOnly !== undefined) {
    if (raw.activeOnly !== "true" && raw.activeOnly !== "false") {
      return { ok: false, message: "activeOnly는 true 또는 false여야 합니다." };
    }
    activeOnly = raw.activeOnly === "true";
  }

  return { ok: true, query: { limit, cursor, activeOnly } };
}

/** `listInstallations`의 SELECT 컬럼 그대로. snake_case는 여기서 끝난다. */
export interface RosterRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  app_version: string | null;
  os_name: string | null;
  os_version: string | null;
  locale: string | null;
  consent_version: string | null;
  revoked_at: string | null;
  deletion_requested_at: string | null;
  job_count: number | null;
  failed_count: number | null;
  last_job_at: string | null;
}

export interface RosterItem {
  installationId: string;
  createdAt: string;
  lastSeenAt: string;
  appVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  locale: string | null;
  consentVersion: string | null;
  revokedAt: string | null;
  deletionRequestedAt: string | null;
  jobCount: number;
  failedCount: number;
  /** 마지막으로 분석을 돌린 시각. 접속만 하고 돌리지 않았으면 null이다. */
  lastJobAt: string | null;
}

export function toRosterItem(row: RosterRow): RosterItem {
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
    jobCount: row.job_count ?? 0,
    failedCount: row.failed_count ?? 0,
    lastJobAt: row.last_job_at,
  };
}

/**
 * 조회 결과를 응답으로 만든다. `rows`는 `limit + 1`건까지 올 수 있고, 초과분은 다음
 * 페이지가 있다는 신호로만 쓰고 버린다 — 전체 COUNT는 쓰지 않는다.
 */
export function toRosterPage(
  rows: RosterRow[],
  limit: number,
): { items: RosterItem[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > limit;
  return {
    items: page.map(toRosterItem),
    nextCursor: hasMore && last ? encodeRosterCursor({ lastSeenAt: last.last_seen_at, id: last.id }) : null,
  };
}
