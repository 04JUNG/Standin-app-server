import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA } from "../db.js";
import { materialize, paging, readPage, SemanticPageError } from "./pages.js";
import { semanticResult, type SearchGroup } from "./contract.js";
import { attachSemanticPresentation } from "./presentation.js";

const groups: SearchGroup[] = Array.from({ length: 1000 }, (_, i) => ({
  rank: i < 965 ? i + 1 : i - 964,
  near: i >= 965,
  description: `pose ${i}`,
  labels: [],
  variants: [{ poseId: `pose${i}`, thumbnail: true, alternate: false }],
}));
const index = { version: "lib-test", content_sha256: "a".repeat(64) };
const capabilities = {
  refine: false,
  fbxExport: false,
  characterSelection: false,
};

test("1,000-result snapshot: 20 BVHs first, ordered/idempotent pages, group boundary, cancellation, ownership, deletion", async () => {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA);
    await db.query(
      "INSERT INTO installations(id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale) VALUES('owner','h','v','now','now','now','v','test','test','test','ko')",
    );
    const jobId = "job_test",
      snapshot = randomUUID();
    let calls = 0,
      active = 0,
      peak = 0;
    const bvh = async (id: string) => {
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return new Response(`HIERARCHY:${id}`);
    };
    const first = await materialize(
      groups.slice(0, 20),
      new AbortController().signal,
      bvh,
    );
    assert.equal(calls, 20);
    assert.equal(peak, 4);
    const result = semanticResult(
      jobId,
      "테스트 자세",
      index,
      first,
      capabilities,
    );
    result.semantic!.paging = paging(snapshot, groups, 20);
    const context = attachSemanticPresentation(result);
    await db.query(
      "INSERT INTO jobs(id,status,created_at,updated_at,installation_id,result_json) VALUES($1,'completed','now','now','owner',$2)",
      [jobId, JSON.stringify(result)],
    );
    await db.query("INSERT INTO semantic_snapshots VALUES($1,$2,$3)", [
      jobId,
      snapshot,
      JSON.stringify(groups),
    ]);
    await db.query(
      "INSERT INTO analysis_people(job_id,person_index,tags_json,confidence,refine_context_json,candidate_count) VALUES($1,0,'{}','low',$2,20)",
      [jobId, JSON.stringify({ ...context, custom: "preserve" })],
    );
    await db.query(
      "INSERT INTO confirmed_selections VALUES($1,0,'owner',$2,1,'now')",
      [jobId, first[0]!.id],
    );
    const run = async <T>(fn: (c: PoolClient) => Promise<T>) =>
      db.transaction(async (tx) =>
        fn({
          query: async (sql: string, values?: unknown[]) => {
            const r = await tx.query(sql, values);
            return { ...r, rowCount: r.rows.length || r.affectedRows };
          },
        } as unknown as PoolClient),
      );
    let changed = false;
    const deps = {
      getPoseBvh: bvh,
      library: async () => ({
        healthy: true,
        library: {
          version: index.version,
          source: null,
          contentSha256: changed ? "changed" : index.content_sha256,
        },
      }),
    };
    const signal = new AbortController().signal;
    const [page, concurrent] = await Promise.all([
      readPage("owner", jobId, `${snapshot}.20`, signal, deps, run),
      readPage("owner", jobId, `${snapshot}.20`, signal, deps, run),
    ]);
    assert.equal(JSON.stringify(page), JSON.stringify(concurrent));
    assert.equal(calls, 40);
    assert.equal(page.semantic!.paging!.loaded, 40);
    assert.deepEqual(
      page.candidatesByPerson[0]!.candidates.map((c) => c.poseId),
      groups.slice(20, 40).map((g) => g.variants[0]!.poseId),
    );
    assert.equal(
      JSON.stringify(
        await readPage("owner", jobId, `${snapshot}.20`, signal, deps, run),
      ),
      JSON.stringify(page),
    );
    assert.equal(calls, 40);
    await assert.rejects(
      readPage("other", jobId, `${snapshot}.40`, signal, deps, run),
      (e) => e instanceof SemanticPageError && e.status === 404,
    );
    await assert.rejects(
      readPage("owner", jobId, `${randomUUID()}.40`, signal, deps, run),
    );
    await assert.rejects(
      readPage("owner", jobId, `${snapshot}.60`, signal, deps, run),
    );
    changed = true;
    await assert.rejects(
      readPage("owner", jobId, `${snapshot}.40`, signal, deps, run),
      (e) =>
        e instanceof SemanticPageError &&
        e.code === "SEMANTIC_SNAPSHOT_CHANGED",
    );
    assert.equal(calls, 40);
    changed = false;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      readPage("owner", jobId, `${snapshot}.40`, abort.signal, deps, run),
    );
    for (let offset = 40; offset < 1000; offset += 20) {
      const next = await readPage(
        "owner",
        jobId,
        `${snapshot}.${offset}`,
        signal,
        deps,
        run,
      );
      assert.equal(next.candidatesByPerson[0]!.candidates.length, 20);
      if (offset === 960) {
        const p = next.candidatesByPerson[0]!.posePresentation!;
        assert.equal(p.library_candidates.length, 5);
        assert.equal(p.review_candidates[0]!.rank, 1);
      }
      if (offset === 980) assert.equal(next.semantic!.paging!.nextCursor, null);
    }
    assert.equal(calls, 1000);
    const saved = JSON.parse(
      (await db.query<{ result_json: string }>("SELECT result_json FROM jobs"))
        .rows[0]!.result_json,
    );
    assert.equal(
      new Set(
        saved.candidatesByPerson[0].candidates.map((c: { id: string }) => c.id),
      ).size,
      1000,
    );
    assert.equal(
      (await db.query("SELECT * FROM confirmed_selections")).rows.length,
      1,
    );
    const ctx = JSON.parse(
      (
        await db.query<{ refine_context_json: string }>(
          "SELECT refine_context_json FROM analysis_people",
        )
      ).rows[0]!.refine_context_json,
    );
    assert.equal(ctx.custom, "preserve");
    assert.equal(Object.keys(ctx.posePresentationAssets).length, 1000);
    await db.query("DELETE FROM jobs WHERE id=$1", [jobId]);
    assert.equal(
      (await db.query("SELECT * FROM semantic_snapshots")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
