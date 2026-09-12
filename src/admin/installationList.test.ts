import assert from "node:assert/strict";
import test from "node:test";
import {
  ROSTER_LIMIT_DEFAULT,
  ROSTER_LIMIT_MAX,
  decodeRosterCursor,
  encodeRosterCursor,
  parseRosterQuery,
  toRosterItem,
  toRosterPage,
  type RosterRow,
} from "./installationList.js";

const LAST_SEEN = "2026-09-11T22:10:02.318Z";
const INSTALLATION_ID = "inst_00395aa0-dce1-44f4-92ba-31a5e7818571";

function row(overrides: Partial<RosterRow> = {}): RosterRow {
  return {
    id: INSTALLATION_ID,
    created_at: "2026-09-04T00:27:13.075Z",
    last_seen_at: LAST_SEEN,
    app_version: "0.1.1-beta.7",
    os_name: "windows",
    os_version: "11",
    locale: "ko",
    consent_version: "2026-08-02",
    revoked_at: null,
    deletion_requested_at: null,
    job_count: 2,
    failed_count: 1,
    last_job_at: "2026-09-04T00:29:24.879Z",
    ...overrides,
  };
}

test("커서는 왕복해도 값이 보존된다", () => {
  const cursor = { lastSeenAt: LAST_SEEN, id: INSTALLATION_ID };
  assert.deepEqual(decodeRosterCursor(encodeRosterCursor(cursor)), cursor);
});

test("손상된 커서는 null이다", () => {
  assert.equal(decodeRosterCursor(""), null);
  assert.equal(decodeRosterCursor("!!!"), null);
  // 구분자는 있지만 형식이 아닌 값
  assert.equal(decodeRosterCursor(Buffer.from("어제|" + INSTALLATION_ID).toString("base64url")), null);
  // Job 커서를 그대로 넘긴 경우 — id 형식에서 걸린다
  assert.equal(
    decodeRosterCursor(Buffer.from(LAST_SEEN + "|job_00000000-0000-4000-8000-000000000001").toString("base64url")),
    null,
  );
});

test("limit은 범위 밖이면 거절한다", () => {
  const fallback = parseRosterQuery({});
  assert.equal(fallback.ok && fallback.query.limit, ROSTER_LIMIT_DEFAULT);
  assert.equal(parseRosterQuery({ limit: String(ROSTER_LIMIT_MAX + 1) }).ok, false);
  assert.equal(parseRosterQuery({ limit: "0" }).ok, false);
  assert.equal(parseRosterQuery({ limit: "2.5" }).ok, false);
  const parsed = parseRosterQuery({ limit: "50" });
  assert.equal(parsed.ok && parsed.query.limit, 50);
});

test("activeOnly는 true/false만 받는다", () => {
  const on = parseRosterQuery({ activeOnly: "true" });
  assert.equal(on.ok && on.query.activeOnly, true);
  const off = parseRosterQuery({});
  assert.equal(off.ok && off.query.activeOnly, false);
  assert.equal(parseRosterQuery({ activeOnly: "1" }).ok, false);
});

test("행은 카멜케이스로 바뀌고 집계가 없으면 0이다", () => {
  const item = toRosterItem(row({ job_count: null, failed_count: null, last_job_at: null }));
  assert.equal(item.installationId, INSTALLATION_ID);
  assert.equal(item.jobCount, 0);
  assert.equal(item.failedCount, 0);
  assert.equal(item.lastJobAt, null);
});

test("페이지는 limit까지 자르고 초과분을 다음 커서로 바꾼다", () => {
  const rows = [row({ id: "inst_00000000-0000-4000-8000-00000000000" + 1 }), row()];
  const page = toRosterPage(rows, 1);
  assert.equal(page.items.length, 1);
  assert.deepEqual(decodeRosterCursor(page.nextCursor ?? ""), {
    lastSeenAt: LAST_SEEN,
    id: "inst_00000000-0000-4000-8000-000000000001",
  });
});

test("마지막 페이지는 커서가 없다", () => {
  const page = toRosterPage([row()], 20);
  assert.equal(page.nextCursor, null);
  assert.equal(page.items.length, 1);
});
