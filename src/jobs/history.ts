// 작업 기록(GET /v1/analysis/jobs)의 순수 함수들 — 커서 인코딩, 쿼리 검증, row→응답 매핑.
//
// 라우트와 SQL에서 분리해 둔 이유는 테스트 때문이다. 이 레포에는 DB를 띄우는 통합
// 테스트가 없으므로, 페이지 경계와 입력 검증처럼 틀리기 쉬운 부분을 순수 함수로 빼야
// `node --test`로 확인할 수 있다.
import type { JobStatus } from "./store.js";

/**
 * 커서는 `(created_at, id)` 복합 키다.
 *
 * offset 페이지네이션은 개별 삭제와 함께 쓰면 반드시 항목을 건너뛴다. `created_at`만으로도
 * 부족하다 — 같은 밀리초에 만들어진 job이 페이지 경계에 걸리면 누락되거나 중복된다.
 * `created_at`은 TEXT지만 `toISOString()`이 고정 폭이라 사전순 비교가 곧 시간순이다.
 */
export interface HistoryCursor {
  createdAt: string;
  id: string;
}

const CURSOR_SEPARATOR = "|";

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/** ISO 8601 UTC 고정 폭. `new Date().toISOString()`이 내는 형태만 받는다. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 서버가 발급한 Job id. `insertJob`이 `job_${randomUUID()}`로 만든다. */
const JOB_ID = /^job_[0-9a-f-]{36}$/;

/**
 * 손상된 커서는 `null`을 돌려주고 라우트가 400으로 거절한다.
 *
 * 조용히 첫 페이지로 폴백하면 클라이언트의 "더 보기"가 같은 페이지를 영원히 다시 받으며
 * 무한 반복된다 — 사용자에게는 목록이 멈춘 것처럼 보이고 원인은 드러나지 않는다.
 */
export function decodeCursor(raw: string): HistoryCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator === -1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!ISO_INSTANT.test(createdAt) || !JOB_ID.test(id)) return null;
  return { createdAt, id };
}

export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 50;

/** 목록에는 rate limit이 걸려 있지 않다(POST에만 있다). 상한은 여기서만 강제된다. */
const HISTORY_STATUSES = new Set<JobStatus>(["queued", "running", "completed", "failed"]);

export interface HistoryQuery {
  limit: number;
  cursor: HistoryCursor | null;
  status: JobStatus | null;
}

export type ParsedHistoryQuery =
  | { ok: true; query: HistoryQuery }
  | { ok: false; message: string };

export function parseHistoryQuery(raw: {
  limit?: string;
  cursor?: string;
  status?: string;
}): ParsedHistoryQuery {
  let limit = HISTORY_LIMIT_DEFAULT;
  if (raw.limit !== undefined) {
    // 범위 밖 값을 조용히 클램프하지 않는다. 클라이언트가 100을 요청하고 20을 받으면
    // "더 보기"가 끝났는지 아닌지를 응답만 보고 판단하기 어려워진다.
    const parsed = Number(raw.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_LIMIT_MAX) {
      return { ok: false, message: `limit은 1 이상 ${HISTORY_LIMIT_MAX} 이하의 정수여야 합니다.` };
    }
    limit = parsed;
  }

  let cursor: HistoryCursor | null = null;
  if (raw.cursor !== undefined) {
    cursor = decodeCursor(raw.cursor);
    if (!cursor) return { ok: false, message: "cursor가 올바르지 않습니다." };
  }

  let status: JobStatus | null = null;
  if (raw.status !== undefined) {
    if (!HISTORY_STATUSES.has(raw.status as JobStatus)) {
      return { ok: false, message: "지원하지 않는 status입니다." };
    }
    status = raw.status as JobStatus;
  }

  return { ok: true, query: { limit, cursor, status } };
}

/** `listJobHistory`의 SELECT 컬럼 그대로. snake_case는 여기서 끝난다. */
export interface JobHistoryRow {
  id: string;
  status: JobStatus;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
  source: string | null;
  input_width: number | null;
  input_height: number | null;
  has_input: boolean;
  person_count: number | null;
  selection_count: number | null;
  thumb_pose_id: string | null;
  thumb_view: string | null;
}

export interface JobHistoryItem {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  source: string | null;
  personCount: number;
  selectionCount: number;
  hasSelection: boolean;
  /**
   * 목록 썸네일은 **원본 러프가 아니라 매칭된 포즈 후보**다. 원본을 20건 내려보내면
   * 수십 MB가 되지만, 후보 썸네일은 이미 `private, max-age=86400`으로 캐시되는 작은
   * PNG다. 인증 헤더가 필요하므로 절대 URL이 아닌 상대 경로를 준다(mapping.ts와 동일).
   */
  thumbnailUrl: string | null;
  /** 입력 원본이 S3에 남아 있는가. 버킷 lifecycle이 90일이라 오래된 job은 false다. */
  inputAvailable: boolean;
  inputWidth: number | null;
  inputHeight: number | null;
}

export function toHistoryItem(row: JobHistoryRow): JobHistoryItem {
  const selectionCount = row.selection_count ?? 0;
  return {
    jobId: row.id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    source: row.source,
    personCount: row.person_count ?? 0,
    selectionCount,
    hasSelection: selectionCount > 0,
    thumbnailUrl:
      row.thumb_pose_id && row.thumb_view
        ? `/v1/pose-candidates/${encodeURIComponent(row.thumb_pose_id)}/thumbnail?view=${encodeURIComponent(row.thumb_view)}`
        : null,
    inputAvailable: row.has_input,
    inputWidth: row.input_width,
    inputHeight: row.input_height,
  };
}

/**
 * 조회 결과를 응답으로 만든다. `rows`는 `limit + 1`건까지 올 수 있고, 초과분은 다음
 * 페이지가 있다는 신호로만 쓰고 버린다 — 전체 COUNT는 365일치를 스캔하므로 쓰지 않는다.
 */
export function toHistoryPage(
  rows: JobHistoryRow[],
  limit: number,
): { items: JobHistoryItem[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > limit;
  return {
    items: page.map(toHistoryItem),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
