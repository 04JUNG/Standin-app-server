import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createRefineRoutes } from "./routes.js";
import { releaseEnabled, releaseCamera } from "./release.js";

test("RC4 is explicitly opt-in",()=>{
 const old=process.env.REFINE_RELEASE_ENABLED;
 try {delete process.env.REFINE_RELEASE_ENABLED;assert.equal(releaseEnabled(),false);process.env.REFINE_RELEASE_ENABLED="1";assert.equal(releaseEnabled(),true);}
 finally{if(old===undefined)delete process.env.REFINE_RELEASE_ENABLED;else process.env.REFINE_RELEASE_ENABLED=old;}
});
test("camera receipt requires complete finite projection",()=>{
 const c={camera:[[1,0,0],[0,1,0],[0,0,1]],origin:[0,0,0],anchor_camera_xyz:[0,0,0],projection:"orthographic",inverse_distance:0,pixel_scale:300,offset:[220,500],image_size:[535,687],embedded_in_fbx:false};
 assert.equal(releaseCamera.safeParse(c).success,true);
 for(const bad of [{...c,pixel_scale:0},{...c,inverse_distance:-1},{...c,camera:[[1,0,0],[0,NaN,0],[0,0,1]]},{...c,image_size:undefined}])assert.equal(releaseCamera.safeParse(bad).success,false);
});
test("unowned jobs cannot trigger a real RC4 call or download",async()=>{
 const old=process.env.REFINE_RELEASE_ENABLED;process.env.REFINE_RELEASE_ENABLED="1";
 try {
  let validations=0,legacy=0;
  const app=new Hono<AppEnv>();app.use("*",async(c,next)=>{c.set("installationId","inst_test");c.set("requestId","test");await next();});
  app.route("/",createRefineRoutes({getOwnedJob:async()=>undefined,validateExportCandidate:async()=>{validations++;return true;},runRefine:async()=>{legacy++;throw new Error("must not run");}}));
  const post=await app.request("/job_other/people/0/refine",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidateId:"pose",releaseVersion:"RC4"})});
  assert.equal(post.status,404);
  for(const artifact of ["fbx","preview"]){const r=await app.request(`/job_other/people/0/refine/release/${artifact}?candidateId=pose`);assert.equal(r.status,404);}
  assert.equal(validations,0);assert.equal(legacy,0);
 }finally{if(old===undefined)delete process.env.REFINE_RELEASE_ENABLED;else process.env.REFINE_RELEASE_ENABLED=old;}
});

import { releaseCandidateAllowed, candidateRefineAllowed } from "./eligibility.js";
import type { PoseCandidate } from "../types.js";
test("RC4 uses owned original asset eligibility independently of legacy skeleton camera",()=>{
 const c={source:"library",poseId:"original",lookupAllowed:true,manualExportAllowed:true,bvhAvailable:true,sourceBvhSha256:"a".repeat(64),refineAllowed:false} as PoseCandidate;
 assert.equal(candidateRefineAllowed(c),false);
 assert.equal(releaseCandidateAllowed(c),true);
 for(const change of [{source:"semantic"},{source:"generation"},{lookupAllowed:false},{manualExportAllowed:false},{bvhAvailable:false},{sourceBvhSha256:"bad"},{poseId:null}])assert.equal(releaseCandidateAllowed({...c,...change} as PoseCandidate),false);
});

import type { Job } from "../jobs/store.js";
test("RC4 request falls back to legacy refine when staging release gate is off", async () => {
 const old = process.env.REFINE_RELEASE_ENABLED; process.env.REFINE_RELEASE_ENABLED = "0";
 try {
  const sha = "a".repeat(64);
  const candidate = { id:"pose::front", poseId:"pose", source:"library", presentationKind:"library_match",
   refineAllowed:true, lookupAllowed:true, manualExportAllowed:true, reviewRequired:true, notExactMatch:false,
   sourceBvhSha256:sha, camera:{version:"candidate-camera-v2",pose_id:"pose",source_bvh_sha256:sha,query_sha256:sha} };
  const owned = {result:{source:"capture",candidatesByPerson:[{personIndex:0,candidates:[candidate]}]}} as unknown as Job;
  let calls = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async(c,next)=>{c.set("installationId","inst_test");c.set("requestId","test");await next();});
  app.route("/",createRefineRoutes({getOwnedJob:async()=>owned,validateExportCandidate:async()=>true,
   runRefine:async(input)=>{calls++;assert.equal(input.deferPreview,true);return {
    poseId:"pose",refined:true,reasonCode:"accepted",adjustedLimbs:["left_arm"],thumbnailAvailable:false,
   };},
  }));
  const response = await app.request("/job_test/people/0/refine",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({candidateId:"pose::front",releaseVersion:"RC4",deferPreview:true})});
  assert.equal(response.status,200);
  const body = await response.json() as {refined:boolean;release?:unknown;exportUrl:string};
  assert.equal(calls,1);assert.equal(body.refined,true);assert.equal(body.release,undefined);
  assert.ok(body.exportUrl.startsWith("/v1/pose-candidates/pose/export?"));
 } finally {if(old===undefined)delete process.env.REFINE_RELEASE_ENABLED;else process.env.REFINE_RELEASE_ENABLED=old;}
});
