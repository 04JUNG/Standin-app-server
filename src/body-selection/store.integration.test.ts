/** Opt-in: use a disposable PostgreSQL database, never production. Creates an isolated schema. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { SCHEMA } from "../db.js";
import { deleteJobs, deleteInstallationData } from "../retention.js";
import { catalog, fixture, result } from "./fixtures.js";
import { defaultPreferences } from "./model.js";
import { mapBodyRecommendations } from "./recommendation.js";
import {
  BodyError,
  captureBodyPolicy,
  initializeBodySelections,
  readPreferences,
  readSelection,
  writePreferences,
  writeSelection,
} from "./store.js";

test(
  "PostgreSQL: snapshot, persistence, concurrent writes, ownership, idempotency and deletion",
  { skip: !process.env.BODY_TEST_DATABASE_URL },
  async () => {
    const url = process.env.BODY_TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString: url });
    const schema = `body_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 5,
    });
    const tx = async <T>(fn: (c: PoolClient) => Promise<T>) => {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        const v = await fn(c);
        await c.query("COMMIT");
        return v;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    };
    try {
      // Run the actual repository schema, including new migration and retention registry dependencies.
      await db.query(SCHEMA);
      const owner = "inst_body_test";
      await db.query(
        `INSERT INTO installations (id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
      VALUES ($1,'hash','test','2026-10-08','2026-10-08','2026-10-08','test','test','test','test','ko')`,
        [owner],
      );
      const c = catalog(),
        deps = { catalog: () => c, check: async () => "ok" as const };
      assert.deepEqual(await readPreferences(db, owner), defaultPreferences());
      const fixed = {
        mode: "fixed_default" as const,
        defaultCharacterId: "character-0",
        expectedRevision: 0,
        mutationId: "pref-initial",
      };
      const pref = await tx((client) =>
        writePreferences(client, owner, fixed, deps),
      );
      assert.equal(pref.revision, 1);
      assert.deepEqual(
        await tx((client) => writePreferences(client, owner, fixed, deps)),
        pref,
      );
      const analysis = result(),
        recs = mapBodyRecommendations(fixture(), c);
      for (const p of analysis.candidatesByPerson)
        p.bodyRecommendation = recs.get(p.personIndex);
      await db.query(
        "INSERT INTO jobs(id,status,created_at,updated_at,installation_id,result_json) VALUES ($1,'completed','2026-10-08','2026-10-08',$2,$3)",
        [analysis.jobId, owner, JSON.stringify(analysis)],
      );
      await tx(async (client) => {
        await captureBodyPolicy(client, analysis.jobId, owner, c);
        await initializeBodySelections(client, analysis.jobId, analysis, c);
      });
      await tx((client) =>
        writePreferences(
          client,
          owner,
          {
            mode: "auto",
            defaultCharacterId: "character-2",
            expectedRevision: 1,
            mutationId: "pref-changed",
          },
          deps,
        ),
      );
      assert.equal(
        (await readSelection(db, owner, analysis.jobId, 0, c)).resolvedSource,
        "fixed_default",
      );
      const attempts = await Promise.allSettled(
        ["character-1", "character-2"].map((characterId, i) =>
          tx((client) =>
            writeSelection(
              client,
              owner,
              analysis.jobId,
              0,
              {
                intent: "manual",
                characterId,
                expectedRevision: 0,
                mutationId: `simultaneous-${i}`,
              },
              deps,
            ),
          ),
        ),
      );
      assert.equal(attempts.filter((v) => v.status === "fulfilled").length, 1);
      const rejected = attempts.find(
        (v) => v.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(
        (rejected.reason as BodyError).code,
        "BODY_SELECTION_CONFLICT",
      );
      assert.equal(
        (await readSelection(db, owner, analysis.jobId, 1, c))
          .selectionRevision,
        0,
      );
      // Re-delivered analysis cannot overwrite the user's selection.
      await tx((client) =>
        initializeBodySelections(client, analysis.jobId, analysis, c),
      );
      assert.equal(
        (await readSelection(db, owner, analysis.jobId, 0, c)).intent,
        "manual",
      );
      const auto = {
        intent: "auto" as const,
        expectedRevision: 1,
        mutationId: "apply-auto",
      };
      const value = await tx((client) =>
        writeSelection(client, owner, analysis.jobId, 0, auto, deps),
      );
      assert.equal(value.resolvedBody?.characterId, "character-1");
      assert.equal(value.selectionRevision, 2);
      assert.deepEqual(
        await tx((client) =>
          writeSelection(client, owner, analysis.jobId, 0, auto, deps),
        ),
        value,
      );
      await assert.rejects(
        tx((client) =>
          writeSelection(
            client,
            owner,
            analysis.jobId,
            0,
            { ...auto, intent: "inherit" },
            deps,
          ),
        ),
        (e: unknown) =>
          e instanceof BodyError && e.code === "IDEMPOTENCY_CONFLICT",
      );
      await assert.rejects(
        readSelection(db, "inst_foreign", analysis.jobId, 0, c),
        (e: unknown) => e instanceof BodyError && e.status === 404,
      );
      await assert.rejects(
        tx((client) =>
          writeSelection(
            client,
            owner,
            analysis.jobId,
            0,
            {
              intent: "manual",
              characterId: "absent",
              expectedRevision: 2,
              mutationId: "missing-model",
            },
            deps,
          ),
        ),
      );
      assert.equal(
        (await readSelection(db, owner, analysis.jobId, 0, c))
          .selectionRevision,
        2,
      );
      const stored = await db.query<{ result_json: string }>(
        "SELECT result_json FROM jobs WHERE id=$1",
        [analysis.jobId],
      );
      assert.deepEqual(
        JSON.parse(stored.rows[0].result_json),
        JSON.parse(JSON.stringify(analysis)),
      );
      // Current asset replacement blocks use without replacing the user's remembered choice.
      c.assets[1].assetSha256 = "f".repeat(64);
      assert.equal(
        (await readSelection(db, owner, analysis.jobId, 0, c)).resolutionStatus,
        "unavailable",
      );
      await tx((client) =>
        deleteJobs(client, { ids: "$1", params: [analysis.jobId] }),
      );
      assert.equal(
        (await db.query("SELECT * FROM body_selections")).rowCount,
        0,
      );
      assert.equal(
        (
          await db.query(
            "SELECT * FROM body_mutations WHERE job_id IS NOT NULL",
          )
        ).rowCount,
        0,
      );
      assert.equal((await readPreferences(db, owner)).revision, 2);
      await tx((client) => deleteInstallationData(client, owner));
      assert.equal(
        (await db.query("SELECT * FROM body_preferences")).rowCount,
        0,
      );
      assert.equal(
        (await db.query("SELECT * FROM body_mutations")).rowCount,
        0,
      );
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
