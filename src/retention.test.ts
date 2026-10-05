import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA } from "./db.js";
import {
  CASCADE_TABLES,
  EVENT_LOG_TABLES,
  INSTALLATION_SCOPED_TABLES,
  JOB_SCOPED_TABLES,
  RETENTION_DAYS,
  deleteExpiredRows,
  deleteInstallationData,
  deleteJobs,
  type SqlClient,
} from "./retention.js";

/** SCHEMA의 CREATE TABLE 본문과 ALTER TABLE ADD COLUMN에서 테이블마다 칸 이름을 모은다. */
function schemaColumns(): Map<string, Set<string>> {
  const columns = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    if (!columns.has(table)) columns.set(table, new Set());
    columns.get(table)!.add(column);
  };
  for (const [, table, body] of SCHEMA.matchAll(
    /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g,
  )) {
    for (const line of body.split("\n")) {
      const column = /^\s*([a-z_][a-z0-9_]*)\s/.exec(line);
      if (column) add(table, column[1]);
    }
  }
  for (const [, table, column] of SCHEMA.matchAll(
    /ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g,
  )) {
    add(table, column);
  }
  return columns;
}

const columns = schemaColumns();

function tablesWith(column: string): string[] {
  return [...columns]
    .filter(([, names]) => names.has(column))
    .map(([table]) => table)
    .sort();
}

interface Call {
  text: string;
  params: unknown[];
}

function recorder(): { client: SqlClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async query(text: string, params: unknown[] = []) {
        calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function deletedTables(calls: Call[]): string[] {
  return calls.flatMap((call) => {
    const match = /^DELETE FROM (\w+)/.exec(call.text);
    return match ? [match[1]] : [];
  });
}

test("the schema parser reads the tables this file checks", () => {
  // SCHEMA 형식이 바뀌어 테이블을 못 읽으면 아래 검사가 모두 빈 목록끼리 비교하며 통과한다.
  for (const table of ["jobs", "installations", "analysis_people", "refined_artifacts", "job_outbox"]) {
    assert.ok(columns.has(table), table);
  }
  assert.ok(columns.get("admin_access_audit")?.has("installation_id"));
  assert.ok(columns.get("jobs")?.has("installation_id"));
});

test("every table with a job_id is deleted together with its job", () => {
  assert.deepEqual(tablesWith("job_id"), [...JOB_SCOPED_TABLES, ...CASCADE_TABLES].sort());
});

test("cascade tables really cascade from jobs", () => {
  for (const table of CASCADE_TABLES) {
    const body = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`,
    ).exec(SCHEMA)?.[1];
    assert.match(body ?? "", /job_id[^,\n]*REFERENCES jobs\(id\) ON DELETE CASCADE/, table);
  }
});

test("every table with an installation_id is cleared on consent withdrawal", () => {
  // jobs는 installation_id로 골라 deleteJobs가 지운다.
  assert.deepEqual(
    tablesWith("installation_id").filter((table) => table !== "jobs"),
    [...INSTALLATION_SCOPED_TABLES].sort(),
  );
});

test("event logs are cut by a time column they actually have", () => {
  for (const [table, column] of Object.entries(EVENT_LOG_TABLES)) {
    assert.ok(columns.get(table)?.has(column), `${table}.${column}`);
  }
});

test("deleting one job locks it, clears its rows, then removes the job", async () => {
  const { client, calls } = recorder();
  await deleteJobs(client, { ids: "$1", params: ["job_1"] });

  assert.equal(calls[0].text, "SELECT id FROM jobs WHERE id IN ($1) ORDER BY id FOR UPDATE");
  assert.deepEqual(deletedTables(calls), [...JOB_SCOPED_TABLES, "jobs"]);
  for (const call of calls) assert.deepEqual(call.params, ["job_1"]);
});

test("consent withdrawal clears refined artifacts, installation audits and the quota counter", async () => {
  const { client, calls } = recorder();
  await deleteInstallationData(client, "inst_a");
  const byInstallation = "SELECT id FROM jobs WHERE installation_id = $1";

  // 무엇을 지우기 전에 그 설치의 작업부터 잠근다. 워커가 결과를 쓰는 중이면 끝날 때까지 기다린다.
  assert.equal(calls[0].text, `SELECT id FROM jobs WHERE id IN (${byInstallation}) ORDER BY id FOR UPDATE`);
  const texts = calls.map((call) => call.text);
  // 이전 경로가 남기던 행들
  assert.ok(texts.includes(`DELETE FROM refined_artifacts WHERE job_id IN (${byInstallation})`));
  assert.ok(texts.includes("DELETE FROM admin_access_audit WHERE installation_id = $1"));
  assert.ok(
    texts.includes(
      "DELETE FROM usage_counters WHERE scope = 'installation_week' AND subject = $1",
    ),
  );

  const deleted = deletedTables(calls);
  for (const table of [...JOB_SCOPED_TABLES, ...INSTALLATION_SCOPED_TABLES]) {
    assert.ok(deleted.includes(table), table);
  }
  const jobsAt = deleted.indexOf("jobs");
  for (const table of JOB_SCOPED_TABLES) assert.ok(deleted.indexOf(table) < jobsAt, table);
  for (const call of calls) assert.deepEqual(call.params, ["inst_a"]);
});

test("the retention sweep uses one cutoff for every statement", async () => {
  const { client, calls } = recorder();
  await deleteExpiredRows(client, new Date("2026-10-06T00:00:00.000Z"));

  assert.equal(RETENTION_DAYS, 365);
  for (const call of calls) {
    assert.deepEqual(call.params, ["2025-10-06T00:00:00.000Z"]);
    assert.doesNotMatch(call.text, /now\(\)/);
  }
  const deleted = deletedTables(calls);
  for (const table of [...JOB_SCOPED_TABLES, "jobs", ...Object.keys(EVENT_LOG_TABLES)]) {
    assert.ok(deleted.includes(table), table);
  }
  // 작업 없는 export 기록은 전에는 어떤 경로로도 지워지지 않았다.
  assert.ok(
    calls.some(
      (call) =>
        call.text === "DELETE FROM export_events WHERE occurred_at::timestamptz < $1::timestamptz",
    ),
  );
});
