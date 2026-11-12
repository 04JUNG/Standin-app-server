import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { InteractiveService, type InteractiveDeps } from "./service.js";
import { createInteractiveRoutes } from "./routes.js";
import type { Location } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
import type { Skin } from "../appearance/skin.js";
import { hash, InteractiveError } from "./model.js";
import { fixtureSelection } from "./fixture.js";
import type { SkinPreview } from "../appearance/skin-preview.js";
const digest = hash("texture"), baseHash = hash("base"), skin = { version: "fbx-skin-v1", id: "flesh" } as const;
function setup() {
  let currentHash = baseHash, work = 0, assets = 0;
  const preview = { schema: "skin-preview-v1", skin, uv: { sha256: hash("uv"), bytes: 10 }, texture: { sha256: digest, bytes: 3 } } as SkinPreview;
  const forbidden = () => { work++; throw Error("No solve/export/store access allowed"); };
  const service = new InteractiveService({
    resolve: async (l: Location) => { if (l.installationId !== "owner") throw new InteractiveError("NOT_FOUND", 404); return { ...fixtureSelection(currentHash), selectionHash: currentHash }; },
    skin: { check: async (_selection: ResolvedSelection, selected?: Skin) => ({ identity: hash("approved"), supportedIds: ["flesh"], preview: { ...preview, skin: selected ?? skin } }),
      previewAsset: async (_selection: ResolvedSelection, _skin: Skin, requested: string) => { assets++; if (requested !== digest) throw new InteractiveError("NOT_FOUND",404); return { bytes: new Uint8Array([1,2,3]), contentType: "image/png" }; }, prepare: forbidden, file: forbidden },
    worker: { solve: forbidden, model: forbidden, export: forbidden, file: forbidden, cancel: forbidden },
    store: new Proxy({}, { get: forbidden }), posters: {}, renderPoster: forbidden, metric: () => {},
  } as unknown as InteractiveDeps);
  const app = new Hono<AppEnv>();
  app.use("*", async (c,next) => { c.req.raw.headers.set("X-Standin-Interactive-Protocol", "pose-body-only-v1"); if (c.req.header("X-Owner")) c.set("installationId",c.req.header("X-Owner")!); await next(); });
  app.route("/v1/analysis/jobs",createInteractiveRoutes(service,()=>true));
  const path = "/v1/analysis/jobs/job_test/people/0/selection-skin-preview?"+new URLSearchParams({candidateId:"candidate",skin:JSON.stringify(skin)});
  const request = (url: string, owner="owner") => app.request(url,{headers:{"X-Owner":owner}});
  return { request, path, change() { currentHash = hash("changed body or hands"); }, get work() { return work; }, get assets() { return assets; } };
}
test("appearance metadata/assets need no solve/export and survive operation changes, not base changes",async()=>{
 const s=setup();const response=await s.request(s.path);assert.equal(response.status,200);assert.match(response.headers.get("Cache-Control")!,/private, no-store/);
 const descriptor=await response.json() as {baseSelectionHash:string;skinPreview:{texture:{url:string}}};assert.equal(descriptor.baseSelectionHash,baseHash);
 const asset=await s.request(descriptor.skinPreview.texture.url);assert.equal(asset.status,200);
 assert.equal(asset.headers.get("X-Standin-Base-Selection-Hash"),baseHash);assert.equal(asset.headers.get("X-Skin-Asset-SHA256"),digest);
 assert.equal(s.work,0);assert.equal(s.assets,1);
 s.change();const stale=await s.request(descriptor.skinPreview.texture.url);assert.equal(stale.status,409);assert.equal(s.assets,1);
});
test("read-only overlays preserve owner boundaries and reject unapproved/malformed requests",async()=>{
 const s=setup();assert.equal((await s.request(s.path,"other")).status,404);assert.equal((await s.request(s.path,"")).status,404);
 assert.equal((await s.request(s.path.replace(encodeURIComponent(JSON.stringify(skin)),encodeURIComponent(JSON.stringify({...skin,url:"https://untrusted"}))))).status,400);
 const descriptor=await (await s.request(s.path)).json() as {skinPreview:{texture:{url:string}}};
 assert.equal((await s.request(descriptor.skinPreview.texture.url.replace(digest,hash("unknown")))).status,404);
 assert.equal((await s.request(descriptor.skinPreview.texture.url.replace(/baseSelectionHash=[^&]+/,"baseSelectionHash=invalid"))).status,400);
 assert.equal(s.work,0);
});

test("all five approved overlays resolve without operation work",async()=>{
 const s=setup();
 for(const id of ["flesh","gray-guide","flesh-guide","muscle","flesh-muscle"]){
  const response=await s.request(s.path.replace(encodeURIComponent(JSON.stringify(skin)),encodeURIComponent(JSON.stringify({...skin,id}))));
  assert.equal(response.status,200);const data=await response.json() as {skinPreview:{skin:{id:string}}};assert.equal(data.skinPreview.skin.id,id);
 }
 assert.equal(s.work,0);
});
