/** Actual PostgreSQL + actual Hono body routes, fixture converter only. Never uses production DB. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { Hono } from "hono";
import { SCHEMA } from "../db.js";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type { CandidateCamera } from "../types.js";
import { EXPECTED_SOLVER_VERSION, sha256Hex } from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import { catalog, result } from "./fixtures.js";
import { bodyRef } from "./model.js";
import {
  bodyStore,
  captureBodyPolicy,
  initializeBodySelections,
  readSelection,
  writeSelection,
} from "./store.js";
import { createBodySelectionRoutes } from "./routes.js";
import {
  createBodyPreviewRoutes,
  bodyPreviewManifestUrl,
  type BodyPreviewManifest,
} from "./previews.js";

test(
  "PostgreSQL/Hono: automatic stored choice -> Top-K -> manual choice -> new GLB/PNG, late responses rejected",
  {
    skip: !process.env.BODY_TEST_DATABASE_URL,
  },
  async () => {
    const url = process.env.BODY_TEST_DATABASE_URL!,
      admin = new Pool({ connectionString: url });
    const schema = `preview_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 5,
    });
    const tx = async <T>(run: (db: PoolClient) => Promise<T>) => {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const value = await run(client);
        await client.query("COMMIT");
        return value;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    };
    try {
      await db.query(SCHEMA);
      const owner = "inst_preview",
        c = catalog(9),
        analysis = result(),
        bvh = Buffer.from("source BVH");
      await db.query(
        `INSERT INTO installations (id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
      VALUES ($1,'hash','test','2026-10-08','2026-10-08','2026-10-08','test','test','test','test','ko')`,
        [owner],
      );
      for (const p of analysis.candidatesByPerson) {
        p.bodyRecommendation = {
          status: "available",
          body: bodyRef(c.assets[1]),
          reasonCodes: [],
        };
        p.candidates[0].camera = {
          version: "candidate-camera-v1",
          rotation: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          source_bvh_sha256: sha256Hex(bvh),
        } as CandidateCamera;
      }
      await db.query(
        "INSERT INTO jobs(id,status,created_at,updated_at,installation_id,result_json) VALUES ($1,'completed','2026-10-08','2026-10-08',$2,$3)",
        [analysis.jobId, owner, JSON.stringify(analysis)],
      );
      await tx(async (client) => {
        await captureBodyPolicy(client, analysis.jobId, owner, c);
        await initializeBodySelections(client, analysis.jobId, analysis, c);
      });
      const deps = { catalog: () => c, check: async () => "ok" as const };
      const selection = (who: string, job: string, i: number) =>
        readSelection(db, who, job, i, c);
      const app = new Hono<AppEnv>();
      app.use("*", async (context, next) => {
        context.set(
          "installationId",
          context.req.header("X-Test-Owner") ?? owner,
        );
        context.set("requestId", "test");
        await next();
      });
      app.route(
        "/v1/analysis/jobs",
        createBodySelectionRoutes(
          {
            ...bodyStore,
            selection,
            saveSelection: (who, job, i, change) =>
              tx((client) => writeSelection(client, who, job, i, change, deps)),
          },
          () => true,
        ),
      );
      let pngCalls = 0;
      let afterRender = async () => {};
      app.route(
        "/v1/analysis/jobs",
        createBodyPreviewRoutes({
          enabled: () => true,
          converterEnabled: () => true,
          selection,
          checkCharacter: deps.check,
          getOwnedJob: async (job, who) => {
            const row = (
              await db.query(
                "SELECT id,status,result_json FROM jobs WHERE id=$1 AND installation_id=$2",
                [job, who],
              )
            ).rows[0];
            return row
              ? ({
                  id: row.id,
                  status: row.status,
                  result: JSON.parse(row.result_json),
                } as Job)
              : undefined;
          },
          getPreviewRuntime: async () => ({
            schemaVersion: "body-preview-runtime.v1",
            previewRevision: "a".repeat(64),
            modelVersion: "posed-mesh-v1",
            modelRevision: "b".repeat(64),
            solverVersion: EXPECTED_SOLVER_VERSION,
            framingVersion: FRAMING_VERSION,
          }),
          getPoseBvh: async () => new Response(bvh),
          getModel: async (_sha, body) => {
            await afterRender();
            return Buffer.from(body.characterId);
          },
          convertFramed: async (input) => {
            pngCalls++;
            await afterRender();
            return {
              fbx: Buffer.from("fbx"),
              preview: Buffer.from(input.characterId),
              conversionId: "test",
              artifactSha256: "test",
              sourceBvhSha256: sha256Hex(bvh),
              characterSha256: input.expectedCharacterSha256,
              previewRevision: input.expectedPreviewRevision,
            };
          },
        }),
      );
      const prefix = bodyPreviewManifestUrl(analysis.jobId, 0);
      const manifest = async () => {
        const r = await app.request(prefix);
        assert.equal(r.status, 200, await r.clone().text());
        return (await r.json()) as BodyPreviewManifest;
      };
      const automatic = await manifest();
      assert.equal(automatic.resolvedBody.characterId, "character-1");
      assert.equal(
        await (
          await app.request(automatic.candidates[0].previewModel.url)
        ).text(),
        "character-1",
      );
      const changed = await app.request(
        prefix.replace("body-previews", "body-selection"),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent: "manual",
            characterId: "character-8",
            expectedRevision: 0,
            mutationId: "manual-preview-001",
          }),
        },
      );
      assert.equal(changed.status, 200, await changed.clone().text());
      const manual = await manifest();
      assert.equal(manual.resolvedBody.characterId, "character-8");
      assert.equal(manual.selectionRevision, 1);
      assert.equal(
        (await app.request(automatic.candidates[0].thumbnailUrl)).status,
        409,
      );
      assert.equal(
        await (await app.request(manual.candidates[0].previewModel.url)).text(),
        "character-8",
      );
      assert.equal(
        await (await app.request(manual.candidates[0].thumbnailUrl)).text(),
        "character-8",
      );
      assert.equal(
        (await app.request(manual.candidates[0].thumbnailUrl)).status,
        200,
      );
      assert.equal(pngCalls, 1);
      assert.equal(
        (await selection(owner, analysis.jobId, 1)).resolvedBody?.characterId,
        "character-1",
      );
      assert.equal(
        (
          await app.request(manual.candidates[0].thumbnailUrl, {
            headers: { "X-Test-Owner": "other" },
          })
        ).status,
        404,
      );
      afterRender = async () => {
        await tx((client) =>
          writeSelection(
            client,
            owner,
            analysis.jobId,
            0,
            {
              intent: "manual",
              characterId: "character-2",
              expectedRevision: 1,
              mutationId: "manual-preview-002",
            },
            deps,
          ),
        );
        afterRender = async () => {};
      };
      assert.equal(
        (await app.request(manual.candidates[0].previewModel.url)).status,
        409,
      );
      const stored = (
        await db.query("SELECT result_json FROM jobs WHERE id=$1", [
          analysis.jobId,
        ])
      ).rows[0].result_json;
      assert.deepEqual(
        JSON.parse(stored),
        JSON.parse(JSON.stringify(analysis)),
      ); // no search/rank/camera/refine writes
    } finally {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
