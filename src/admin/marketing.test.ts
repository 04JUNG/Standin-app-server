import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMetaReader, metaWindow, DOWNLOAD_ACTION } from './marketing.js';
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
  assert.deepEqual(a,b); assert.equal(a.status,'ready'); assert.equal(count,2);
  assert.equal(a.snapshot?.rows[0].landingViews,45); assert.equal(a.snapshot?.rows[1].spend,0);
  assert.ok(!JSON.stringify(a).includes(settings.token));
  await read(7);assert.equal(count,2);
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
    assert.deepEqual(filter[0].value,['52571670110169','52571947001569','52572453148369','52572454477769']);
    return response({data:[ad,{...ad,ad_id:'52572453148369',spend:'600',actions:[
      {action_type:DOWNLOAD_ACTION,value:'3'},
      {action_type:'offsite_conversion.fb_pixel_custom',value:'90'},
      {action_type:'offsite_conversion.custom.123',value:'20'},
    ]}]});
  });
  const rows=(await read(7)).snapshot!.rows;
  assert.equal(rows.length,4);
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
    pages++;
    if(pages===1) return response({data:[ad],paging:{next:'https://evil.invalid/?token=secret',cursors:{after:'cursor2'}}});
    assert.equal(new URL(String(url)).searchParams.get('after'),'cursor2');
    return response({data:[{...ad,ad_id:'52571947001569'}]});
  });
  assert.equal((await read(7)).status,'ready');assert.equal(pages,2);
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
  assert.ok(counts.includes('표본 부족 (5건 미만)'));
  assert.ok(counts.includes('전날까지의 합계'));assert.ok(!counts.includes('<td>0</td>'));
});
