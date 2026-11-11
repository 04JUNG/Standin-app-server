/** Local semantic ready/preview/download probe; ownership/job stores are fixtures.
 * Start the server probe with --forbid-conversion and the populated cache first. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createFramingRoutes } from '../dist/output-scope/framingRoutes.js';
import { convertFramed } from '../dist/converter/framing.js';
import { renderFinalPreview } from '../dist/converter/finalPreview.js';
import { sha256Hex } from '../dist/converter/client.js';
import { attachSemanticPresentation } from '../dist/semantic/presentation.js';
const root=process.argv[2];
if(!root) throw new Error('Usage: node scripts/verify-final-fbx-reuse.mjs <server-pilot-directory> [converter-url]');
const baseUrl=process.argv[3]??'http://127.0.0.1:18971';
const health=await (await fetch(baseUrl+'/healthz')).json();
assert.equal(health.ok,true);
const runtime=await(await fetch(baseUrl+'/preview-contract')).json();
// This counter is written by serve_final_fbx_reuse_probe.py; with its
// --forbid-conversion flag an absent file means no conversion was attempted.
const converterRuns=()=>fs.existsSync(root+'/http-converter-runs.jsonl')?fs.readFileSync(root+'/http-converter-runs.jsonl','utf8').trim().split('\n').length:0;
const rows=[];
let httpConversions=0;
const converterFetch=async (...args)=>{httpConversions++;return fetch(...args);};
async function exercise(pose,cid,index,preview=false){
 const bytes=fs.readFileSync(root+'/inputs/library/bvh/'+pose+'.bvh');
 const candidate={id:'pick',poseId:pose,rank:1,source:'semantic',lookupAllowed:true,bvhAvailable:true,manualExportAllowed:true,reviewRequired:true,refineAllowed:false,releaseAllowed:false,sourceBvhSha256:sha256Hex(bytes)};
 const person={personIndex:0,outputScope:{selection:'full'},candidates:[candidate]};
 attachSemanticPresentation({jobId:'semantic-local-'+index,candidatesByPerson:[person]});
 const asset=JSON.parse(fs.readFileSync(root+'/inputs/body-models.json')).assets.find(a=>a.characterId===cid);
 const selection={schemaVersion:'body-selection.v1',shape:null,shapeSource:null,personIndex:0,intent:'manual',manualCharacterId:cid,recommendation:{status:'unavailable',body:null,reasonCodes:[]},resolvedBody:{bodyId:asset.bodyId,bodyVersion:asset.bodyVersion,assetSha256:asset.assetSha256,characterId:cid,measurementVersion:asset.measurementVersion,rigVersion:asset.rigVersion},resolvedSource:'manual',resolutionStatus:'ready',selectionRevision:1,renderingExecuted:false};
 const jobs=new Map();const owner='installation1';let quarantine=false;
 const makeApp=()=>{
  const app=new Hono();app.use('*',async(c,next)=>{c.set('installationId',c.req.header('x-test-owner')??owner);c.set('requestId','req-local');await next();});
  app.route('/',createFramingRoutes({
   getOwnedJob:async(job,id)=>id===owner?jobs.get(job):undefined,
   validateConfirmedSelection:async()=>true,validateExportCandidate:async()=>true,resolveExportArtifact:async()=>({variant:'base',fallbackReason:null}),
   getPoseBvh:async()=>new Response(bytes,{status:quarantine?409:200}),
   checkCharacter:async()=> 'ok',converterEnabled:()=>true,recordExport:async()=>{},handBakeFor:async()=>null,
   modelPreviewIdentity:async()=>({characterSha256:health.character_hashes[cid],modelRevision:health.preview_model_revision}),
   convertFramed:(input)=>convertFramed(input,{baseUrl,timeoutMs:300000,fetch:converterFetch}),
   renderFinalPreview:(artifact,aligned,_deps,sceneCamera,signal)=>renderFinalPreview(artifact,aligned,{baseUrl,timeoutMs:300000},sceneCamera,signal),
  },{enabled:()=>true,selection:async()=>selection,runtime:async()=>({previewRevision:runtime.preview_revision})}));
  return app;
 };
 const request=(app,job,extra={},headers={})=>app.request('/'+encodeURIComponent(pose)+'/framed?'+new URLSearchParams({jobId:job,personIndex:'0',candidateId:candidate.id,bodySelectionRevision:'1',outputScope:'full',format:'ready',characterId:cid,...extra}),{headers});
 let prior;
 for(let j=0;j<2;j++){
  const job='job-'+index+'-'+j;jobs.set(job,{status:'completed',result:{source:'semantic',candidatesByPerson:[person]}});
  const app=makeApp();const before=converterRuns();const calls=httpConversions;const start=performance.now();
  const ready=await request(app,job);assert.equal(ready.status,200,await ready.text());
  const prepareMs=performance.now()-start;
  const key=ready.headers.get('X-Standin-Review-Key');
  assert.equal(ready.headers.get('X-Standin-Final-Artifact-Origin'),'hit');
  assert.equal(converterRuns(),before);
  assert.equal(httpConversions,calls+1);
  const repeatStart=performance.now();const repeated=await request(app,job);assert.equal(repeated.status,200);assert.equal(repeated.headers.get('X-Standin-Review-Key'),key);
  assert.equal(httpConversions,calls+1);
  const repeatedMs=performance.now()-repeatStart;
  const saveStart=performance.now();const download=await request(app,job,{format:'fbx',artifactReceipt:key,reviewKey:key});assert.equal(download.status,200,await download.clone().text());
  const fbx=new Uint8Array(await download.arrayBuffer());assert.equal(sha256Hex(fbx),ready.headers.get('X-Standin-Artifact-SHA256'));
  const downloadMs=performance.now()-saveStart;
  assert.equal(converterRuns(),before);assert.equal(httpConversions,calls+1);
  if(prior){assert.notEqual(prior.key,key);assert.equal(prior.sha,sha256Hex(fbx));assert.equal((await request(app,job,{format:'fbx',artifactReceipt:prior.key,reviewKey:prior.key})).status,409);}
  assert.notEqual((await request(app,job,{}, {'x-test-owner':'other-installation'})).status,200);
  let previewMs=null;
  if(preview&&j===0){const t=performance.now();const image=await request(app,job,{format:'preview',artifactReceipt:key});assert.equal(image.status,200,await image.clone().text());const png=new Uint8Array(await image.arrayBuffer());assert.equal(png[0],137);fs.writeFileSync(root+'/actual-semantic-preview.png',png);previewMs=performance.now()-t;assert.equal(converterRuns(),before);}
  quarantine=true;assert.notEqual((await request(app,job,{format:'fbx',artifactReceipt:key,reviewKey:key})).status,200);quarantine=false;
  rows.push({pose,characterId:cid,job,prepareMs,repeatedMs,downloadMs,previewMs,origin:'hit',converterBlenderRuns:converterRuns()-before,artifactSha256:sha256Hex(fbx),bytes:fbx.length});
  prior={key,sha:sha256Hex(fbx)};
 }
}
for(const [i,pose] of ['2hand Idle_01','Asking Question_01','MH__anrico_sitting02'].entries()){
 for(const [g,cid] of ['male-base-v0-8-0','female-base-v0-4-0'].entries())await exercise(pose,cid,i+'-'+g,i===0&&g===0);
}
fs.writeFileSync(root+'/bff-semantic-e2e-results.json',JSON.stringify({description:'Actual semantic front-reference camera, manual confirmation and default body-selection contract. Real BFF routes and contract client -> localhost Converter. Job/ownership source adapters are test fixtures; FBX, hashes, registry, shape solver and PNG are real.',httpConversions,converterRuns:converterRuns(),rows},null,2));
console.log(JSON.stringify({httpConversions,converterRuns:converterRuns(),rows:rows.length,minPrepareMs:Math.min(...rows.map(r=>r.prepareMs)),maxPrepareMs:Math.max(...rows.map(r=>r.prepareMs))}));
