import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../env.js';
import { requireInstallation } from '../installations/middleware.js';
import { APP_EVENTS,JOURNEY_VERSION,TOKEN,UUID,parseWebEvent,record,validTime } from './contract.js';
import * as store from './store.js';

// No request/visitor token in URLs or shared request logs. Mount this before the global logger.
export function createWebJourneyRoutes(repository=store,origins=['https://www.standinpose.com','https://standinpose.com']) {
  const routes=new Hono();
  let remaining=1000,windowEnd=0;
  routes.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    const origin=c.req.header('Origin');
    if(!origin||!origins.includes(origin))return c.body(null,403);
    c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');
    c.header('Access-Control-Allow-Headers','Content-Type');c.header('Access-Control-Allow-Methods','POST, OPTIONS');
    if(c.req.method==='OPTIONS')return c.body(null,204);
    if(c.req.method!=='POST')return c.body(null,405);
    if(new URL(c.req.url).search || c.req.header('Content-Type')?.split(';')[0].trim()!=='application/json')return c.body(null,400);
    // Process-wide, bounded throttle. No IP, browser fingerprint or auth header is retained.
    if(Date.now()>=windowEnd){windowEnd=Date.now()+60000;remaining=1000;}
    if(!c.req.path.endsWith('/revoke') && remaining--<=0)return c.body(null,429);
    await next();
  });
  routes.use('*',bodyLimit({maxSize:24000,onError:c=>c.body(null,413)}));
  routes.post('/visitors',async c=>{
    const v=record(await c.req.json().catch(()=>null));
    if(v?.consent!==true||v.version!==JOURNEY_VERSION||Object.keys(v).length!==2)return c.body(null,400);
    return c.json(await repository.createVisitor(),201);
  });
  routes.post('/events',async c=>{
    const v=record(await c.req.json().catch(()=>null));
    if(!v||typeof v.token!=='string'||!TOKEN.test(v.token)||!Array.isArray(v.events)||v.events.length<1||v.events.length>30||Object.keys(v).length!==2)return c.body(null,400);
    const events=v.events.map(e=>parseWebEvent(e));
    if(events.some(e=>!e))return c.body(null,400);
    const accepted=await repository.ingestWeb(v.token,events as NonNullable<typeof events[number]>[]);
    return accepted===null?c.body(null,403):accepted===-1?c.body(null,429):c.json({accepted});
  });
  for(const action of ['revoke','handoff'] as const)routes.post('/'+action,async c=>{
    const v=record(await c.req.json().catch(()=>null));
    if(!v||typeof v.token!=='string'||!TOKEN.test(v.token)||Object.keys(v).length!==1)return c.body(null,400);
    if(action==='revoke'){await repository.revokeVisitor(v.token);return c.body(null,204);}
    const result=await repository.issueHandoff(v.token);return result?c.json(result):c.body(null,403);
  });
  routes.all('*',c=>c.body(null,404));routes.onError((_error,c)=>c.body(null,503));
  return routes;
}
export function createAppJourneyRoutes(repository=store,authenticate=requireInstallation) {
  const routes=new Hono<AppEnv>();routes.use('*',authenticate);
  routes.use('*',bodyLimit({maxSize:12000,onError:c=>c.body(null,413)}));
  routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  routes.get('/',async c=>c.json({link:await repository.readLink(c.get('installationId')!)}));
  routes.post('/',async c=>{
    const v=record(await c.req.json().catch(()=>null));
    if(!v||v.consent!==true||v.version!==JOURNEY_VERSION||typeof v.token!=='string'||!TOKEN.test(v.token)||Object.keys(v).length!==3)return c.body(null,400);
    const id=await repository.claimHandoff(c.get('installationId')!,v.token);
    return id?c.json({link:await repository.readLink(c.get('installationId')!)}):c.body(null,409);
  });
  routes.delete('/',async c=>{await repository.revokeLink(c.get('installationId')!);return c.json({link:null});});
  routes.post('/events',async c=>{
    const v=record(await c.req.json().catch(()=>null));
    if(!v||typeof v.receipt!=='string'||!UUID.test(v.receipt)||!Array.isArray(v.events)||v.events.length<1||v.events.length>30||Object.keys(v).length!==2)return c.body(null,400);
    const events=v.events.map(record);
    if(events.some(e=>!e||Object.keys(e).length!==3||typeof e.id!=='string'||!UUID.test(e.id)||!APP_EVENTS.includes(e.name as typeof APP_EVENTS[number])||!validTime(e.at)))return c.body(null,400);
    const accepted=await repository.ingestApp(c.get('installationId')!,v.receipt,events as store.AppEvent[]);
    return accepted===null?c.body(null,403):accepted===-1?c.body(null,429):c.json({accepted});
  });return routes;
}
