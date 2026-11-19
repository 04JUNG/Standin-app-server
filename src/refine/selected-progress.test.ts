import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { createRefineRoutes } from "./routes.js";

function setup(mode: "execute" | "skip" | "fail" | "unowned" | "forbidden" | "targets") {
  const sha = "a".repeat(64);
  const candidate = {id:"pose::front",poseId:"pose",source:"library",presentationKind:"library_match",
    refineAllowed:mode !== "forbidden",lookupAllowed:true,manualExportAllowed:true,reviewRequired:true,notExactMatch:false,
    sourceBvhSha256:sha,camera:{version:"candidate-camera-v2",pose_id:"pose",source_bvh_sha256:sha,query_sha256:sha}};
  const job = {inputWidth:400,inputHeight:800,result:{source:"capture",candidatesByPerson:[{personIndex:1,candidates:[candidate]}]}} as unknown as Job;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {finish = resolve;});
  const app = new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("installationId","inst_test");c.set("requestId","test");await next();});
  app.route("/",createRefineRoutes({getOwnedJob:async()=>mode === "unowned" ? undefined : job,
    validateExportCandidate:async()=>true,
    runRefine:async(input)=>{
      if (mode !== "skip") {input.onProgress?.("refining", mode === "targets" ? {
        keypoints: Array.from({length:17},(_,i)=>[10*i,20*i]), scores:Array(17).fill(1), refineAllowed:true,
        refinableLimbs:["left_arm"], lowerBodyObserved:false, skeletonState:"partial", coverageClass:"upper_only",slotOrigin:"vlm",skeletonSource:"full_image",
      } : undefined);await pending;input.onProgress?.("preparing");}
      if (mode === "fail") throw new Error("failed");
      return {poseId:"pose",refined:mode !== "skip",reasonCode:mode === "skip" ? "feature_disabled" : "ok",adjustedLimbs:[],thumbnailAvailable:false};
    },
  }));
  const request = (stream = true) => app.request(`/job_test/people/1/refine${stream ? "?progress=selected-refine-v1" : ""}`, {
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:"pose::front"}),
  });
  return {request,finish};
}
test("selected stream delivers execution before result, with exact selected identity", async()=>{
  const {request,finish}=setup("execute");
  const response=await request();
  assert.match(response.headers.get("Content-Type")!,/ndjson/);
  const reader=response.body!.getReader();
  const first=JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.deepEqual(first,{type:"progress",jobId:"job_test",personIndex:1,candidateId:"pose::front",phase:"refining"});
  finish();
  let text="";for (;;) {const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
  const events=text.trim().split("\n").map(v=>JSON.parse(v));
  assert.equal(events[0].phase,"preparing");assert.equal(events[1].body.refined,true);
});
test("selected target extension is normalized, identity-bound and absent during file preparation", async()=>{
  const {request,finish}=setup("targets");const response=await request();finish();
  const events=(await response.text()).trim().split("\n").map(v=>JSON.parse(v));
  assert.deepEqual(events[0].target.targetJoints,[7,9]);
  assert.deepEqual(events[0].target.skeleton.points[7],[.175,.175]);
  assert.equal(events[0].candidateId,"pose::front");assert.equal(events[0].personIndex,1);
  assert.equal(events[1].target,undefined);assert.doesNotMatch(JSON.stringify(events[0]),/keypoints|scores|refinableLimbs/);
});
test("skipped and legacy requests do not invent execution",async()=>{
  const {request}=setup("skip");
  const stream=await request();const events=(await stream.text()).trim().split("\n").map(v=>JSON.parse(v));
  assert.equal(events.length,1);assert.equal(events[0].type,"result");assert.equal(events[0].body.refined,false);
  const legacy=await request(false);assert.match(legacy.headers.get("Content-Type")!,/json/);assert.equal((await legacy.json() as {refined:boolean}).refined,false);
});
test("failed execution terminates as failure; authorization precedes streaming",async()=>{
  const {request,finish}=setup("fail");const response=await request();finish();
  const events=(await response.text()).trim().split("\n").map(v=>JSON.parse(v));
  assert.equal(events.at(-1).status,503);assert.equal(events.at(-1).body.error.code,"REFINE_UNAVAILABLE");
  for (const mode of ["unowned","forbidden"] as const) {
    const response=await setup(mode).request();assert.equal(response.status,mode === "unowned" ? 404 : 409);
    assert.doesNotMatch(response.headers.get("Content-Type")!,/ndjson/);
  }
});
