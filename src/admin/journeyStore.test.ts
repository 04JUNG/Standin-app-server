import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { JOURNEY_SQL, JOURNEY_INPUT_SQL, JOURNEY_DURATION_SQL } from "./journeyStore.js";
import { buildJourney, type JourneyRow } from "./journey.js";
const window={from:"2026-10-21T00:00:00.000Z",to:"2026-10-27T00:00:00.000Z",days:6,idleMinutes:30,audience:"all"};
test("SQL keeps cohort, audience, native-write and retry duration contracts",async()=>{
 const db=new PGlite();
 try {
 await db.exec(`CREATE TABLE quality_review_jobs(id text,installation_id text,created_at text,completed_at text,status text);
 CREATE TABLE internal_installations(id text);
 CREATE TABLE quality_review_confirmed_selections(job_id text,confirmed_at text);
 CREATE TABLE quality_review_analytics_events(event_id text PRIMARY KEY,job_id text,installation_id text,event_name text,occurred_at text,sequence_number int,properties_json text);
 INSERT INTO quality_review_jobs VALUES ('job','inst','2026-10-22T00:00:00.000Z','2026-10-22T00:00:10.000Z','completed'),('internal','dev','2026-10-22T00:00:00.000Z',null,'failed'),('old','inst','2026-10-01T00:00:00.000Z',null,'completed');
 INSERT INTO internal_installations VALUES ('dev');`);
 let seq=0;
 const event=async(name:string,time:string,attempt:string,extra:Record<string,unknown>={},job:string|null='job')=>db.query(
 'INSERT INTO quality_review_analytics_events VALUES ($1,$2,$3,$4,$5,$6,$7)',
 [`e${++seq}`,job,'inst',name,`2026-10-22T00:${time}.000Z`,seq,JSON.stringify({telemetryVersion:2,sessionId:'session1',attemptId:attempt,appVersion:'0.2.5',surface:'bar',...extra})]);
 await event('results_viewed','00:11','a');
 await event('preparation_started','00:12','prep1');
 await event('preparation_failed','00:14','prep1');
 await event('preparation_started','00:20','prep2');
 await event('preparation_ready','00:25','prep2');
 await event('export_requested','00:30','save1');
 await event('export_cancelled','00:32','save1');
 await event('export_requested','00:40','save2');
 await event('export_completed','00:45','save2',{nativeDiskWrite:true});
 await event('export_completed','00:46','save2',{nativeDiskWrite:true}); // duplicate terminal should not double attempts
 await event('input_started','00:01','input1',{},null);
 await event('input_cancelled','00:02','input1',{},null);
 const params=[window.from,window.to,'unclassified'];
 const raw=(await db.query<JourneyRow>(JOURNEY_SQL,params)).rows;
 assert.equal(raw.length,1);assert.equal(raw[0].last_outcome,'export_completed');
 const result=buildJourney(raw,{...window,audience:'unclassified'});
 assert.equal(result.outcomes.saved,1);assert.equal(result.coverage.version2Jobs,1);
 assert.deepEqual(result.segments,[{appVersion:'0.2.5',surface:'bar',jobs:1,installations:1,savedJobs:1}]);
 assert.equal(result.diagnostics.find(d=>d.key==='preparation_failed')?.jobs,1);
 assert.equal(result.diagnostics.find(d=>d.key==='export_cancelled')?.events,1);
 const durations=(await db.query<{key:string;samples:number;medianMs:number}>(JOURNEY_DURATION_SQL,params)).rows;
 assert.equal(durations.find(d=>d.key==='preparation')?.medianMs,5000);
 assert.equal(durations.find(d=>d.key==='nativeSave')?.medianMs,5000);
 assert.equal(durations.find(d=>d.key==='nativeSave')?.samples,1);
 const inputs=(await db.query<{key:string;events:number}>(JOURNEY_INPUT_SQL,params)).rows;
 assert.equal(inputs.find(d=>d.key==='input_started')?.events,1);
 assert.equal((await db.query(JOURNEY_SQL,[window.from,window.to,'internal'])).rows.length,1);
 // A completion from browser fallback must not clear a failed real export attempt.
 await event('export_failed','00:50','save3');
 await event('export_completed','00:51','save3',{nativeDiskWrite:false});
 assert.equal((await db.query<JourneyRow>(JOURNEY_SQL,params)).rows[0].last_outcome,'export_failed');
 } finally {await db.close();}
});
