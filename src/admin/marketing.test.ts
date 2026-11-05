import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMetaReader, metaWindow, DOWNLOAD_ACTION, SUPPORTERS_ADSET, MARKETING_CREATIVES } from './marketing.js';
import { DASHBOARD_HTML } from '../ops/dashboard.js';
const settings = { token: 'test-secret-never-return', version: 'v25.0', accountId: '1090943087171654' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const account = { currency: 'KRW', timezone_name: 'Asia/Seoul' };
const ad = { ad_id: '52571670110169', spend: '10142', impressions: '2407', inline_link_clicks: '49', actions: [{ action_type:'landing_page_view', value:'45' }] };
test('calendar window follows Seoul midnight and handles month boundaries', () => {
  assert.deepEqual(metaWindow(7, Date.parse('2026-10-31T15:01:00Z')), { since:'2026-10-26',until:'2026-11-01' });
});
test('unconfigured has no metrics and performs no network request', async () => {
  const read = createMetaReader({...settings,token:''}, async()=>{throw Error('unexpected');});
  assert.deepEqual(await read(7), {status:'unconfigured',snapshot:null});
  await assert.rejects(read(91));
});
test('maps creatives, deduplicates concurrent calls, caches, uses bearer header', async () => {
  let count=0;
  const read=createMetaReader(settings, async(url,options)=>{
    count++;
    assert.ok(!String(url).includes(settings.token));
    assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+settings.token);
    assert.equal(options?.redirect,'error');
    return response(String(url).includes('/insights') ? {data:[ad]} : account);
  });
  const [a,b]=await Promise.all([read(7),read(7)]);
  assert.deepEqual(a,b); assert.equal(a.status,'ready'); assert.equal(count,4);
  assert.equal(a.snapshot?.rows[0].landingViews,45); assert.equal(a.snapshot?.rows[1].spend,0);
  assert.ok(!JSON.stringify(a).includes(settings.token));
  await read(7);assert.equal(count,4);
});
test('failure retains successful data as stale, never zeroes results',async()=>{
  let now=Date.parse('2026-10-29T01:00:00Z'), fail=false;
  const read=createMetaReader(settings,async(url)=>{
    if(fail) throw Error(settings.token);
    return response(String(url).includes('/insights')?{data:[ad]}:account);
  },()=>now);
  await read(7);now+=61000;fail=true;
  const result=await read(7);assert.equal(result.status,'stale');assert.equal(result.snapshot?.rows[0].spend,10142);
  assert.ok(!JSON.stringify(result).includes(settings.token));
  assert.equal((await read(1)).status,'unavailable');
});

test('separates optimization phases and counts only the exact download conversion',async()=>{
  const read=createMetaReader(settings,async(url)=>{
    if(!String(url).includes('/insights')) return response(account);
    const filter=JSON.parse(new URL(String(url)).searchParams.get('filtering')!);
    assert.deepEqual(filter[0].value,['52571670110169','52571947001569','52572453148369','52572454477769','52573071176169']);
    return response({data:[ad,{...ad,ad_id:'52572453148369',spend:'600',actions:[
      {action_type:DOWNLOAD_ACTION,value:'3'},
      {action_type:'offsite_conversion.fb_pixel_custom',value:'90'},
      {action_type:'offsite_conversion.custom.123',value:'20'},
    ]}]});
  });
  const rows=(await read(7)).snapshot!.rows;
  assert.equal(rows.length,5);
  assert.equal(rows[0].phase,'landing'); assert.equal(rows[0].spend,10142);
  assert.equal(rows[2].phase,'download'); assert.equal(rows[2].creative,rows[0].creative);
  assert.equal(rows[2].downloadClicks,3); assert.equal(rows[2].spend,600);
  assert.equal(rows[3].downloadClicks,0);
});

test('Meta access block returns a safe recovery reason without private error details',async()=>{
  const read=createMetaReader(settings,async()=>response({error:{code:200,message:'API access blocked.',fbtrace_id:settings.token}},400));
  assert.deepEqual(await read(7),{status:'unavailable',snapshot:null,reason:'access_blocked'});
});
test('rejects invalid metrics, currency, API error and duplicate rows',async()=>{
  for(const body of [{data:[{...ad,spend:'NaN'}]}, {data:[ad,ad]}, {error:{message:settings.token}}]){
    const read=createMetaReader(settings,async(url)=>response(String(url).includes('/insights')?body:account));
    assert.deepEqual(await read(7),{status:'unavailable',snapshot:null});
  }
  const read=createMetaReader(settings,async()=>response({...account,currency:'USD'}));
  assert.equal((await read(7)).status,'unavailable');
});
test('pagination uses only cursor on fixed Meta host',async()=>{
  let pages=0;
  const read=createMetaReader(settings,async(url)=>{
    assert.equal(new URL(String(url)).hostname,'graph.facebook.com');
    if(!String(url).includes('/insights')) return response(account);
    if(new URL(String(url)).searchParams.has('time_increment')) return response({data:[]});
    pages++;
    if(pages===1) return response({data:[ad],paging:{next:'https://evil.invalid/?token=secret',cursors:{after:'cursor2'}}});
    assert.equal(new URL(String(url)).searchParams.get('after'),'cursor2');
    return response({data:[{...ad,ad_id:'52571947001569'}]});
  });
  assert.equal((await read(7)).status,'ready');assert.equal(pages,2);
});

const fixedNow = Date.parse('2026-11-05T10:00:00Z');
const dailyAd = {...ad,date_start:'2026-11-05',date_stop:'2026-11-05',reach:'2100',frequency:'1.146190'};
const supporters = {
  id:SUPPORTERS_ADSET,account_id:settings.accountId,effective_status:'ACTIVE',
  lifetime_budget:'50000',budget_remaining:'19369',start_time:'2026-11-04T09:00:00+0900',end_time:'2026-11-06T23:59:00+0900',
  insights:{data:[{...dailyAd,spend:'30631',impressions:'3672',date_start:'2026-11-04',actions:[
    {action_type:'landing_page_view',value:'120'},{action_type:'omni_landing_page_view',value:'120'},
    {action_type:'onsite_conversion.post_save',value:'20'},{action_type:'post',value:'5'},
  ]}]},
};
function fixture(url: string | URL | Request) {
  const u = new URL(String(url));
  if(u.pathname.endsWith('/'+SUPPORTERS_ADSET)) return supporters;
  if(u.pathname.endsWith('/insights')) return {data:[{...dailyAd,ad_id:'52573071176169'}]};
  return account;
}
test('supporters budget is lifetime KRW and independent of the selected daily reporting window',async()=>{
  const read=createMetaReader(settings,async(url)=>{
    const u=new URL(String(url));
    if(u.pathname.endsWith('/'+SUPPORTERS_ADSET)) {
      assert.ok(u.searchParams.get('fields')?.includes('date_preset(maximum)'));
      assert.ok(!u.searchParams.has('time_range'));
    }
    return response(fixture(url));
  },()=>fixedNow);
  const one=await read(1),seven=await read(7);
  assert.equal(one.status,'ready'); assert.equal(one.daily?.status,'ready'); assert.equal(one.supporters?.status,'ready');
  assert.equal(one.snapshot?.rows[4].phase,'supporters');
  assert.deepEqual(one.supporters?.snapshot,seven.supporters?.snapshot);
  assert.equal(one.supporters?.snapshot?.lifetimeBudget,50000);
  assert.equal(one.supporters?.snapshot?.remainingBudget,19369);
  assert.equal(one.supporters?.snapshot?.lifetime.spend,30631);
  assert.equal(one.supporters?.snapshot?.lifetime.landingViews,120,'overlapping landing action not double counted');
  assert.equal(one.supporters?.snapshot?.lifetime.saves,20);
  assert.equal(one.supporters?.snapshot?.lifetime.shares,5);
  assert.equal(one.daily?.snapshot?.rows[0].day,'2026-11-05');
  assert.equal(one.daily?.snapshot?.rows[0].reach,2100);
});

test('optional API failures preserve the summary and mark each stale report independently',async()=>{
  let now=fixedNow,failDaily=false,failBudget=false,failAll=false;
  const read=createMetaReader(settings,async(url)=>{
    const u=new URL(String(url));
    if(failAll || failDaily && u.searchParams.has('time_increment') || failBudget && u.pathname.endsWith('/'+SUPPORTERS_ADSET)) throw Error(settings.token);
    return response(fixture(url));
  },()=>now);
  const first=await read(7);
  now+=61000; failDaily=true;
  const second=await read(7);
  assert.equal(second.status,'ready');assert.equal(second.daily?.status,'stale');assert.equal(second.supporters?.status,'ready');
  assert.equal(second.daily?.snapshot?.fetchedAt,first.daily?.snapshot?.fetchedAt);
  now+=61000;failBudget=true;
  const third=await read(7);
  assert.equal(third.supporters?.status,'stale');assert.equal(third.supporters?.snapshot?.remainingBudget,19369);
  const otherWindow=await read(1);
  assert.equal(otherWindow.status,'ready');assert.equal(otherWindow.daily?.status,'unavailable');assert.equal(otherWindow.daily?.snapshot,null);
  now+=61000;failAll=true;
  const all=await read(7);assert.equal(all.status,'stale');assert.equal(all.daily?.status,'stale');assert.equal(all.supporters?.status,'stale');
  assert.ok(!JSON.stringify(all).includes(settings.token));
});

test('daily records distinguish dates and reject duplicate or out of range dates without losing totals',async()=>{
  for (const [data,status] of [
    [[dailyAd,{...dailyAd,date_start:'2026-11-04',date_stop:'2026-11-04'}],'ready'],
    [[dailyAd,dailyAd],'unavailable'],
    [[{...dailyAd,date_start:'2026-10-01',date_stop:'2026-10-01'}],'unavailable'],
    [[{...dailyAd,date_stop:'2026-11-06'}],'unavailable'],
    [[{...dailyAd,date_start:'2026-02-30',date_stop:'2026-02-30'}],'unavailable'],
  ] as const) {
    const read=createMetaReader(settings,async(url)=>response(new URL(String(url)).searchParams.has('time_increment') ? {data} : fixture(url)),()=>fixedNow);
    const result=await read(7);assert.equal(result.status,'ready');assert.equal(result.daily?.status,status);
    if(status==='ready')assert.equal(result.daily?.snapshot?.rows.length,2);
  }
});

test('supporters metadata rejects wrong ownership and malformed budget without fabricating zero',async()=>{
  for(const extra of [{account_id:'123'},{lifetime_budget:'bad'},{remaining_budget:'bad',budget_remaining:null},{insights:{data:[dailyAd,dailyAd]}},{end_time:'bad'}]){
    const read=createMetaReader(settings,async(url)=>response(String(url).includes('/'+SUPPORTERS_ADSET+'?')?{...supporters,...extra}:fixture(url)),()=>fixedNow);
    const result=await read(7);assert.equal(result.status,'ready');assert.equal(result.supporters?.status,'unavailable');assert.equal(result.supporters?.snapshot,null);
  }
});

test('all configured ads remain a bounded explicit allowlist',()=>{
  assert.equal(new Set(MARKETING_CREATIVES.map(c=>c.adId)).size,5);
  assert.equal(MARKETING_CREATIVES.filter(c=>c.phase==='supporters').length,1);
});
test('dashboard JS parses and renders unknown attribution separately from API unavailability',()=>{
  const script=DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1];
  new vm.Script(script);
  const acquisition=script.slice(script.indexOf('function acquisitionBlock('),script.indexOf('function marketingRender('));
  const render=script.slice(script.indexOf('function marketingRender('),script.indexOf('let marketingRequest'));
  const ctx=vm.createContext({esc:(s:unknown)=>String(s).replaceAll('<','&lt;'),when:(s:unknown)=>s});
  vm.runInContext(acquisition+render,ctx);
  const html=vm.runInContext(`marketingRender({meta:{status:'unconfigured',snapshot:null},queriedAt:'now',since:'then',windowDays:7,acquisition:[{creative:'unknown',installations:4}]})`,ctx) as string;
  assert.ok(html.includes('API 연결 대기'));assert.ok(html.includes('출처 미확인'));
  assert.ok(html.includes('<td>4</td><td>—</td>'));assert.ok(html.includes('개발자 제외 설정'));
  assert.ok(html.includes('운영 집계가 제공되지 않았습니다'));
  const operational=vm.runInContext(`marketingUsageBlock({newInstallations:4,newStarted:3,newCompleted:2,activeInstallations:8,startedInstallations:5,completedInstallations:4,jobsStarted:12,jobsCompleted:10,hideInternal:true})`,ctx) as string;
  assert.ok(operational.includes('<td>4</td><td>3</td><td>2</td><td>50.0%</td>'));
  assert.ok(operational.includes('개발자 설치 제외'));
  assert.ok(!operational.includes('NaN'));
  const blocked=vm.runInContext(`marketingRender({meta:{status:'unavailable',snapshot:null,reason:'access_blocked'},queriedAt:'now',since:'then',windowDays:7,acquisition:[]})`,ctx) as string;
  assert.ok(blocked.includes('개발자 계정의 확인 안내'));
  const conversion=vm.runInContext(`marketingRender({meta:{status:'ready',snapshot:{since:'2026-10-31',until:'2026-10-31',fetchedAt:'now',rows:[{creative:'meta-poster-a',phase:'download',spend:600,impressions:100,clicks:10,landingViews:8,downloadClicks:3}]}},queriedAt:'now',since:'then',windowDays:7,acquisition:[]})`,ctx) as string;
  assert.ok(conversion.includes('다운로드 최적화 / 포스터 A'));
  assert.ok(conversion.includes('<td>3</td><td>200</td>'));
  assert.ok(conversion.includes('생성 전 기록은 소급 집계하지 않으며'));
  const counts=vm.runInContext(`campaignCountsBlock({enabled:true,since:'2026-10-25',until:'2026-10-31',rows:[{creative:'meta-poster-a',first_run:8,first_analysis_success:5},{creative:'meta-hook-a',first_run:null,first_analysis_success:null}]})`,ctx) as string;
  assert.ok(counts.includes('<td>8</td><td>5</td>'));
  assert.ok(counts.includes('<td>5건 미만</td>'));
  assert.ok(counts.includes('전날까지의 합계'));assert.ok(!counts.includes('<td>0</td>'));
  const mixed=vm.runInContext(`campaignCountsBlock({enabled:true,since:'2026-11-05',until:'2026-11-05',minimumCell:0,rows:[{creative:'meta-poster-a',first_run:2,first_analysis_success:0},{creative:'meta-hook-a',first_run:3,first_analysis_success:1}],previousPeriod:{since:'2026-11-01',until:'2026-11-04',minimumCell:5,rows:[{creative:'meta-poster-a',first_run:null,first_analysis_success:null}]}})`,ctx) as string;
  assert.ok(mixed.includes('<td>포스터 A</td><td>2</td><td>0</td>'));
  assert.ok(mixed.includes('<td>영상 A</td><td>3</td><td>1</td>'));
  assert.ok(mixed.includes('<td>포스터 A</td><td>5건 미만</td><td>5건 미만</td>'));
  assert.equal((mixed.match(/<caption>/g) ?? []).length,2);
});

test('dashboard distinguishes supporters lifetime budget, filtered spend, missing applications, and stale data',()=>{
  const script=DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1];
  const source=script.slice(script.indexOf('function acquisitionBlock('),script.indexOf('let marketingRequest'));
  const ctx=vm.createContext({esc:(s:unknown)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),when:(s:unknown)=>s});
  vm.runInContext(source,ctx);
  ctx.data={meta:{status:'ready',snapshot:{since:'2026-11-05',until:'2026-11-05',fetchedAt:'2026-11-05T10:00:00Z',rows:[
    {creative:'meta-poster-a',phase:'download',spend:600,impressions:100,clicks:10,landingViews:8,downloadClicks:3,reach:90,frequency:1.1,saves:2,shares:1},
    {creative:'meta-hook-a',phase:'download',spend:700,impressions:200,clicks:20,landingViews:9,downloadClicks:0,reach:180,frequency:1.1,saves:1,shares:0,videoViews:30},
    {creative:'supporters-poster',phase:'supporters',spend:100,impressions:50,clicks:5,landingViews:4,downloadClicks:0},
  ]},supporters:{status:'stale',snapshot:{fetchedAt:'2026-11-05T10:00:00Z',lifetimeBudget:50000,remainingBudget:19369,effectiveStatus:'ACTIVE',start:supporters.start_time,end:supporters.end_time,since:'2026-11-04',until:'2026-11-05',lifetime:{spend:30631,clicks:141,landingViews:120}}}},queriedAt:'now',windowDays:7,since:'then',acquisition:[]};
  const all=vm.runInContext('marketingRender(data)',ctx) as string;
  assert.ok(all.includes('1,400원'));assert.ok(all.includes('50,000원'));assert.ok(all.includes('30,631원'));assert.ok(all.includes('19,369원'));
  assert.ok(all.includes('조회 기간 필터와 무관'));assert.ok(all.includes('이전 데이터 · 갱신 실패'));
  assert.ok(all.includes('실제 지원서 제출 수: 자동 연결 전'));assert.ok(all.includes('Google Forms 자동 연결 전'));assert.ok(all.includes('GA4'));
  const only=vm.runInContext("marketingRender(data,'supporters')",ctx) as string;
  assert.ok(only.includes('100원'));assert.ok(!only.includes('1,400원'));assert.ok(!only.includes('신규 분석 성공률'));
  assert.ok(only.includes('30,631원'),'budget stays lifetime when scope changes');
  const beta=vm.runInContext("marketingRender(data,'beta')",ctx) as string;
  assert.ok(beta.includes('1,300원'));assert.ok(!beta.includes('30,631원'));
  assert.equal(vm.runInContext('marketingRatio(0,0,true)',ctx),'—');
  assert.ok(!all.includes('NaN'));assert.ok(!all.includes('Infinity'));
  const unavailable=vm.runInContext("marketingSupportersBlock({status:'unavailable',snapshot:null})",ctx) as string;
  assert.ok(unavailable.includes('잔여 예산을 0원으로 간주하지 않습니다'));assert.ok(!unavailable.includes('0원</div>'));
  const daily=vm.runInContext("marketingDailyBlock({status:'ready',snapshot:{since:'2026-11-04',until:'2026-11-05',fetchedAt:'now',rows:[]}},'all')",ctx) as string;
  assert.ok(daily.includes('<td>2026-11-04</td><td>0</td>'));assert.ok(daily.includes('오늘은 진행 중'));
  const attack=vm.runInContext("marketingAdTable([{creative:'<img src=x onerror=alert(1)>',phase:'download',spend:0,clicks:0,impressions:0,landingViews:0,downloadClicks:0}],'<svg onload=alert(1)>')",ctx) as string;
  assert.ok(!attack.includes('<img'));assert.ok(!attack.includes('<svg'));
});
