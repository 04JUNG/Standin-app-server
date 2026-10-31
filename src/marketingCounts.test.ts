import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';
import { pool, SCHEMA } from './db.js';
import { CAMPAIGN_COUNT_PATH as path, createCampaignCountRoutes, incrementCampaignCount, parseCampaignCount, campaignCountSummary, seoulDay } from './marketingCounts.js';

const value = {v:1 as const,creative:'meta-poster-a' as const,event:'first_run' as const};
const headers = {'Content-Type':'application/json',Origin:'tauri://localhost'};
test('accepts only shared labels, never arbitrary dimensions or identifiers', () => {
  assert.deepEqual(parseCampaignCount(value),value);
  for (const v of [null,[],{}, {...value,installationId:'private'}, {...value,event:'save'}, {...value,creative:'private'}, {...value,v:'1'}])
    assert.equal(parseCampaignCount(v),null);
  assert.equal(seoulDay(Date.parse('2026-10-31T15:00:00Z')),'2026-11-01');
});

test('all count requests terminate before identity/request logging including errors and unknown child paths', async () => {
  let logged=0,writes=0,fail=false;
  const app=new Hono();
  app.route(path,createCampaignCountRoutes({enabled:true,origins:['tauri://localhost'],increment:async v=>{
    assert.deepEqual(v,value); writes++; if(fail) throw Error('must not reach the parent logger');
  }}));
  app.use('*',async(_c,next)=>{logged++;await next();});
  app.onError((_e,c)=>{logged++;return c.body(null,500);});
  const post=(body:unknown=value,extra:Record<string,string>={},suffix='')=>app.request(path+suffix,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await post()).status,204);
  assert.equal((await post({...value,jobId:'private'})).status,400);
  for(const name of ['Authorization','Cookie','X-Installation-Id','X-Device-Token','X-Beta-Admin-Token'])
    assert.equal((await post(value,{[name]:'private'})).status,400);
  assert.equal((await post(value,{},'?id=private')).status,400);
  assert.equal((await post(value,{Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await post(value,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post({extra:'x'.repeat(200)})).status,413);
  assert.equal((await post(value,{},'/unexpected')).status,404);
  assert.equal((await app.request(path,{method:'OPTIONS',headers})).status,204);
  assert.equal((await app.request(path)).status,405);
  fail=true;
  const error=await post();assert.equal(error.status,503);assert.equal(await error.text(),'');
  assert.equal(logged,0);assert.equal(writes,2);
  await app.request('/other');assert.equal(logged,1,'normal requests keep existing logging');
});

test('disabled collection and process-wide rate limit do not write events',async()=>{
  let writes=0,now=100000;
  const disabled=createCampaignCountRoutes({enabled:false,increment:async()=>{writes++;}});
  assert.equal((await disabled.request('/',{method:'POST',headers,body:JSON.stringify(value)})).status,503);
  const routes=createCampaignCountRoutes({enabled:true,clock:()=>now,increment:async()=>{writes++;}});
  const post=()=>routes.request('/',{method:'POST',headers,body:JSON.stringify(value)});
  for(let i=0;i<60;i++)assert.equal((await post()).status,204);
  assert.equal((await post()).status,429);assert.equal(writes,60);
  now+=60000;assert.equal((await post()).status,204);
});

test('database stores only bounded daily cells and API excludes today/suppresses small counts',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec(SCHEMA);
  t.mock.method(pool,'query',(async(sql:string,values?:unknown[])=>{
    const r=await db.query(sql,values);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows||0,fields:[],command:'',oid:0};
  }) as typeof pool.query);
  const now=Date.parse('2026-11-01T01:00:00Z');
  for(let i=0;i<6;i++) await incrementCampaignCount(value,now-86400000);
  for(let i=0;i<4;i++) await incrementCampaignCount({...value,event:'first_analysis_success'},now-86400000);
  await incrementCampaignCount({...value,creative:'meta-hook-a'},now);
  const result=await campaignCountSummary(7,now,true);
  assert.equal(result.since,'2026-10-25');assert.equal(result.until,'2026-10-31');
  assert.deepEqual(result.rows,[{creative:'meta-poster-a',first_run:6,first_analysis_success:null},{creative:'meta-hook-a',first_run:null,first_analysis_success:null}]);
  const columns=await db.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='campaign_daily_counts' ORDER BY ordinal_position");
  assert.deepEqual(columns.rows.map(r=>r.column_name),['day','creative','event','count']);
  await db.query('UPDATE campaign_daily_counts SET count=10000');await incrementCampaignCount(value,now-86400000);
  assert.equal((await campaignCountSummary(7,now,true)).rows[0].first_run,10000);
  await assert.rejects(campaignCountSummary(0,now));
  assert.equal((await campaignCountSummary(7,now,false)).enabled,false);
});
