import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { sha256Hex } from "./converter/client.js";
import { createHumanThumbnailRoutes } from "./human-thumbnail.js";
import { DASHBOARD_HTML } from "./ops/dashboard.js";

const source = Buffer.from("public registered BVH");
const hash = sha256Hex(source);
const image = Buffer.from([137,80,78,71,13,10,26,10,1]);
function poster(change: Record<string,string> = {}) {
  return new Response(image, {headers: {
    "Content-Type":"image/png", "X-Standin-Poster-Kind":"default-body",
    "X-Standin-Poster-Version":"default-body-poster-v1", "X-Standin-Source-BVH-SHA256":hash,
    "X-Standin-Output-Scope":"full", "X-Standin-Preview-Only":"true",
    "X-Standin-Preview-Projection":"orthographic", "X-Standin-Character-Id":"standin-master-v2",
    "X-Standin-Character-SHA256":"7c648b97a24a3bb4914b6e5d515708c33727979881d92ef916d5726e22301f3d",
    "X-Standin-Preview-Revision":"b".repeat(64), "X-Standin-Artifact-SHA256":sha256Hex(image),
    "X-Standin-Preview-Method":"reference-skinning-v1", "X-Standin-Template-SHA256":"c".repeat(64), ...change,
  }});
}
function app(overrides: Parameters<typeof createHumanThumbnailRoutes>[0] = {}) {
  return new Hono<AppEnv>().route("/",createHumanThumbnailRoutes({
    getPoseBvh: async () => new Response(source), getPosePoster: async () => poster(), ...overrides,
  }));
}
test("human reference reads static poster with server-computed source SHA and drops legacy validators", async () => {
  let calls=0;
  const a=app({getPosePoster:async(id,sha,scope)=>{
    calls++;assert.equal(id,"pose/a b");assert.equal(sha,hash);assert.equal(scope,"full");return poster();
  }});
  const r=await a.request('/pose%2Fa%20b/reference-thumbnail?source_sha256=wrong&view=side',{
    headers:{"If-None-Match":"old-jpeg"},
  });
  assert.equal(r.status,200);assert.equal(calls,1);
  assert.equal(r.headers.get("Cache-Control"),"private, no-store");
  assert.equal(r.headers.get("Content-Type"),"image/png");
  assert.equal(r.headers.get("ETag"),null);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),image);
});
test("quarantined, missing, oversized and empty BVH never reach poster lookup", async () => {
  for(const response of [new Response(null,{status:404}),new Response(new Uint8Array(2_000_001)),new Response("")]) {
    let calls=0;
    const r=await app({getPoseBvh:async()=>response,getPosePoster:async()=>{calls++;return poster();}}).request('/pose/reference-thumbnail');
    assert.equal(r.status,404);assert.equal(calls,0);assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
});
test("reference thumbnails use the requested body scope and reject mismatched full-body posters", async () => {
  for (const scope of ["full", "half", "bust", "shoulder_head", "head"]) {
    const r = await app({ getPosePoster: async (_id, _sha, requested) => {
      assert.equal(requested, scope);
      return poster({ "X-Standin-Output-Scope": scope });
    } }).request("/pose/reference-thumbnail?scope=" + scope);
    assert.equal(r.status, 200, scope);
  }
  const mismatch = await app().request("/pose/reference-thumbnail?scope=half");
  assert.equal(mismatch.status, 404, "a full-body poster must not stand in for an upper-body preview");
  const missing = await app({ getPosePoster: async () => new Response(null, { status: 404 }) })
    .request("/pose/reference-thumbnail?scope=half");
  assert.equal(missing.status, 404);
});
test("invalid scope is rejected before any library read", async () => {
  let reads = 0;
  for (const scope of ["", "upper", "../full"]) {
    const r = await app({ getPoseBvh: async () => { reads++; return new Response(source); } })
      .request("/pose/reference-thumbnail?scope=" + encodeURIComponent(scope));
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal(reads, 0);
});
test("missing or corrupt poster and pose-only drawing fail closed instead of showing a paper figure",async()=>{
  for(const response of [new Response(null,{status:404}),poster({"X-Standin-Artifact-SHA256":"0".repeat(64)}),
    poster({"X-Standin-Poster-Kind":"pose-only","X-Standin-Preview-Method":"pose-only","X-Standin-Character-Id":"none","X-Standin-Character-SHA256":"none"})]){
    const r=await app({getPosePoster:async()=>response}).request('/pose/reference-thumbnail');
    assert.equal(r.status,404);assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
});
test("dashboard candidate and library loaders both request human references with admin auth and no cache",async()=>{
  // Execute the actual emitted dashboard loader functions, without opening a live app.
  type BrowserRequest = RequestInit & { cache?: string };
  const calls: Array<[string,BrowserRequest]> = [];
  const context=vm.createContext({token:'admin-test',detailBlobUrls:[],gallery:{blobs:[]},
    URL:{createObjectURL:()=> 'blob:human'},
    fetch:async(url:string,init:BrowserRequest)=>{calls.push([url,init]);return new Response(image);},
  });
  for(const name of ['fillCandidateThumb','galleryPoseThumb']){
    const start=DASHBOARD_HTML.indexOf('async function '+name+'(');
    const end=DASHBOARD_HTML.indexOf('\n}\n',start)+2;
    assert.ok(start>=0&&end>start);vm.runInContext(DASHBOARD_HTML.slice(start,end),context);
    context.img={dataset:{pose:'pose/a b',galPose:'pose/a b',view:'side'},parentElement:{querySelector:()=>null}};
    await vm.runInContext(name+'(img)',context);
  }
  assert.equal(calls.length,2);
  for(const [url,init] of calls){
    assert.equal(url,'/v1/admin/review/pose-candidates/pose%2Fa%20b/reference-thumbnail?revision=human-poster-v1');
    assert.equal(init.cache,'no-store');assert.equal((init.headers as Record<string,string>)['X-Beta-Admin-Token'],'admin-test');
  }
});

test("dashboard frames each person's cards using its own resolved output scope", () => {
  const context = vm.createContext({ PREVIEW_SCOPE_LABELS: {
    full: "전신", half: "상반신", bust: "가슴 위", shoulder_head: "어깨 위", head: "두상",
  } });
  for (const name of ["esc", "pill", "candidatePreviewScope", "candidateFramingControls", "candidateCard"]) {
    const start = DASHBOARD_HTML.indexOf("function " + name + "(");
    const end = DASHBOARD_HTML.indexOf("\n}", start) + 2;
    assert.ok(start >= 0 && end > start);
    vm.runInContext(DASHBOARD_HTML.slice(start, end), context);
  }
  assert.equal(vm.runInContext("candidatePreviewScope({outputScope:{resolved:'half'}})", context), "half");
  assert.equal(vm.runInContext("candidatePreviewScope({outputScope:{resolved:'head'}})", context), "head");
  assert.equal(vm.runInContext("candidatePreviewScope({})", context), "full");
  assert.equal(vm.runInContext("candidatePreviewScope({outputScope:{resolved:'__proto__'}})", context), "full");
  context.row = { pose_id: "pose", candidate_id: "c", view: "front", rank: 1 };
  assert.match(vm.runInContext("candidateCard(row, null, 'half')", context), /data-scope="half"/);
  assert.match(vm.runInContext("candidateFramingControls('half')", context), /상반신만/);
  assert.match(vm.runInContext("candidateFramingControls('half')", context), /전신 참고/);
  assert.equal(vm.runInContext("candidateFramingControls('full')", context), "");
});

test("switching preview scope ignores stale responses and can recover after a missing partial poster", async () => {
  const pending: Array<(value: Response) => void> = [];
  const calls: string[] = [];
  const note = { hidden: true, textContent: "" };
  const img = { dataset: { pose: "pose", scope: "half" }, src: "", hidden: false,
    isConnected: true, parentElement: { querySelector: () => note } };
  let blobs = 0;
  const context = vm.createContext({ token: "admin-test", detailBlobUrls: [], img,
    URL: { createObjectURL: () => "blob:" + ++blobs },
    fetch: (url: string) => { calls.push(url); return new Promise<Response>((resolve) => pending.push(resolve)); },
  });
  const start = DASHBOARD_HTML.indexOf("async function fillCandidateThumb(");
  vm.runInContext(DASHBOARD_HTML.slice(start, DASHBOARD_HTML.indexOf("\n}\n", start) + 2), context);
  const partial = vm.runInContext("fillCandidateThumb(img)", context);
  img.dataset.scope = "full";
  const full = vm.runInContext("fillCandidateThumb(img)", context);
  pending[1](new Response(image)); await full;
  pending[0](new Response(null, { status: 404 })); await partial;
  assert.equal(img.src, "blob:1");
  assert.equal(img.hidden, false);
  assert.equal(note.hidden, true);
  assert.match(calls[0], /scope=half/);
  assert.ok(!calls[1].includes("scope="));
  img.dataset.scope = "half";
  const missing = vm.runInContext("fillCandidateThumb(img)", context);
  pending[2](new Response(null, { status: 404 })); await missing;
  assert.equal(img.hidden, true);
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /전신 참고/);
  img.dataset.scope = "full";
  const retry = vm.runInContext("fillCandidateThumb(img)", context);
  pending[3](new Response(image)); await retry;
  assert.equal(img.hidden, false);
  assert.equal(note.hidden, true);
});

test("new user and admin endpoints retain the existing authentication boundaries",async()=>{
  const {requireInstallation}=await import('./installations/middleware.js');
  const {createPoseRoutes}=await import('./pose/routes.js');
  const {adminRoutes}=await import('./admin/routes.js');
  let reads=0;
  const user=new Hono<AppEnv>();
  user.use('/v1/pose-candidates/*',requireInstallation);
  user.route('/v1/pose-candidates',createPoseRoutes({getPoseBvh:async()=>{reads++;return new Response(source);}}));
  assert.equal((await user.request('/v1/pose-candidates/pose/reference-thumbnail')).status,401);
  assert.equal(reads,0);
  assert.equal((await adminRoutes.request('/review/pose-candidates/pose/reference-thumbnail')).status,404);
});

test("dashboard emitted JavaScript parses after replacing the thumbnail loaders",()=>{
  const start=DASHBOARD_HTML.indexOf('<script>')+8;
  const end=DASHBOARD_HTML.lastIndexOf('</script>');
  assert.ok(start>=8&&end>start);
  assert.doesNotThrow(()=>new vm.Script(DASHBOARD_HTML.slice(start,end)));
});
