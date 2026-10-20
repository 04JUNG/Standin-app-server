import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { bodyShape } from '../dist/body-selection/shape.js';
import { cameraArtifact } from '../dist/candidate-camera/artifacts.js';
import { convertFramed } from '../dist/converter/framing.js';
const root=process.env.SHAPE_QA_ROOT;
assert.ok(root,'set SHAPE_QA_ROOT to the staged artifact directory');
const catalog=JSON.parse(await readFile(root+'/release/body-models.local.json','utf8'));
const bvhBytes=await readFile(process.env.SHAPE_QA_BVH);
const url=process.env.CONVERTER_BASE_URL;
const runtime=await (await fetch(url+'/preview-contract')).json();
const health=await (await fetch(url+'/healthz')).json();
const results=[];
for(const cid of ['male-base-v0-6-7','female-base-v0-2-2']) {
 const asset=catalog.assets.find(a=>a.characterId===cid);let calls=0;
 const convert=async input=>{calls++;return convertFramed(input)};
 for(const muscle of [1,2]) {
  const controls=Object.fromEntries(asset.shape.controls.map(c=>[c.key,c.default]));controls.muscle=muscle;
  if(cid.startsWith('female')) {controls.fat_gain=1;controls.breast_size=.3;}
  const shape=bodyShape(asset,controls);assert.ok(shape);
  const input={bvhBytes,characterId:cid,scope:'full',cameraRotation:[[1,0,0],[0,1,0],[0,0,1]],expectedCharacterSha256:asset.assetSha256,expectedPreviewRevision:runtime.preview_revision,shape};
  const [a,b]=await Promise.all([cameraArtifact(['shape-pair-real',cid],input,convert),cameraArtifact(['shape-pair-real',cid],input,convert)]);
  assert.equal(a.artifactSha256,b.artifactSha256);assert.equal(a,b);
  results.push({characterId:cid,muscle,shapeSha256:shape.shapeSha256,fbxSha256:a.artifactSha256,pngBytes:a.preview.length});
 }
 assert.equal(calls,2,'distinct shapes must not share a bake; repeat requests reuse the exact pair');
 const controls=Object.fromEntries(asset.shape.controls.map(c=>[c.key,c.default]));controls.muscle=1;const shape=bodyShape(asset,controls);
 const model=await convertFramed({bvhBytes,characterId:cid,scope:'full',expectedCharacterSha256:asset.assetSha256,expectedPreviewRevision:runtime.preview_revision,previewFormat:'model',modelRevision:health.preview_model_revision,characterSha256:asset.assetSha256,shape});
 assert.equal(Buffer.from(model.preview).subarray(0,4).toString(),'glTF');
 results.push({characterId:cid,modelSha256:model.artifactSha256,glbBytes:model.preview.length});
}
await writeFile(root+'/bff-real-pair.json',JSON.stringify({passed:true,results},null,2));
console.log('real BFF -> converter: 4 shaped PNG/FBX pairs, 2 shaped GLB/FBX pairs, request coalescing passed');
