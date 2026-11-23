/** Loopback real-model input + real HTTP solver proof. No example/manual joint coordinates. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRefineRoutes } from "../src/refine/routes.js";
import { runRefine, type RefineDeps } from "../src/refine/service.js";
import { refine } from "../src/inference.js";
import { config } from "../src/config.js";
import type { Job } from "../src/jobs/store.js";
import type { AppEnv } from "../src/env.js";
import { selectedRefineTarget } from "../src/refine/selected-target.js";

if (!process.env.REAL_REFINE_INPUT || !process.env.REAL_REFINE_OUTPUT) throw new Error("explicit real input/output paths required");
if (!["localhost", "127.0.0.1"].includes(new URL(config.inferenceBaseUrl).hostname)) throw new Error("real QA is loopback-only");
const input = JSON.parse(await readFile(process.env.REAL_REFINE_INPUT, "utf8"));
if (!String(input.coordinate_source).startsWith("RTMPoseModel")) throw new Error("model-derived input required");
const out = resolve(process.env.REAL_REFINE_OUTPUT);await mkdir(out, {recursive:true});
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const image = await readFile(input.image.path);
if (hash(image) !== input.image.sha256) throw new Error("rough identity changed");
const d = input.descriptor;
const context = {keypoints:d.skeleton.keypoints,scores:d.skeleton.scores,refineAllowed:d.refine_allowed,
  refinableLimbs:d.refinable_limbs,lowerBodyObserved:d.lower_body_observed,skeletonState:d.skeleton_state,
  coverageClass:d.coverage_class,slotOrigin:d.slot_origin,skeletonSource:d.skeleton_source};
const candidateId = `${input.pose_id}::${input.search.view}`;
const candidate = {id:candidateId,poseId:input.pose_id,source:"library",presentationKind:"library_match",
  refineAllowed:true,lookupAllowed:true,manualExportAllowed:true,reviewRequired:true,notExactMatch:false,
  sourceBvhSha256:input.base_sha256,camera:{version:"candidate-camera-v2",pose_id:input.pose_id,source_bvh_sha256:input.base_sha256,query_sha256:input.image.sha256}};
const evidence: object[] = [];
const deps: RefineDeps = {
  featureEnabled:()=>true,storageAvailable:()=>true,
  loadCandidate:async()=>({poseId:input.pose_id,view:input.search.view,distance:input.search.distance}),
  loadRefineContext:async()=>context,findRefinedArtifact:async()=>null,
  saveRefinedArtifact:async artifact=>{await writeFile(resolve(out,"artifact.json"),JSON.stringify(artifact,null,2));},
  putRefinedBvh:async(_key,bytes)=>{await writeFile(resolve(out,"result.bvh"),bytes);},
  putRefinedThumbnail:async(_key,bytes)=>{await writeFile(resolve(out,"result.png"),bytes);},
  refineUpstream:async request=>{
    const startedAt=Date.now();
    await writeFile(resolve(out,"engine-request.json"),JSON.stringify(request,null,2));
    const response=await refine(request);
    await writeFile(resolve(out,"engine-response.json"),JSON.stringify(response,null,2));
    // Local Python API returns a BVH URL; BFF's existing contract expects inline text.
    // Fetch the real result bytes without changing geometry, decision or solver input.
    if(response.refined && !response.bvh){
      const url=new URL(response.bvh_url,config.inferenceBaseUrl);
      if(url.origin!==new URL(config.inferenceBaseUrl).origin)throw new Error("nonlocal BVH rejected");
      const file=await fetch(url);if(!file.ok)throw new Error("real result BVH unavailable");response.bvh=await file.text();
    }
    evidence.push({startedAt,endedAt:Date.now(),durationMs:Date.now()-startedAt,poseId:request.pose_id,
      keypointsSha256:hash(JSON.stringify(request.keypoints)),refined:response.refined,reason:response.reason,
      backend:response.backend,refineVersion:response.refine_version,limbs:response.limbs,diagnostics:response.diagnostics,
      resultBvhSha256:response.bvh?hash(response.bvh):null});
    await writeFile(resolve(out,"execution.json"),JSON.stringify(evidence,null,2));return response;
  },
};
const app=new Hono<AppEnv>();
app.use("*",cors({origin:"http://127.0.0.1:5200"}));
app.use("*",async(c,next)=>{c.set("installationId","real_local_qa");c.set("requestId","real_local_qa");await next();});
app.get("/qa/input",c=>c.json({jobId:"real_job",personIndex:0,candidateId,poseId:input.pose_id,
  roughUrl:"http://127.0.0.1:5198/qa/rough.png",fileName:basename(input.image.path),coordinateSource:input.coordinate_source,
  note:"actual RTMPose + actual local v2.5 solver; routing controls fixed; local file-backed ownership/storage"}));
app.get("/qa/rough.png",()=>new Response(image,{headers:{"Content-Type":"image/png"}}));
app.route("/v1/analysis/jobs",createRefineRoutes({
  getOwnedJob:async(jobId,owner)=>jobId==="real_job"&&owner==="real_local_qa"
    ?{inputWidth:input.image.width,inputHeight:input.image.height,result:{source:"capture",candidatesByPerson:[{personIndex:0,candidates:[candidate]}]}} as unknown as Job:undefined,
  validateExportCandidate:async(owner,job,person,candidate)=>owner==="real_local_qa"&&job==="real_job"&&person===0&&candidate===candidateId,
  runRefine:p=>runRefine({...p,onProgress:(phase,context)=>{
    const event={at:Date.now(),phase,...(phase==="refining"?{target:selectedRefineTarget(context,input.image.width,input.image.height)}:{})};
    void writeFile(resolve(out,`event-${phase}.json`),JSON.stringify(event,null,2));
    p.onProgress?.(phase,context);
  }},deps),
}));
serve({fetch:app.fetch,hostname:"127.0.0.1",port:5198});
console.log("Real RTMPose input + real local solver bridge ready on 5198; no hand coordinates or artificial wait");
