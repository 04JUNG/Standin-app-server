/** Loopback-only wire QA: actual routes/orchestration, synthetic ownership/storage/upstream. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRefineRoutes } from "../src/refine/routes.js";
import { runRefine, type RefineDeps } from "../src/refine/service.js";
import type { Job } from "../src/jobs/store.js";
import type { AppEnv } from "../src/env.js";
const sha = "a".repeat(64);
const candidate = {id:"qa-pose",poseId:"qa-pose",source:"library",presentationKind:"library_match",
  refineAllowed:true,lookupAllowed:true,manualExportAllowed:true,reviewRequired:true,notExactMatch:false,
  sourceBvhSha256:sha,camera:{version:"candidate-camera-v2",pose_id:"qa-pose",source_bvh_sha256:sha,query_sha256:sha}};
let complete: ((fail: boolean) => void) | undefined;
const deps: RefineDeps = {
  featureEnabled: () => true, storageAvailable: () => true,
  loadCandidate: async () => ({poseId:"qa-pose",view:"front",distance:0.1}),
  loadRefineContext: async () => ({keypoints:[[122,44],[0,0],[0,0],[0,0],[0,0],[94,92],[138,85],[68,140],[178,73],[42,176],[202,33],[105,180],[135,180],[88,236],[160,233],[76,281],[184,282]],scores:[0,0,0,0,0,...Array(12).fill(1)],
    refineAllowed:true,refinableLimbs:["left_arm"],skeletonState:"valid",coverageClass:"full",slotOrigin:"vlm",skeletonSource:"full_image",lowerBodyObserved:true}),
  findRefinedArtifact: async () => null, saveRefinedArtifact: async () => {},
  putRefinedBvh: async () => {}, putRefinedThumbnail: async () => {},
  refineUpstream: async () => {
    const fail = await new Promise<boolean>((resolve) => {complete = resolve;});
    complete = undefined;
    if (fail) throw new Error("controlled upstream failure");
    return {refined:false,reason:"no_gain",limbs:[],bvh:null};
  },
};
const app=new Hono<AppEnv>();
  app.use("*",cors({origin:["http://127.0.0.1:1431", "http://127.0.0.1:5195"]}));
app.use("*",async(c,next)=>{c.set("installationId","qa_local_only");c.set("requestId","qa_wire");await next();});
app.post("/qa/finish",c=>{complete?.(c.req.query("fail")==="1");return c.json({ok:true});});
app.route("/v1/analysis/jobs",createRefineRoutes({
  getOwnedJob:async(jobId,owner)=>jobId === "qa_job" && owner === "qa_local_only"
    ? {inputWidth:250,inputHeight:315,result:{source:"capture",candidatesByPerson:[{personIndex:0,candidates:[candidate]}]}} as unknown as Job : undefined,
  validateExportCandidate:async(_owner,job,person,candidate)=>job === "qa_job" && person === 0 && candidate === "qa-pose",
  runRefine:(input)=>runRefine(input,deps),
}));
const port = Number(process.env.SELECTED_REFINE_QA_PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid loopback QA port");
serve({fetch:app.fetch,hostname:"127.0.0.1",port});
console.log(`Loopback BFF QA on 127.0.0.1:${port}; upstream is controlled fixture, not real inference`);
