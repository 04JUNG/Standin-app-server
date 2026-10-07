import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";
import { createAlignedRoutes } from "./routes.js";

function setup() {
  const bvh = Buffer.from("source bvh");
  const rotation = [[0,0,-1],[0,1,0],[1,0,0]];
  const state = {owner:true, stale:false, quarantined:false, calls:0};
  const app = new Hono<AppEnv>();
  app.use("*",async(c,next)=>{c.set("installationId","owner");c.set("requestId","request");await next();});
  app.route("/",createAlignedRoutes({
    getOwnedJob: async(_id,owner)=>{
      assert.equal(owner,"owner");
      return state.owner ? {status:"completed",result:{candidatesByPerson:[{personIndex:0,candidates:[{
        id:"pose::back",poseId:"pose",camera:{rotation,source_bvh_sha256: state.stale ? "a".repeat(64) : sha256Hex(bvh)}
      }]}]}} as Job : undefined;
    },
    getPoseBvh:async()=>new Response(bvh,{status:state.quarantined?409:200}),
    checkCharacter:async()=>"ok" as const,
    converterEnabled:()=>true,
    convertFramed:async input=>{
      state.calls++;
      assert.deepEqual(input.cameraRotation,rotation);
      assert.deepEqual(input.bvhBytes,new Uint8Array(bvh));
      return {fbx:Buffer.from("fbx"),preview:Buffer.from("png"),conversionId:"id",artifactSha256:"sha",sourceBvhSha256:"sha"};
    },
  }));
  const jobId=String(Math.random());
  const request=(extra="")=>app.request(`/pose/aligned?jobId=${jobId}&personIndex=0&candidateId=pose%3A%3Aback${extra}`);
  return {state,request};
}
test("preview works before selection and checks ownership even on cache hits",async()=>{
  const {state,request}=setup();
  let response=await request();
  assert.equal(response.status,200);assert.equal(await response.text(),"png");
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
  assert.equal((await request()).status,200);assert.equal(state.calls,1);
  state.owner=false;assert.equal((await request()).status,409);assert.equal(state.calls,1);
});
for(const key of ["stale","quarantined"] as const) test(`reject ${key} source before render`,async()=>{
  const {state,request}=setup();state[key]=true;
  assert.equal((await request()).status,409);assert.equal(state.calls,0);
});
test("client rotation query is ignored; only stored camera reaches converter",async()=>{
  const {request}=setup();assert.equal((await request("&camera_rotation=arbitrary")).status,200);
});
