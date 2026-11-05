import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProgress, translateObservations } from "./progress.js";
import { readAnalysisStream, ProgressStreamError } from "./progressStream.js";
import { publicProgress } from "./progressStore.js";

const base = () => ({ version: "pose-analysis-progress.v1", sequence: 1, stage: "extracting",
  completedStages: ["analyzing"], skippedStages: [], people: [] as unknown[] });
test("allowlist masks invalid coordinates, translates only explicit observations and removes secrets", () => {
  const p = base();
  p.people.push({ personIndex: 0, skeleton: { format: "coco17", coordinateSpace: "image-normalized",
    points: [[.1,.2], ...Array(4).fill(null), [.3,.4], [NaN,.4], [-1,1], ...Array(9).fill(null)] },
    observations: { arms: "raised", torso: "forward", knees: "unknown", context: "private" },
    searchMode: "combined", quality_trace: { prompt: "secret" },
    candidates: [{ id: "test_pose::front", rank: 2, thumbnailUrl: "/pose/test_pose/thumbnail?view=front", raw: "private" },
      { id: "bad::front", rank: 1, thumbnailUrl: "https://attacker.test/img" }] });
  const safe = sanitizeProgress(p)!;
  assert.deepEqual(safe.people[0].skeleton?.points.slice(0, 8), [null,null,null,null,null,[.3,.4],null,null]);
  assert.deepEqual(safe.people[0].observations, [{ id: "arms:raised", label: "올린 팔" }, { id: "torso:forward", label: "앞으로 기운 상체" }]);
  assert.equal(safe.people[0].candidates?.length, 1);
  assert.match(safe.people[0].candidates![0].thumbnailUrl, /^\/v1\/pose-candidates\/test_pose\/thumbnail/);
  assert.doesNotMatch(JSON.stringify(safe), /private|secret|prompt|quality_trace|attacker/);
});
test("unknown/malformed snapshots degrade; cumulative multi-person indexes stay explicit", () => {
  assert.equal(sanitizeProgress({ ...base(), version: "v2" }), undefined);
  assert.equal(sanitizeProgress({ ...base(), sequence: -1 }), undefined);
  assert.equal(sanitizeProgress({ ...base(), skippedStages: ["analyzing"] }), undefined);
  assert.equal(sanitizeProgress({ ...base(), people: [{ personIndex: 0 }, { personIndex: 0 }] }), undefined);
  assert.deepEqual(sanitizeProgress({ ...base(), activePersonIndex: 3, people: [{personIndex: 3}, {personIndex: 1}] })?.people.map(p => p.personIndex), [1,3]);
  assert.deepEqual(translateObservations({ arms: "__proto__", torso: "made up" }), []);
  assert.equal(publicProgress("completed", sanitizeProgress(base())), undefined);
  assert.equal(publicProgress("failed", sanitizeProgress(base())), undefined);
});
const response = (records: unknown[]) => new Response(records.map(r => JSON.stringify(r)+"\n").join(""));
test("terminal result returns immediately and no late progress is accepted", async () => {
  const seen: unknown[] = [];
  const actual = await readAnalysisStream(response([
    {type:"progress",progress:base()}, {type:"result",result:{ people:[] }},
    {type:"progress",progress:{...base(), sequence:2}},
  ]), p => seen.push(p));
  assert.deepEqual(actual, { people: [] });
  assert.equal(seen.length, 1);
});
test("sink failure cannot fail analysis; upstream 503 detail remains classifiable", async () => {
  assert.deepEqual(await readAnalysisStream(response([{type:"progress",progress:base()}, {type:"result",result:{ok:true}}]), () => {throw Error("db down");}), {ok:true});
  await assert.rejects(readAnalysisStream(response([{type:"error",status:503,detail:{code:"VLM_UNAVAILABLE",reason:"rate_limited"}}]), () => {}), (e: unknown) => e instanceof ProgressStreamError && e.status === 503 && e.detail.includes("rate_limited"));
  await assert.rejects(readAnalysisStream(response([{type:"progress",progress:base()}]), () => {}), /without result/);
});
test("UTF8 and records can split at any byte", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({type:"progress",progress:{text:"관측"}})+"\n"+JSON.stringify({type:"result",result:{ok:true}})+"\n");
  let i=0; const seen: unknown[]=[];
  const stream = new ReadableStream({pull(controller) { if (i===bytes.length) controller.close(); else controller.enqueue(bytes.slice(i,++i)); }});
  assert.deepEqual(await readAnalysisStream(new Response(stream), p => seen.push(p)), {ok:true});
  assert.deepEqual(seen, [{text:"관측"}]);
});

test("PostgreSQL atomic fences cover retries, reordering, lease expiry, terminal writes and ownership", async t => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pool, SCHEMA } = await import("../db.js");
  const { beginProgress, writeProgress } = await import("./progressStore.js");
  const { claimJob, getOwnedJob, updateJob, failJob } = await import("./store.js");
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(SCHEMA); await db.exec(SCHEMA);
  t.mock.method(pool, "query", (async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  }) as typeof pool.query);
  const now = new Date().toISOString();
  await db.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id,input_s3_key) VALUES ('job_progress','queued',$1,$1,'owner','private/input')", [now]);
  const first = await claimJob("job_progress", "worker-a", 60);
  assert.equal(first?.attemptCount, 1);
  const run = (await beginProgress("job_progress", {workerId:"worker-a",attempt:1}))!;
  assert.ok(run);
  assert.equal(await beginProgress("job_progress", {workerId:"worker-a",attempt:1}), undefined);
  assert.equal(await beginProgress("job_progress", {workerId:"wrong",attempt:1}), undefined);
  assert.equal(await writeProgress(run, {...base(),sequence:3}), true);
  assert.equal(await writeProgress(run, {...base(),sequence:2}), false);
  assert.equal(await writeProgress(run, {...base(),sequence:3}), false);
  const owned = await getOwnedJob("job_progress", "owner");
  assert.equal((owned!.progress as {sequence:number}).sequence, 1);
  assert.equal(await getOwnedJob("job_progress", "other"), undefined);
  await db.query("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id='job_progress'");
  assert.equal(await writeProgress(run, {...base(),sequence:4}), false);
  const second = await claimJob("job_progress", "worker-b", 60);
  assert.equal(second?.attemptCount, 2);
  const retry = (await beginProgress("job_progress", {workerId:"worker-b",attempt:2}))!;
  assert.ok(retry);
  await updateJob("job_progress", {status:"completed"}, {workerId:"worker-a",attempt:1});
  assert.equal((await getOwnedJob("job_progress","owner"))?.status,"running");
  assert.equal(await failJob("job_progress","INFERENCE_FAILED",{fence:{workerId:"worker-a",attempt:1}}),false);
  assert.equal(await writeProgress(run, {...base(),sequence:99}), false);
  assert.equal(await writeProgress(retry, {...base(),sequence:1}), true);
  assert.equal(((await getOwnedJob("job_progress","owner"))!.progress as {sequence:number}).sequence, 2);
  await db.query("UPDATE jobs SET status='completed' WHERE id='job_progress'");
  assert.equal(await writeProgress(retry, {...base(),sequence:2}), false);
  await db.query("UPDATE jobs SET status='failed' WHERE id='job_progress'");
  assert.equal(await writeProgress(retry, {...base(),sequence:3}), false);
});

test("owned Job status GET exposes live snapshots and terminal status takes precedence", async t => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pool, SCHEMA } = await import("../db.js");
  const { Hono } = await import("hono");
  const { jobsRoutes } = await import("./routes.js");
  const db = new PGlite(); t.after(() => db.close()); await db.exec(SCHEMA);
  t.mock.method(pool, "query", (async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values); return {rows:r.rows,rowCount:r.rows.length||r.affectedRows||0};
  }) as typeof pool.query);
  const p = sanitizeProgress(base())!;
  await db.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id,progress_json) VALUES ('job_http','running','today','today','owner',$1::jsonb)", [JSON.stringify(p)]);
  const app = new Hono<import("../env.js").AppEnv>();
  app.use("*", async (c,next) => { c.set("installationId", c.req.header("x-owner") ?? ""); c.set("requestId", "req_test"); await next(); });
  app.route("/v1/analysis/jobs", jobsRoutes);
  const url = "/v1/analysis/jobs/job_http";
  assert.equal((await app.request(url,{headers:{"x-owner":"other"}})).status,404);
  let body = await (await app.request(url,{headers:{"x-owner":"owner"}})).json() as Record<string, unknown>;
  assert.deepEqual(body.progress, p);
  assert.equal(body.status,"running");
  for (const status of ["completed","failed"]) {
    await db.query("UPDATE jobs SET status=$1 WHERE id='job_http'",[status]);
    body = await (await app.request(url,{headers:{"x-owner":"owner"}})).json() as Record<string,unknown>;
    assert.equal(body.status,status); assert.equal(Object.hasOwn(body,"progress"),false);
  }
});

test("analyze opts into the same request and older JSON servers do not cause duplicate inference", async t => {
  const { analyze } = await import("../inference.js");
  let calls=0; const seen:unknown[]=[];
  t.mock.method(globalThis,"fetch",async (_url: unknown, init?: RequestInit) => {
    calls++; assert.equal((init?.headers as Record<string,string>).Accept,"application/x-ndjson");
    return new Response(JSON.stringify({people:[],image:{width:10,height:10}}),{headers:{"content-type":"application/json"}});
  });
  const cut=await analyze(new Blob(["offline image"]),"",p=>seen.push(p));
  assert.equal(calls,1); assert.equal(cut.people.length,0); assert.deepEqual(seen,[]);
});

test("storage writer coalesces to the newest snapshot without delaying terminal close", async () => {
  const { progressWriter } = await import("./progressStream.js");
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  const values:unknown[]=[];
  const writer=progressWriter(async p => { values.push(p); await gate; });
  writer.push(1); writer.push(2); writer.push(3);
  assert.deepEqual(values,[1]);
  writer.close(); release();
  await Promise.resolve(); await Promise.resolve();
  writer.push(4); assert.deepEqual(values,[1]);
});

test("stored malformed progress cannot break status or expose private fields", () => {
  assert.equal(publicProgress("running",{...base(),people:[{personIndex:0,observations:"bad"}]}),undefined);
  const safe=sanitizeProgress(base())!;
  const value=publicProgress("running",{...safe,private_prompt:"secret"});
  assert.deepEqual(value,safe);
  assert.equal(Object.hasOwn(value!,"private_prompt"),false);
});
