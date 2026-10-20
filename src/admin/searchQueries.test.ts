import test from "node:test";
import assert from "node:assert/strict";
import { searchQueryOf } from "./searchQueries.js";
import { buildActivity } from "./activity.js";

test("searchQueryOf reads the query only for text-search jobs", () => {
  const result = JSON.stringify({ source: "semantic", semantic: { query: "달리다 넘어지는 자세", index: {} } });
  assert.equal(searchQueryOf("semantic", result), "달리다 넘어지는 자세");
  assert.equal(searchQueryOf("upload", result), null, "image jobs never show a query");
  assert.equal(searchQueryOf("semantic", null), null);
  assert.equal(searchQueryOf("semantic", "{not json"), null, "a broken row must not break the page");
  assert.equal(searchQueryOf("semantic", JSON.stringify({ semantic: { query: "" } })), null);
});

test("activity keeps the job source so the dashboard can label text searches", () => {
  const row = {
    id: "job_a",
    created_at: "2026-10-20T07:56:01.000Z",
    status: "completed",
    error_code: null,
    person_count: 1,
    selection_count: 0,
    exported: false,
    refined: false,
    feedback: null,
  };
  const summary = buildActivity([], [{ ...row, source: "semantic" }, { ...row, id: "job_b" }], "2026-10-20", 14);
  assert.deepEqual(
    summary.jobs.map((job) => [job.jobId, job.source]),
    [["job_a", "semantic"], ["job_b", null]],
  );
});
