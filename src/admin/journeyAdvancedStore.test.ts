import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  ADVANCED_EVENTS_SQL,
  ADVANCED_JOBS_SQL,
  advancedMetrics,
  ADVANCED_EVENT_LIMIT,
} from "./journeyAdvancedStore.js";
import { pool } from "../db.js";
const from = "2026-10-21T00:00:00.000Z",
  to = "2026-10-29T00:00:00.000Z";
test("advanced SQL narrows broad review to current consenting cohort, honors audience and projects safe properties", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE quality_review_installations(id text,created_at text,quality_personal_data boolean,quality_content_license boolean,quality_consent_id text);
 CREATE TABLE quality_review_jobs(id text,installation_id text,created_at text,completed_at text,status text,source text,error_code text,quality_consent_id text);
 CREATE TABLE quality_review_analytics_events(event_id text,installation_id text,job_id text,event_name text,occurred_at text,sequence_number int,properties_json text,quality_consent_id text);
 CREATE TABLE internal_installations(id text);
 INSERT INTO quality_review_installations VALUES ('yes','2026-10-21T00:00:00.000Z',true,true,'current'),('no','2026-10-21T00:00:00.000Z',false,false,null),('dev','2026-10-21T00:00:00.000Z',true,true,'devconsent');
 INSERT INTO internal_installations VALUES ('dev');
 INSERT INTO quality_review_jobs VALUES ('j1','yes','2026-10-22T00:00:00.000Z',null,'failed','capture','TIMEOUT','current'),('j2','no','2026-10-22T00:00:00.000Z',null,'completed','capture',null,null);`);
    const props = JSON.stringify({
      telemetryVersion: 2,
      sessionId: "session",
      feature: "semantic_search",
      action: "search_completed",
      resultCount: 0,
      searchOrdinal: 2,
      surface: "bar",
      rawText: "private secret search",
      localPath: "/private/path",
      candidateId: "pose2",
      previousCandidateId: "pose1",
    });
    for (const [id, inst, consent, job] of [
      ["good", "yes", "current", "j1"],
      ["old-consent", "yes", "old", "j1"],
      ["unconsented", "no", null, null],
      ["prejob", "yes", "current", null],
      ["dev", "dev", "devconsent", null],
    ]) {
      await db.query(
        "INSERT INTO quality_review_analytics_events VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          inst,
          job,
          "feature_action",
          "2026-10-22T00:01:00.000Z",
          1,
          props,
          consent,
        ],
      );
    }
    const rows = (
      await db.query<{ event_id: string; properties: Record<string, unknown> }>(
        ADVANCED_EVENTS_SQL,
        [from, to, "unclassified"],
      )
    ).rows;
    assert.deepEqual(rows.map((r) => r.event_id).sort(), ["good", "prejob"]);
    assert.equal(rows[0].properties.resultCount, 0);
    assert.equal(rows[0].properties.searchOrdinal, 2);
    assert.equal(rows[0].properties.candidateChanged, true);
    assert.equal("rawText" in rows[0].properties, false);
    assert.equal("localPath" in rows[0].properties, false);
    assert.equal("previousCandidateId" in rows[0].properties, false);
    assert.equal(
      (await db.query(ADVANCED_JOBS_SQL, [from, to, "all"])).rows.length,
      1,
    );
    assert.equal(
      (await db.query(ADVANCED_EVENTS_SQL, [from, to, "internal"])).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
test("large history explicitly fails instead of returning a silently truncated funnel", async (t) => {
  t.mock.method(pool, "query", (async () => ({
    rows: Array(ADVANCED_EVENT_LIMIT + 1).fill({}),
    rowCount: ADVANCED_EVENT_LIMIT + 1,
  })) as unknown as typeof pool.query);
  await assert.rejects(
    () =>
      advancedMetrics([], {
        from,
        to,
        days: 8,
        idleMinutes: 30,
        audience: "all",
      }),
    /JOURNEY_HISTORY_TOO_LARGE/,
  );
});
