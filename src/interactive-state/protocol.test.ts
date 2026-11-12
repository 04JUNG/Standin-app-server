import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createInteractiveRoutes } from "./routes.js";
import type { InteractiveService } from "./service.js";
import { INTERACTIVE_PROTOCOL_HEADER, INTERACTIVE_PROTOCOL, supportsPoseBodyProtocol } from "./protocol.js";
test("legacy clients cannot receive unchecked-hand packets from cached interactive URLs", async () => {
 let reads=0;
 const service={head:async()=>{reads++;return {operation:null};}} as unknown as InteractiveService;
 const app=new Hono<AppEnv>();
 app.use("*",async(c,next)=>{c.set("installationId","owner");await next();});
 app.route("/v1/analysis/jobs",createInteractiveRoutes(service,()=>true));
 const path="/v1/analysis/jobs/job_test/people/0/interactive-state?candidateId=candidate";
 for(const protocol of [undefined,"legacy","pose-body-only-v2"]){
  const response=await app.request(path,{headers:protocol?{[INTERACTIVE_PROTOCOL_HEADER]:protocol}:{}});
  assert.equal(response.status,426);assert.equal(reads,0);
 }
 assert.equal((await app.request(path,{headers:{[INTERACTIVE_PROTOCOL_HEADER]:INTERACTIVE_PROTOCOL}})).status,200);
 assert.equal(reads,1);
 assert.equal(supportsPoseBodyProtocol(undefined),false);assert.equal(supportsPoseBodyProtocol(INTERACTIVE_PROTOCOL),true);
});
