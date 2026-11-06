/** Offline integration regressions: real runner + PGlite + mocked inference. */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { pool, SCHEMA } from "../db.js";
import type { AppEnv } from "../env.js";
import type { CutResult } from "../inference.js";
import { log, type LogFields } from "../log.js";
import { jobsRoutes } from "./routes.js";
import { runAnalysisJob } from "./runner.js";
import { getOwnedJob } from "./store.js";

const cut: CutResult = {
  route: "core", count_confidence: "low", detector_count: 3, vlm_count: 3, notes: [],
  image: {width:100,height:200},
  people: Array.from({length:3},(_,index)=>({ index,box:null,tags:{},skeleton:null,
    confidence:"low",candidates:[] })),
  inference_metadata: {deployment_version:"offline",vlm_provider:"offline",vlm_model:"offline",
    pose_backend:"offline",pose_model_version:"offline",pose_library_version:"offline",feature_version:1},
};

for (const legacySelectCount of [true,false]) test(
  `inline completed analysis publishes result and status with ${legacySelectCount ? "legacy zero SELECT rowCount" : "pg-compatible rowCount"}`, async t => {
  const db=new PGlite();t.after(()=>db.close());await db.exec(SCHEMA);
  const query=async(sql:string,params?:unknown[])=>{
    const r=await db.query(sql,params);
    return {rows:r.rows,rowCount:legacySelectCount ? (r.affectedRows??r.rows.length) : (r.rows.length||r.affectedRows||0)};
  };
  const selected=await query("SELECT NULL AS quality_consent_id");
  assert.equal(selected.rows.length,1);
  if(legacySelectCount) assert.equal(selected.rowCount,0); // live QA failure shape
  t.mock.method(pool,"query",query as typeof pool.query);
  t.mock.method(pool,"connect",(async()=>({query,release(){}})) as unknown as typeof pool.connect);
  const now=new Date().toISOString();
  await db.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id) VALUES ('job_offline','queued',$1,$1,'owner')",[now]);
  let calls=0;const messages:LogFields[]=[];
  t.mock.method(log,"info",(fields:LogFields)=>{messages.push(fields);});
  t.mock.method(globalThis,"fetch",async()=>{
    calls++;return new Response(JSON.stringify(cut),{headers:{"content-type":"application/json"}});
  });
  await runAnalysisJob("job_offline",new Blob(["offline fixture"]));
  assert.equal(calls,1); // never a real inference/model request
  const job=await getOwnedJob("job_offline","owner");
  assert.equal(job?.status,"completed");assert.equal(job?.result?.candidatesByPerson.length,3);
  assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM analysis_people WHERE job_id='job_offline'")).rows[0].count,3);
  const row=(await db.query<{result_json:string;completed_at:string}>("SELECT result_json,completed_at FROM jobs WHERE id='job_offline'")).rows[0];
  assert.ok(row.completed_at);assert.equal(JSON.parse(row.result_json).jobId,"job_offline");
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("installationId",c.req.header("x-owner")??"");c.set("requestId","req_offline");await next();});
  app.route("/v1/analysis/jobs",jobsRoutes);
  assert.equal((await app.request("/v1/analysis/jobs/job_offline",{headers:{"x-owner":"other"}})).status,404);
  const status=await(await app.request("/v1/analysis/jobs/job_offline",{headers:{"x-owner":"owner"}})).json() as {status:string;progress?:unknown};
  assert.equal(status.status,"completed");assert.equal(status.progress,undefined);
  assert.equal(messages.filter(m=>m.type==="analysis_job"&&m.jobStatus==="completed").length,1);
});

test("an obsolete worker cannot publish a result or log completed after its lease was replaced",async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec(SCHEMA);
  const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows||0};};
  t.mock.method(pool,"query",query as typeof pool.query);
  t.mock.method(pool,"connect",(async()=>({query,release(){}})) as unknown as typeof pool.connect);
  const now=new Date().toISOString(),expires=new Date(Date.now()+60_000).toISOString();
  await db.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id,lease_owner,attempt_count,lease_expires_at) VALUES ('job_replaced','running',$1,$1,'owner','worker-a',1,$2)",[now,expires]);
  const messages:LogFields[]=[];t.mock.method(log,"info",(fields:LogFields)=>{messages.push(fields);});
  t.mock.method(globalThis,"fetch",async()=>{
    await db.query("UPDATE jobs SET lease_owner='worker-b',attempt_count=2 WHERE id='job_replaced'");
    return new Response(JSON.stringify(cut),{headers:{"content-type":"application/json"}});
  });
  await runAnalysisJob("job_replaced",new Blob(["offline fixture"]),"",true,{workerId:"worker-a",attempt:1});
  const job=await getOwnedJob("job_replaced","owner");
  assert.equal(job?.status,"running");assert.equal(job?.result,null);
  assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM analysis_people WHERE job_id='job_replaced'")).rows[0].count,0);
  assert.equal(messages.some(m=>m.jobStatus==="completed"),false);
  assert.ok(messages.some(m=>m.jobStatus==="ignored"&&m.errorCode==="JOB_NOT_CURRENT"));
});
