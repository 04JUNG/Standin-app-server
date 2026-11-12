import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createInteractiveRoutes } from "./routes.js";
import type { InteractiveService } from "./service.js";
import { BINARY_STATE_PROTOCOL, INTERACTIVE_PROTOCOL_HEADER, INTERACTIVE_PROTOCOL, protocolTokens, supportsBinaryState, supportsPoseBodyProtocol } from "./protocol.js";
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
test("protocol header is a token list: body protocol still required, binary state is an optional extra token", async () => {
 const prepared: Array<boolean | undefined> = [];
 const service={head:async()=>({operation:null}),prepare:async(_l:unknown,_input:unknown,client:{binaryState?:boolean})=>{prepared.push(client.binaryState);throw new Error("stop");}} as unknown as InteractiveService;
 const app=new Hono<AppEnv>();
 app.use("*",async(c,next)=>{c.set("installationId","owner");await next();});
 app.route("/v1/analysis/jobs",createInteractiveRoutes(service,()=>true));
 const path="/v1/analysis/jobs/job_test/people/0/interactive-state";
 const cases: Array<[string, boolean, boolean]> = [
  // [header, accepted, binary state]
  [INTERACTIVE_PROTOCOL,true,false],
  [`${INTERACTIVE_PROTOCOL}, ${BINARY_STATE_PROTOCOL}`,true,true],
  [`${BINARY_STATE_PROTOCOL},${INTERACTIVE_PROTOCOL}`,true,true],
  [`${INTERACTIVE_PROTOCOL}, future-capability-v9`,true,false],
  [`${INTERACTIVE_PROTOCOL},,${BINARY_STATE_PROTOCOL} ,`,true,true],
  [BINARY_STATE_PROTOCOL,false,false],
  [`pose-body-only-v2, ${BINARY_STATE_PROTOCOL}`,false,false],
  [`${INTERACTIVE_PROTOCOL.toUpperCase()}, ${BINARY_STATE_PROTOCOL}`,false,false],
  [`${INTERACTIVE_PROTOCOL}; ${BINARY_STATE_PROTOCOL}`,false,false],
  [`${INTERACTIVE_PROTOCOL}, ${BINARY_STATE_PROTOCOL.toUpperCase()}`,true,false],
 ];
 for(const [header,accepted,binary] of cases){
  assert.equal(supportsPoseBodyProtocol(header),accepted,header);
  assert.equal(supportsBinaryState(header),binary,header);
  assert.equal((await app.request(`${path}?candidateId=candidate`,{headers:{[INTERACTIVE_PROTOCOL_HEADER]:header}})).status,accepted?200:426,header);
  const before=prepared.length;
  const response=await app.request(path,{method:"POST",headers:{[INTERACTIVE_PROTOCOL_HEADER]:header,"Content-Type":"application/json"},
   body:JSON.stringify({schemaVersion:"standin.interactive-http.v1",candidateId:"candidate",revision:1,expectedRevision:0,expectedStateHash:null,mutationId:"mutation-1"})});
  if(accepted){assert.equal(prepared.length,before+1);assert.equal(prepared.at(-1),binary,header);}
  else{assert.equal(response.status,426);assert.equal(prepared.length,before);}
 }
 assert.equal(supportsBinaryState(undefined),false);
 assert.deepEqual([...protocolTokens(` ${INTERACTIVE_PROTOCOL} ,x, `)],[INTERACTIVE_PROTOCOL,"x"]);
});
