import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pool, SCHEMA } from "../db.js";
import { setJobInput, getOwnedJob } from "./store.js";
import { sourceImageIdentity } from "../pose/sceneManifest.js";
import { safeOriginalName } from "./inputIdentity.js";

test("uploaded names strip client paths and controls; unknown input never uses another draft", () => {
  assert.equal(safeOriginalName("C:\\roughs\\T001.png"), "T001.png");
  assert.equal(safeOriginalName("/roughs/T015\u0000.png"), "T015.png");
  assert.equal(safeOriginalName("blob"), null);
  assert.equal(safeOriginalName(""), null);
});
test("actual PostgreSQL job input identity survives reopening without cross-job names and migration repeats safely", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA); await db.exec(SCHEMA);
  const query = async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0, fields: [], command: "", oid: 0 };
  };
  t.mock.method(pool, "query", query as typeof pool.query);
  t.mock.method(pool, "connect", (async () => ({ query, release() {} })) as unknown as typeof pool.connect);
  const now = new Date().toISOString();
  for (const id of ["T001", "p0718", "old"]) await db.query(
    "INSERT INTO jobs (id, status, created_at, updated_at, installation_id, input_width, input_height) VALUES ($1,'queued',$2,$2,'owner',765,714)", [id, now]);
  await setJobInput("T001", { s3Key: "private/T001", sha256: "a".repeat(64), originalName: "T001.png" });
  await setJobInput("p0718", { s3Key: "private/p0718", sha256: "b".repeat(64), originalName: "p0718.png" });
  const original = await getOwnedJob("T001", "owner");
  assert.ok(original);
  const input = sourceImageIdentity(original);
  assert.equal(input.originalName, "T001.png"); assert.equal(input.sha256, "a".repeat(64));
  assert.equal(input.width, 765); assert.equal(input.height, 714);
  assert.equal(sourceImageIdentity((await getOwnedJob("old", "owner"))!).originalName, null);
  assert.equal(await getOwnedJob("T001", "other"), undefined);
});
