import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pool, SCHEMA } from '../db.js';
import { createVisitor, ingestWeb, revokeVisitor } from '../journey/store.js';
import { parseWebEvent, type WebEvent } from '../journey/contract.js';
import { blogAnalytics } from './blogAnalytics.js';
import { BLOG_DASHBOARD_SCRIPT } from '../ops/blogDashboard.js';
const path='/blog/bvh-vs-fbx/';
function event(page:string,sequence:number,overrides:Partial<WebEvent>={}):WebEvent {
  return {id:randomUUID(),page,sequence,name:'page_view',at:new Date().toISOString(),path,section:'article-intro',target:'none',creative:'other',source:'naver',device:'mobile',elapsedMs:0,depth:0,...overrides};
}
test('blog allowlists reject unknown articles and cross-article section names',()=>{
  const e=event(randomUUID(),1);assert.ok(parseWebEvent(e));
  assert.equal(parseWebEvent({...e,section:'import-bvh'}),null);
  assert.equal(parseWebEvent({...e,path:'/blog/private-name/'}),null);
  assert.equal(parseWebEvent({...e,source:'https://search.naver.com/?query=private'}),null);
});
test('blog cohort deduplicates retries, separates views from readers, and excludes missing views, expired and withdrawn records',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec(SCHEMA);
  const sql=async(text:string,values?:unknown[])=>{const r=await db.query(text,values);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length,fields:[],command:'',oid:0};};
  t.mock.method(pool,'query',sql as typeof pool.query);
  t.mock.method(pool,'connect',(async()=>({query:sql,release(){}})) as unknown as typeof pool.connect);
  const visitor=await createVisitor(), p=randomUUID();
  const batch=[event(p,1),event(p,2,{name:'section_view',section:'comparison'}),event(p,3,{name:'section_engagement',section:'comparison',elapsedMs:3000}),event(p,4,{name:'section_engagement',section:'comparison',elapsedMs:4000,depth:80}),event(p,5,{name:'section_view',section:'article-related',depth:100}),event(p,6,{name:'cta_click',section:'article-related',target:'beta',depth:100})];
  await ingestWeb(visitor.token,batch);await ingestWeb(visitor.token,batch);
  await ingestWeb(visitor.token,[event(randomUUID(),1,{source:'internal'})]);
  await ingestWeb(visitor.token,[event(randomUUID(),1,{name:'section_engagement',section:'comparison',elapsedMs:99000})]);
  const expired=await createVisitor();await ingestWeb(expired.token,[event(randomUUID(),1)]);
  await db.query("UPDATE journey_visitors SET expires_at=now()-interval '1 second' WHERE id<>(SELECT visitor_id FROM journey_web_events WHERE event_id=$1)",[batch[0].id]);
  const r=await blogAnalytics(7);
  assert.equal(r.totals.views,2);assert.equal(r.totals.visitors,1);assert.equal(Number(r.totals.engagedMs),7000);
  assert.equal(r.totals.endViews,1);assert.equal(r.totals.downloadCtaViews,1);
  assert.equal(r.posts[0].depth75Views,1);assert.equal(r.posts[0].mobileViews,2);
  assert.equal(r.sources.length,2);assert.equal(r.daily[0].views,2);
  const section=r.sections.find(s=>s.section==='comparison')!;
  assert.equal(section.exposedViews,1);assert.equal(section.engagedViews,1);assert.equal(Number(section.engagedMs),7000);
  assert.ok(!JSON.stringify(r).includes(visitor.token));assert.ok(!JSON.stringify(r).includes(p));
  await revokeVisitor(visitor.token);assert.equal((await blogAnalytics(7)).totals.views,0);
  await assert.rejects(blogAnalytics(0));await assert.rejects(blogAnalytics(91));
});
test('blog dashboard exposes definitions, empty and failed states and escapes data',()=>{
  const context=vm.createContext({esc:(s:unknown)=>String(s).replaceAll('<','&lt;')});vm.runInContext(BLOG_DASHBOARD_SCRIPT,context);
  const render=vm.runInContext('blogBlock',context) as (v:unknown)=>string;
  assert.match(render(null),/0건이 아닙니다/);
  const html=render({status:'ready',totals:{views:0},posts:[],catalog:[{path,title:'<script>',sections:{comparison:'비교표'}}],sources:[],sections:[],daily:[]});
  assert.match(html,/수집된 블로그 조회가 없습니다/);assert.match(html,/활성 5초 이상/);assert.match(html,/목차로 건너뛴/);assert.ok(!html.includes('<script>'));
});
