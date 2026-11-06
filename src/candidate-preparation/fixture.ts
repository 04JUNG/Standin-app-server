/** Controlled source engine with real SQL/Hono, never production evidence. */
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { CANDIDATE_PREPARATION_SCHEMA } from "./schema.js";
import { PreparationStore } from "./store.js";
import { PreparationService } from "./service.js";
import { createPreparationRoutes } from "./routes.js";
import { hash, HTTP_SCHEMA, ENGINE_CONTRACT, type EngineInput, type EngineResult } from "./model.js";
export const owner = { installationId: "inst_owner", jobId: "job_fixture" };
export const bvh = "HIERARCHY\nROOT Hips\n{ OFFSET 0 0 0 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation End Site { OFFSET 0 1 0 } }\nMOTION\nFrames: 1\nFrame Time: 0.033333\n0 0 0 0 0 0\n";
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export async function setupFixture(people = 1) {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE installations(id TEXT PRIMARY KEY);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,installation_id TEXT,status TEXT);
    CREATE TABLE analysis_candidates(job_id TEXT);
    INSERT INTO installations VALUES('inst_owner'),('inst_other');
    INSERT INTO jobs VALUES('job_fixture','inst_owner','completed');${CANDIDATE_PREPARATION_SCHEMA}`);
  // PGlite lacks advisory locks; SQL transactions still serialize. PostgreSQL keeps the cross-replica lock.
  const store = new PreparationStore(fn => pg.transaction(tx => fn({ query: <T>(sql: string, args?: unknown[]) =>
    sql.includes("pg_advisory_xact_lock") ? Promise.resolve({ rows: [] as T[] }) : tx.query<T>(sql, args) })));
  const state = { revision: 0, target: 0, engine: 0, valid: true, confirmed: false, failure: false,
    corrupt: false, reuseInvalid: false, chunks: [] as number[], solveCalls: 0, reuseCalls: 0,
    hold: null as Promise<void> | null, unavailableCandidate: "", metrics: [] as string[] };
  const identity = () => ({ code_version: "v2.5.4", config_sha256: hash(state.engine), source_revision: "fixture" });
  const rows = Array.from({ length: people }, (_, person) => Array.from({ length: 5 }, (_, i) => ({
    person_id: String(person), candidate_id: `candidate_${person}_${i}`, source_sha256: sha(bvh),
    request: { pose_id: `pose_${person}_${i}`, view: "front", render_thumbnail: false, keypoints: Array(17).fill([1, 2]),
      scores: null, search_distance: 0.1, refine_allowed: true, refinable_limbs: ["left_arm"], skeleton_state: "full",
      coverage_class: "full", slot_origin: "vlm", skeleton_source: "full_image", lower_body_observed: false },
  }))).flat() satisfies EngineInput["candidates"];
  const make = (c: EngineInput["candidates"][number]): EngineResult => ({ person_id: c.person_id, candidate_id: c.candidate_id,
    source_sha256: c.source_sha256, artifact_sha256: sha(bvh), bvh, prepared_id: c.candidate_id,
    context_fingerprint: hash(c), source_fingerprint: hash(c.request), engine: identity(),
    status: "ready_base", reason: "no_gain", quality_scope: "source_only",
    timing: { queue_ms: 0, execution_ms: 1, total_ms: 1, cache: "miss" } });
  const service = new PreparationService({ store,
    resolve: async (l, engine) => {
      if (!state.valid || l.installationId !== owner.installationId) throw new Error("owner missing");
      const candidateSetRevision = hash([state.revision, rows]);
      return { contextHash: hash([l, state.revision, engine]), candidateSetRevision, candidates: rows,
        unsupported: [], order: rows.map(c => ({ personIndex: Number(c.person_id), candidateId: c.candidate_id })) };
    },
    transport: { capabilities: async () => ({ contract_version: ENGINE_CONTRACT, available: true, source_refine: true,
      target_refine: false, quality_scope: "source_only", max_candidates: 10, max_candidates_per_person: 5, engine: identity() }),
      prepare: async input => {
        state.chunks.push(input.candidates.length); state.solveCalls += input.candidates.length;
        await state.hold; if (state.failure) throw new Error("timeout");
        return { contract_version: ENGINE_CONTRACT, batch_id: input.batch_id, owner_id: input.owner_id, job_id: input.job_id,
          candidate_set_revision: input.candidate_set_revision, all_terminal: true,
          results: input.candidates.map(c => c.candidate_id === state.unavailableCandidate
            ? { ...make(c), status: "failed_retryable", reason: "timeout", bvh: null, prepared_id: null, artifact_sha256: null }
            : { ...make(c), ...(state.corrupt ? { artifact_sha256: "0".repeat(64) } : {}) }), elapsed_ms: 5 };
      },
      reuse: async input => { state.reuseCalls++; if (state.reuseInvalid) throw new Error("expired");
        return make(rows.find(c => c.candidate_id === input.candidate_id && c.person_id === input.person_id)!); },
    }, confirmed: async () => state.confirmed,
    metric: event => { state.metrics.push(event); },
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("installationId", c.req.header("X-Test-Owner") ?? owner.installationId); c.set("requestId", "test"); await next(); });
  app.route("/v1/analysis/jobs", createPreparationRoutes(service, () => true, async (_j, o) => o === owner.installationId ? {} as Job : undefined));
  const base = `/v1/analysis/jobs/${owner.jobId}/candidate-preparation`;
  const prepare = (expectedRevision = 0, mutationId = "mutation_initial") => service.prepare(owner, { schemaVersion: HTTP_SCHEMA, expectedRevision, mutationId });
  return { pg, store, service, state, app, base, prepare, rows };
}
