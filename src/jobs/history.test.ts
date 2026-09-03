import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  decodeCursor,
  encodeCursor,
  parseHistoryQuery,
  toHistoryItem,
  toHistoryPage,
  type JobHistoryRow,
} from "./history.js";

const CREATED_AT = "2026-08-29T01:02:03.456Z";
const JOB_ID = "job_00000000-0000-4000-8000-000000000001";

function row(overrides: Partial<JobHistoryRow> = {}): JobHistoryRow {
  return {
    id: JOB_ID,
    status: "completed",
    created_at: CREATED_AT,
    completed_at: "2026-08-29T01:02:09.000Z",
    error_code: null,
    source: "capture",
    input_width: 1920,
    input_height: 1080,
    has_input: true,
    person_count: 2,
    selection_count: 2,
    thumb_pose_id: "pose-1",
    thumb_view: "front",
    ...overrides,
  };
}

test("커서는 왕복해도 값이 보존된다", () => {
  const cursor = { createdAt: CREATED_AT, id: JOB_ID };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test("손상된 커서는 null이다", () => {
  // 조용히 첫 페이지로 폴백하면 "더 보기"가 같은 페이지를 무한 반복한다.
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor("!!!not-base64!!!"), null);
  // 구분자가 없다
  assert.equal(decodeCursor(Buffer.from(CREATED_AT, "utf8").toString("base64url")), null);
  // 시각 형식이 다르다
  assert.equal(decodeCursor(encodeCursor({ createdAt: "2026-08-29", id: JOB_ID })), null);
  // 서버가 발급한 job id가 아니다
  assert.equal(decodeCursor(encodeCursor({ createdAt: CREATED_AT, id: "not-a-job" })), null);
  assert.equal(decodeCursor("x".repeat(300)), null);
});

test("빈 쿼리는 기본값을 쓴다", () => {
  const parsed = parseHistoryQuery({});
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.query, { limit: HISTORY_LIMIT_DEFAULT, cursor: null, status: null });
});

test("범위 밖 limit은 클램프하지 않고 거절한다", () => {
  // 100을 요청했는데 20이 오면 클라이언트가 페이지 끝을 응답만으로 판단하기 어렵다.
  assert.equal(parseHistoryQuery({ limit: "0" }).ok, false);
  assert.equal(parseHistoryQuery({ limit: String(HISTORY_LIMIT_MAX + 1) }).ok, false);
  assert.equal(parseHistoryQuery({ limit: "1.5" }).ok, false);
  assert.equal(parseHistoryQuery({ limit: "abc" }).ok, false);
  const ok = parseHistoryQuery({ limit: String(HISTORY_LIMIT_MAX) });
  assert.ok(ok.ok);
  assert.equal(ok.query.limit, HISTORY_LIMIT_MAX);
});

test("지원하지 않는 status는 거절한다", () => {
  assert.equal(parseHistoryQuery({ status: "cancelled" }).ok, false);
  const ok = parseHistoryQuery({ status: "failed" });
  assert.ok(ok.ok);
  assert.equal(ok.query.status, "failed");
});

test("손상된 커서를 받은 쿼리는 실패한다", () => {
  assert.equal(parseHistoryQuery({ cursor: "garbage" }).ok, false);
});

test("실패한 job은 집계가 비어 있어도 0으로 매핑된다", () => {
  const item = toHistoryItem(
    row({
      status: "failed",
      error_code: "ANALYSIS_UNAVAILABLE",
      completed_at: null,
      person_count: 0,
      selection_count: 0,
      thumb_pose_id: null,
      thumb_view: null,
      has_input: false,
    }),
  );
  assert.equal(item.status, "failed");
  assert.equal(item.errorCode, "ANALYSIS_UNAVAILABLE");
  assert.equal(item.personCount, 0);
  assert.equal(item.hasSelection, false);
  assert.equal(item.thumbnailUrl, null);
  assert.equal(item.inputAvailable, false);
});

test("썸네일은 후보의 상대 경로로 만든다", () => {
  const item = toHistoryItem(row({ thumb_pose_id: "pose/1 a", thumb_view: "3/4" }));
  assert.equal(item.thumbnailUrl, "/v1/pose-candidates/pose%2F1%20a/thumbnail?view=3%2F4");
});

test("limit+1건이 오면 초과분은 버리고 nextCursor를 낸다", () => {
  const rows = [
    row({ id: "job_00000000-0000-4000-8000-000000000001" }),
    row({ id: "job_00000000-0000-4000-8000-000000000002" }),
    row({ id: "job_00000000-0000-4000-8000-000000000003" }),
  ];
  const page = toHistoryPage(rows, 2);
  assert.equal(page.items.length, 2);
  assert.deepEqual(decodeCursor(page.nextCursor!), {
    createdAt: CREATED_AT,
    id: "job_00000000-0000-4000-8000-000000000002",
  });
});

test("마지막 페이지의 nextCursor는 null이다", () => {
  assert.equal(toHistoryPage([row()], 20).nextCursor, null);
  assert.equal(toHistoryPage([], 20).nextCursor, null);
});
