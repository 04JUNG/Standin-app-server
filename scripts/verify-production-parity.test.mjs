import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verify} from './verify-production-parity.mjs';
const p=JSON.parse(readFileSync(new URL('../config/production-runtime-parity.json',import.meta.url)));
function task(name='bff') {
 const values={CONVERTER_CHARACTER_ID:'male-base-v0-8-0',INTERACTIVE_STATE_ENABLED:'true',REPLAY_ENVIRONMENT:'production',REPLAY_CONSENT_MODE:'explicit',REPLAY_BUCKET:'production-private'};
 return {family:'StandinAppTask',containerDefinitions:[{name,environment:Object.entries(values).map(([name,value])=>({name,value})),secrets:[{name:'CONVERTER_INTERACTIVE_TOKEN',valueFrom:'arn:aws:secretsmanager:region:123:secret:standin/production/converter-interactive-token-example'}]},
 {name:'body-assets-init',environment:[{name:'BODY_ASSETS_MANIFEST_KEY',value:p.bodyManifests.bff.manifestKey},{name:'BODY_ASSETS_MANIFEST_SHA256',value:p.bodyManifests.bff.manifestSha256}]}]};
}
for(const name of ['bff','analysis-worker'])test(`${name} accepts production-owned complete feature assets`,()=>assert.equal(verify(task(name),name),true));
test('old body and staging private credentials cannot silently enable a partial promotion',()=>{
 let t=task();t.containerDefinitions[1].environment[1].value='a'.repeat(64);assert.throws(()=>verify(t,'bff'),/preset pin/);
 t=task();t.containerDefinitions[0].secrets[0].valueFrom='arn:aws:secret:standin/staging/token';assert.throws(()=>verify(t,'bff'),/transport/);
});
test('production retains explicit replay authorization and private durable storage',()=>{
 const t=task();t.containerDefinitions[0].environment.find(e=>e.name==='REPLAY_CONSENT_MODE').value='assumed';
 assert.throws(()=>verify(t,'bff'),/consent/);
});
