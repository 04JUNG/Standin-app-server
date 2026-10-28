import test from "node:test";
import assert from "node:assert/strict";
import { parseAcquisition, createAcquisitionRoutes, type AcquisitionStore } from "./acquisition.js";
test('only explicit current consent and known creative labels are accepted', () => {
  assert.equal(parseAcquisition({consent:true,version:'2026-10-29',creative:'meta-poster-a'}),'meta-poster-a');
  assert.equal(parseAcquisition({consent:true,version:'2026-10-29',creative:'meta-hook-a'}),'meta-hook-a');
  for (const body of [null, {}, {consent:false,version:'2026-10-29',creative:'meta-poster-a'}, {consent:true,version:'old',creative:'meta-poster-a'}, {consent:true,version:'2026-10-29',creative:'email@example.com'}]) assert.equal(parseAcquisition(body),null);
});
test('HTTP consent, immutable first touch, retries and withdrawal', async () => {
  let current: string|null=null, claimed=false, writes=0;
  const repository: AcquisitionStore = {
    async read(id) { assert.equal(id,'test-install'); return current; },
    async claim(id,creative) { assert.equal(id,'test-install'); writes++; if(claimed) return false; claimed=true;current=creative;return true; },
    async revoke(id) { assert.equal(id,'test-install');current=null; },
  };
  const app=createAcquisitionRoutes(repository,async(c,next)=>{c.set('installationId','test-install');await next();});
  const send=(body:unknown)=>app.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send({creative:'meta-poster-a',version:'2026-10-29',consent:false})).status,400);
  assert.equal(writes,0);
  const poster={creative:'meta-poster-a',version:'2026-10-29',consent:true};
  assert.equal((await send(poster)).status,200);
  assert.equal((await send(poster)).status,200);
  assert.equal((await send({...poster,creative:'meta-hook-a'})).status,409);
  assert.equal(current,'meta-poster-a');
  assert.equal((await app.request('/',{method:'DELETE'})).status,200);
  assert.deepEqual(await (await app.request('/')).json(),{creative:null});
  assert.equal((await send(poster)).status,409);
});
test('unauthenticated requests cannot claim or read an installation',async()=>{
  let called=false;
  const app=createAcquisitionRoutes({async read(){called=true;return null;},async claim(){called=true;return true;},async revoke(){called=true;}});
  for(const method of ['GET','POST','DELETE']) assert.equal((await app.request('/',{method})).status,401);
  assert.equal(called,false);
});
