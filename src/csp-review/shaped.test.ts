import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createShapedCspRoutes, generateShapedVrm } from "./shaped.js";
import { shapeSha256, type BodyShape } from "../body-selection/shape.js";
import type { BodyAsset,BodySelection } from "../body-selection/model.js";
import type { AppEnv } from "../env.js";
import type { getOwnedJob } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";

const asset: BodyAsset = {bodyId:"male-base",bodyVersion:"0.7.6",characterId:"male-base-v0-7-6",assetSha256:"a".repeat(64),rigVersion:"test",measurementVersion:"test",supportedPoseIds:["pose"],cspNative:true,
  shape:{schemaVersion:"body-shape.v1",controls:[{key:"height",min:150,max:200,step:1,default:178},{key:"muscle",min:0,max:1,step:.1,default:0}]},
  shapeSource:{rules:"standin-body-0.7.6",blendSha256:"b".repeat(64),controllerSha256:"c".repeat(64)}};
const controls={height:183,muscle:.3};
const shape:BodyShape = {schemaVersion:"body-shape.v1",controls,shapeSha256:shapeSha256(asset,controls)};
const selection = {selectionRevision:2,resolutionStatus:"ready",resolvedBody:asset,shape} as unknown as BodySelection;
const bvh = new TextEncoder().encode("HIERARCHY\nROOT Hips {}\nMOTION\nFrames: 1\nFrame Time: 0.0333\n");
const model = new TextEncoder().encode("glTF-test");
const report = {schema:"csp-shape.v1",character_id:asset.characterId,character_sha256:asset.assetSha256,shape_sha256:shape.shapeSha256,source:asset.shapeSource!,controls:{height_cm:183,muscle:.3},artifact_sha256:sha256Hex(model),artifact_bytes:model.length,qa:{}};
const query = "/bundle?jobId=job_test&personIndex=0&candidateId=candidate&poseId=pose&bodySelectionRevision=2";
const job = (async()=>({result:{candidatesByPerson:[{personIndex:0}]}})) as unknown as typeof getOwnedJob;
function fixture(extra:Parameters<typeof createShapedCspRoutes>[1]={},fetcher:Parameters<typeof createShapedCspRoutes>[0]=()=>new Response(bvh)) {
  const app=new Hono<AppEnv>();app.use("*",async(c,next)=>{c.set("installationId","owner");c.set("requestId","test");await next();});
  app.route("/",createShapedCspRoutes(fetcher,{enabled:()=>true,selection:async()=>selection,catalog:()=>({version:"test",defaultCharacterId:asset.characterId,assets:[asset]}),job,generate:async()=>({bytes:model,report}),...extra}));return app;
}
test("selected shape and source are forwarded without dropping controls",async()=>{
  let seen:unknown;
  const app=fixture({generate:async input=>{seen=input;return{bytes:model,report};}});
  const r=await app.request(query);assert.equal(r.status,200);
  assert.deepEqual(seen,{character_id:asset.characterId,character_sha256:asset.assetSha256,shape,expected_shape_source:asset.shapeSource});
  assert.equal(r.headers.get("X-Standin-Shape-SHA256"),shape.shapeSha256);
});
test("default sliders remain an explicit shape and untouched hand suggestions are allowed",async()=>{
  let seen:unknown;
  const defaults={height:178,muscle:0};
  const hands=(async()=>({result:{candidatesByPerson:[{personIndex:0,handSelection:{revision:0,left:{suggested:true}}}]}})) as unknown as typeof getOwnedJob;
  const app=fixture({selection:async()=>({...selection,shape:null}),job:hands,generate:async input=>{seen=input;return{bytes:model,report};}});
  assert.equal((await app.request(query)).status,200);
  assert.deepEqual(seen,{character_id:asset.characterId,character_sha256:asset.assetSha256,shape:{schemaVersion:"body-shape.v1",controls:defaults,shapeSha256:shapeSha256(asset,defaults)},expected_shape_source:asset.shapeSource});
});
test("stale revision, unsupported body and hand selection do not call generator",async()=>{
  const never=async()=>{throw Error("not called");};
  assert.equal((await fixture({generate:never}).request(query.replace("Revision=2","Revision=1"))).status,409);
  assert.equal((await fixture({catalog:()=>({version:"x",defaultCharacterId:null,assets:[{...asset,cspNative:undefined}]}),generate:never}).request(query)).status,409);
  const hands=(async()=>({result:{candidatesByPerson:[{personIndex:0,handSelection:{revision:1}}]}})) as unknown as typeof getOwnedJob;
  assert.equal((await fixture({job:hands,generate:never}).request(query)).status,409);
});
test("body changes during bake discard output",async()=>{
  let calls=0;
  const app=fixture({selection:async()=>({...selection,selectionRevision:++calls===1?2:3})});
  assert.equal((await app.request(query)).status,409);
});
test("pose/refinement changes during bake discard output",async()=>{
  let calls=0;const app=fixture({},()=>new Response(++calls===1?bvh:new TextEncoder().encode("HIERARCHY changed")));
  assert.equal((await app.request(query)).status,409);
});
test("existing release refusal returns unchanged before shape baking",async()=>{
  const r=await fixture({generate:async()=>{throw Error("not called");}},()=>new Response("denied",{status:409})).request(query);
  assert.equal(r.status,409);assert.equal(await r.text(),"denied");
});
test("converter wrong source, wrong bytes and omitted slider are rejected",async()=>{
  const request={character_id:asset.characterId,character_sha256:asset.assetSha256,shape,expected_shape_source:asset.shapeSource!};
  const payload={vrm_base64:Buffer.from(model).toString("base64"),report};
  const response=(v:unknown)=>(async()=>new Response(JSON.stringify(v))) as typeof fetch;
  assert.equal((await generateShapedVrm(request,new AbortController().signal,response(payload))).bytes.length,model.length);
  for(const changed of [{...report,source:{...report.source,blendSha256:"d".repeat(64)}},{...report,artifact_sha256:"0".repeat(64)},{...report,controls:{height_cm:183}}])
    await assert.rejects(generateShapedVrm(request,new AbortController().signal,response({...payload,report:changed})));
});
