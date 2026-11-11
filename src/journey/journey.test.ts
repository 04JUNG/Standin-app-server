import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { pool, SCHEMA } from '../db.js';
import * as store from './store.js';
import { JOURNEY_VERSION, parseWebEvent, type WebEvent } from './contract.js';
import { createWebJourneyRoutes, createAppJourneyRoutes } from './routes.js';
import { journeySummary } from '../admin/journeys.js';
import { JOURNEY_DASHBOARD_SCRIPT } from '../ops/marketingJourneyDashboard.js';
import vm from 'node:vm';
import type { AppEnv } from '../env.js';

function event(overrides: Partial<WebEvent> = {}): WebEvent {
  return {id:randomUUID(),page:randomUUID(),sequence:1,name:'page_view',at:new Date().toISOString(),path:'/',section:'hero',target:'none',creative:'meta-poster-a',source:'instagram',device:'desktop',elapsedMs:0,depth:0,...overrides};
}
test('web contract excludes arbitrary URLs, contents, unsupported events, stale time and oversized durations',()=>{
  const e=event();assert.ok(parseWebEvent(e));
  for(const override of [{url:'https://secret.test/'},{path:'/signup/'},{name:'keystroke'},{target:'email@example.com'},{elapsedMs:-1},{elapsedMs:3600001},{depth:101},{at:'2020-01-01'},{creative:'someone@example.com'}])assert.equal(parseWebEvent({...e,...override}),null);
});

test('deduplication, bounded handoff, after-consent app stages, admin join and withdrawal use real PostgreSQL semantics',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec(SCHEMA);
  const sql=async(text:string,values?:unknown[])=>{const r=await db.query(text,values);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length,fields:[],command:'',oid:0};};
  t.mock.method(pool,'query',sql as typeof pool.query);
  t.mock.method(pool,'connect',(async()=>({query:sql,release(){}})) as unknown as typeof pool.connect);
  const before=new Date(Date.now()-3600000).toISOString();
  for(const id of ['install','other','hidden','revoked'])await db.query(`INSERT INTO installations(id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
    VALUES($1,'hash','v',$2,$2,$2,'0.2.9','windows','test','x64','ko')`,[id,before]);
  await db.query('INSERT INTO internal_installations(id,added_at) VALUES($1,$2)',['hidden',before]);
  await db.query("UPDATE installations SET revoked_at=$1 WHERE id='revoked'",[before]);
  const visitor=await store.createVisitor(), page=randomUUID();
  const view=event({page,sequence:1});
  const dwell=event({page,sequence:2,name:'section_engagement',elapsedMs:10500});
  const download=event({page,sequence:3,name:'download_click',section:'beta',target:'download_windows'});
  assert.equal(await store.ingestWeb(visitor.token,[view,dwell,download]),3);
  assert.equal(await store.ingestWeb(visitor.token,[view,dwell,download]),0);
  assert.equal(await store.ingestWeb('x'.repeat(43),[view]),null);
  const handoff=(await store.issueHandoff(visitor.token))!;
  const receipt=await store.claimHandoff('install',handoff.token);assert.ok(receipt);
  assert.equal(await store.claimHandoff('install',handoff.token),receipt,'retry is idempotent');
  assert.equal(await store.claimHandoff('other',handoff.token),null,'one-time handoff cannot identify another installation');
  assert.equal(await store.ingestApp('other',receipt,[{id:randomUUID(),name:'export_completed',at:new Date().toISOString()}]),null);
  assert.equal(await store.ingestApp('install',receipt,[{id:randomUUID(),name:'export_completed',at:before}]),null,'no retrospective collection');
  const exported={id:randomUUID(),name:'export_completed',at:new Date().toISOString()};
  assert.equal(await store.ingestApp('install',receipt,[exported]),1);assert.equal(await store.ingestApp('install',receipt,[exported]),0);
  await db.query(`INSERT INTO jobs(id,installation_id,status,created_at,updated_at) VALUES('before-link','install','completed',$1,$1)`,[before]);
  let report=await journeySummary(7);
  assert.equal(report.totals.visitors,1);assert.equal(report.totals.downloadVisitors,1);assert.equal(report.totals.linkedVisitors,1);
  assert.equal(report.totals.analyzedVisitors,0,'old successful jobs are not attributed');assert.equal(report.totals.exportedVisitors,1);
  assert.equal(Number(report.totals.engagedMs),10500,'retry does not double dwell');
  assert.equal(report.installations.length,1,'unlinked/internal/revoked installs are not individual marketing rows');
  assert.equal(report.visitors[0].id,report.installations.find(i=>i.visitorId)?.visitorId);
  assert.ok(!JSON.stringify(report).includes(visitor.token));assert.ok(!JSON.stringify(report).includes(receipt));
  const after=new Date().toISOString();
  await db.query(`INSERT INTO jobs(id,installation_id,status,created_at,updated_at) VALUES('after-link','install','completed',$1,$1)`,[after]);
  report=await journeySummary(7);assert.equal(report.totals.analyzedVisitors,1);
  await store.revokeLink('install');
  assert.equal(await store.ingestApp('install',receipt,[exported]),null);assert.equal(await store.readLink('install'),null);
  report=await journeySummary(7);assert.equal(report.totals.linkedVisitors,0);assert.equal(report.visitors[0].linkedApps,0);
  const fresh=(await store.issueHandoff(visitor.token))!;
  const newReceipt=await store.claimHandoff('install',fresh.token);assert.ok(newReceipt);assert.notEqual(newReceipt,receipt);
  await store.revokeVisitor(visitor.token);
  assert.equal(await store.ingestWeb(visitor.token,[event()]),null);assert.equal(await store.issueHandoff(visitor.token),null);
  assert.equal(await store.readLink('install'),null);report=await journeySummary(7);assert.equal(report.totals.visitors,0);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM journey_app_events')).rows[0].n,0);
  await assert.rejects(journeySummary(91));
});

test('CORS, body allowlists, explicit consent and installation authentication protect routes',async()=>{
  let created=0;
  const repository={...store,createVisitor:async()=>{created++;return {token:'x'.repeat(43),expiresAt:new Date().toISOString()};},ingestWeb:async()=>1};
  const app=new Hono().route('/v1/web-analytics',createWebJourneyRoutes(repository));
  const req=(path:string,body:unknown,origin='https://www.standinpose.com')=>app.request('/v1/web-analytics'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await req('/visitors',{consent:true,version:JOURNEY_VERSION})).status,201);
  assert.equal((await req('/visitors',{consent:false,version:JOURNEY_VERSION})).status,400);
  assert.equal((await req('/visitors',{consent:true,version:JOURNEY_VERSION},'https://evil.test')).status,403);
  assert.equal((await req('/visitors?token=bad',{consent:true,version:JOURNEY_VERSION})).status,400);assert.equal(created,1);
  assert.equal((await req('/events',{token:'x'.repeat(43),events:[event({path:'/ja/'})]})).status,200);
  assert.equal((await req('/events',{token:'x'.repeat(43),events:[{...event(),email:'secret'}]})).status,400);
  assert.equal((await req('/events',{token:'x'.repeat(43),events:Array.from({length:31},()=>event())})).status,400);
  const appRoutes=new Hono<AppEnv>().route('/journey',createAppJourneyRoutes(repository,async c=>c.body(null,401)));
  assert.equal((await appRoutes.request('/journey')).status,401);
});

test('dashboard distinguishes missing data, unlinked visits and escaped timeline values',()=>{
  const context=vm.createContext({esc:(s:unknown)=>String(s).replaceAll('<','&lt;'),when:(s:unknown)=>String(s)});
  vm.runInContext(JOURNEY_DASHBOARD_SCRIPT,context);
  const render=vm.runInContext('journeyBlock',context) as (v:unknown)=>string;
  assert.match(render(null),/0건이 아닙니다/);
  const output=render({status:'ready',rowLimit:100,totals:{},sections:[],installations:[],visitors:[{id:'<script>',source:'instagram',creative:'meta-poster-a',device:'desktop',timeline:[{name:'<img>',at:'now'}]}]});
  assert.match(output,/사용 여부 확인 불가/);assert.ok(!output.includes('<script>'));assert.ok(!output.includes('<img>'));assert.match(output,/30분/);
});
