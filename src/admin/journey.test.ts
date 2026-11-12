import assert from "node:assert/strict";
import test from "node:test";
import { buildJourney, type JourneyEvent, type JourneyRow } from "./journey.js";
const w={from:"2026-10-21T00:00:00.000Z",to:"2026-10-27T00:00:00.000Z",days:6,idleMinutes:30,audience:"all"};
const time="2026-10-22T00:00:00.000Z";
function event(name:string,extra:Partial<JourneyEvent>={}):JourneyEvent{return {name,first:time,last:time,count:1,version:2,native:false,session:true,...extra};}
function job(extra:Partial<JourneyRow>={}):JourneyRow{return {id:"job",installation_id:"inst",audience:"unclassified",created_at:"2026-10-21T01:00:00.000Z",completed_at:"2026-10-21T01:01:00.000Z",status:"completed",confirmed_at:null,events:[],last_outcome:null,last_outcome_at:null,...extra};}
test("old/no telemetry never becomes client dropout or a native save",()=>{
 const r=buildJourney([job(),job({id:"legacy",events:[event("export_completed",{version:0,native:true})]})],w);
 assert.equal(r.totals.unobservableJobs,2);assert.equal(r.outcomes.unobservable,2);
 assert.equal(r.stages.at(-1)?.jobs,0);
 assert.equal(r.transitions.find(t=>t.to==="results_viewed")?.unobservable,2);
});
test("version2 browser mock is not real native save; repeated native event counts a job once",()=>{
 const r=buildJourney([job({events:[event("export_completed")]}),job({id:"native",events:[event("export_completed",{native:true,count:4})]})],w);
 assert.equal(r.stages.at(-1)?.jobs,1);assert.equal(r.outcomes.saved,1);
});
test("missing intermediate events are unobservable, not no-next-event",()=>{
 const r=buildJourney([job({events:[event("review_viewed")]})],w);
 assert.equal(r.transitions.find(t=>t.to==="results_viewed")?.unobservable,1);
 assert.equal(r.transitions.find(t=>t.to==="results_viewed")?.noNextEvent,0);
});
test("failed, cancelled, recent waiting and mature unobserved next events stay distinct",()=>{
 const rows=[job({id:"f",events:[event("results_viewed")],last_outcome:"preparation_failed"}),
 job({id:"c",events:[event("results_viewed")],last_outcome:"export_cancelled"}),
 job({id:"w",events:[event("results_viewed",{first:"2026-10-26T23:59:00.000Z",last:"2026-10-26T23:59:00.000Z"})]}),
 job({id:"n",events:[event("results_viewed")]})];
 const r=buildJourney(rows,w);
 assert.deepEqual(r.outcomes,{saved:0,failed:1,cancelled:1,waiting:1,noNextEvent:1,unobservable:0});
 for(const t of r.transitions) assert.equal(t.reached,t.advanced+t.waiting+t.noNextEvent+t.unobservable+t.failed+t.cancelled);
});
test("first native save survives later retry failure and does not invent previous stages",()=>{
 const r=buildJourney([job({events:[event("export_completed",{native:true})],last_outcome:"export_failed"})],w);
 assert.equal(r.outcomes.saved,1);assert.equal(r.stages.find(s=>s.key==="candidate_selected")?.jobs,0);
 assert.equal(r.durations.find(d=>d.key==="firstSave")?.samples,1);
});
test("no session and future events cannot establish observable coverage",()=>{
 const r=buildJourney([job({events:[event("results_viewed",{session:false}),event("export_completed",{native:true,first:"2027-01-01T00:00:00Z",last:"2027-01-01T00:00:00Z"})]})],w);
 assert.equal(r.coverage.version2Jobs,0);assert.equal(r.stages.at(-1)?.jobs,0);
});
test("audience noninternal is explicitly unclassified and installations deduplicate",()=>{
 const r=buildJourney([job(),job({id:"j2"}),job({id:"j3",installation_id:"other",audience:"internal"})],w);
 assert.equal(r.totals.jobs,3);assert.equal(r.totals.installations,2);
 assert.deepEqual(r.audiences,[{key:"internal",jobs:1,installations:1},{key:"unclassified",jobs:2,installations:1}]);
});

test("duration percentiles interpolate consistently with PostgreSQL percentile_cont",()=>{
 const r=buildJourney([job({completed_at:'2026-10-21T01:00:10.000Z'}),job({id:'two',completed_at:'2026-10-21T01:00:30.000Z'})],w);
 assert.equal(r.durations[0].medianMs,20000);assert.equal(r.durations[0].p90Ms,28000);
});

test("known running or queued work remains waiting beyond the inactivity threshold",()=>{
 const r=buildJourney([job({status:'running',completed_at:null}),job({id:'queued',status:'queued',completed_at:null})],w);
 assert.equal(r.outcomes.waiting,2);assert.equal(r.outcomes.unobservable,0);
 assert.equal(r.transitions[0].waiting,2);assert.equal(r.transitions[0].noNextEvent,0);
});
