import assert from "node:assert/strict";
import test from "node:test";
import { buildActivity, buildStrips, kstDay, lastDays, outcomeOf, type ActivityJobRow } from "./activity.js";
import { parseGalleryQuery } from "./gallery.js";

test("KST 날짜로 자른다", () => {
  // UTC 10.09 16:00 = KST 10.10 01:00
  assert.equal(kstDay(new Date("2026-10-09T16:00:00Z")), "2026-10-10");
  assert.equal(kstDay(new Date("2026-10-09T14:59:00Z")), "2026-10-09");
});

test("오늘부터 거꾸로 n일, 오래된 날이 앞이다", () => {
  assert.deepEqual(lastDays("2026-10-02", 4), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("Job 결과를 한 단어로 나눈다", () => {
  assert.equal(outcomeOf({ status: "failed", person_count: 0, selection_count: 0 }), "failed");
  assert.equal(outcomeOf({ status: "running", person_count: 0, selection_count: 0 }), "in_progress");
  assert.equal(outcomeOf({ status: "completed", person_count: 0, selection_count: 0 }), "zero_people");
  assert.equal(outcomeOf({ status: "completed", person_count: 2, selection_count: 1 }), "selected");
  assert.equal(outcomeOf({ status: "completed", person_count: 2, selection_count: 0 }), "no_selection");
});

function job(overrides: Partial<ActivityJobRow> = {}): ActivityJobRow {
  return {
    id: "job_x",
    created_at: "2026-10-10T03:00:00.000Z", // KST 10.10 12:00
    status: "completed",
    error_code: null,
    person_count: 2,
    selection_count: 1,
    exported: true,
    refined: false,
    feedback: null,
    ...overrides,
  };
}

test("오늘 왔고 어제는 안 왔고, 오늘 두 건 중 하나를 골랐다", () => {
  const summary = buildActivity(
    [{ day: "2026-10-10", events: 5 }, { day: "2026-10-08", events: 2 }],
    [
      job({ id: "job_a", created_at: "2026-10-10T03:00:00.000Z" }),
      job({ id: "job_b", created_at: "2026-10-10T05:00:00.000Z", selection_count: 0, exported: false }),
    ],
    "2026-10-10",
    3,
  );
  assert.deepEqual(summary.days.map((day) => [day.date, day.visited, day.jobs]), [
    ["2026-10-08", true, 0],
    ["2026-10-09", false, 0],
    ["2026-10-10", true, 2],
  ]);
  const today = summary.days[2];
  assert.equal(today.selected, 1);
  assert.equal(today.exported, 1);
  assert.equal(today.tone, "selected");
  assert.equal(summary.days[0].tone, "visit_only");
  assert.equal(summary.days[1].tone, "none");
  // 최신 Job이 먼저 온다.
  assert.deepEqual(summary.jobs.map((item) => [item.jobId, item.outcomeLabel]), [
    ["job_b", "선택 안 함"],
    ["job_a", "후보 선택"],
  ]);
  assert.equal(summary.visitedDays, 2);
  assert.equal(summary.lastVisit, "2026-10-10");
  assert.equal(summary.jobsSelected, 1);
});

test("Job만 있고 이벤트가 없어도 방문으로 친다", () => {
  const summary = buildActivity([], [job()], "2026-10-10", 1);
  assert.equal(summary.days[0].visited, true);
});

test("실패만 있던 날은 실패 색이다", () => {
  const summary = buildActivity([], [job({ status: "failed", person_count: 0, selection_count: 0 })], "2026-10-10", 1);
  assert.equal(summary.days[0].tone, "failed");
});

test("창 밖의 Job은 빠진다", () => {
  const summary = buildActivity([], [job({ created_at: "2026-09-01T03:00:00.000Z" })], "2026-10-10", 7);
  assert.equal(summary.jobsTotal, 0);
  assert.equal(summary.lastVisit, null);
});

test("설치마다 7일 출석 칸을 만든다", () => {
  const strips = buildStrips(
    [{ installation_id: "inst_a", day: "2026-10-10", events: 3, jobs: 2 }],
    ["inst_a", "inst_b"],
    "2026-10-10",
    7,
  );
  assert.equal(strips.inst_a.length, 7);
  assert.deepEqual(strips.inst_a[6], { date: "2026-10-10", visited: true, jobs: 2 });
  assert.ok(strips.inst_b.every((cell) => !cell.visited));
});

test("갤러리 폴더 키는 묶음마다 모양이 다르다", () => {
  assert.equal(parseGalleryQuery({ group: "date", key: "2026-10-10" }).ok, true);
  assert.equal(parseGalleryQuery({ group: "date", key: "어제" }).ok, false);
  assert.equal(parseGalleryQuery({ group: "installation", key: "inst_00000000-0000-4000-8000-000000000001" }).ok, true);
  assert.equal(parseGalleryQuery({ group: "installation", key: "job_x" }).ok, false);
  assert.equal(parseGalleryQuery({ group: "status", key: "selected" }).ok, true);
  assert.equal(parseGalleryQuery({ group: "status", key: "deleted" }).ok, false);
  assert.equal(parseGalleryQuery({ group: "everything", key: "x" }).ok, false);
  assert.equal(parseGalleryQuery({ group: "date", key: "2026-10-10", cursor: "garbage" }).ok, false);
});
