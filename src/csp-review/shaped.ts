import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { errorEnvelope } from "../mapping.js";
import { loadBodyCatalog } from "../body-selection/catalog.js";
import { bodyStore, BodyError } from "../body-selection/store.js";
import { normalizeControls, shapeSha256, sameShapeSource, type BodyShape, type ShapeSource } from "../body-selection/shape.js";
import { getOwnedJob } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";
import { storedZip } from "./zip.js";

type ShapeRequest = { character_id: string; character_sha256: string; shape: BodyShape; expected_shape_source: ShapeSource };
export async function generateShapedVrm(input: ShapeRequest, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(config.converterBaseUrl.replace(/\/$/, "") + "/csp-shape", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.converterShapeTimeoutMs)]),
  });
  if (!response.ok) throw new Error("CSP shape conversion failed");
  const raw = await response.text(); if (raw.length > 36 * 1024 * 1024) throw new Error("shape output too large");
  const value = JSON.parse(raw) as { vrm_base64: string; report: { schema: string; character_id: string; character_sha256: string; shape_sha256: string; source: ShapeSource; artifact_sha256: string; artifact_bytes: number; controls: Record<string,number>; qa: Record<string,unknown> } };
  const r = value.report;
  if (r.schema !== "csp-shape.v1" || r.character_id !== input.character_id || r.character_sha256 !== input.character_sha256 ||
      r.shape_sha256 !== input.shape.shapeSha256 || !sameShapeSource(input.expected_shape_source,r.source)) throw new Error("shape source mismatch");
  const bytes = new Uint8Array(Buffer.from(value.vrm_base64, "base64"));
  if (bytes.length !== r.artifact_bytes || sha256Hex(bytes) !== r.artifact_sha256 || new TextDecoder().decode(bytes.subarray(0,4)) !== "glTF") throw new Error("shape bytes mismatch");
  for (const [key,v] of Object.entries(input.shape.controls)) if (r.controls[key === "height" ? "height_cm" : key] !== v) throw new Error("shape control omitted");
  return { bytes, report: r };
}
const defaults = { selection: bodyStore.selection, catalog: loadBodyCatalog, job: getOwnedJob, generate: generateShapedVrm,
  enabled: () => config.cspShapeEnabled };
export function createShapedCspRoutes(internalFetch: (r: Request) => Response | Promise<Response>, overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides }, app = new Hono<AppEnv>();
  app.get("/bundle", async c => {
    if (!deps.enabled()) return c.notFound();
    const q = c.req.query(), index = Number(q.personIndex), revision = Number(q.bodySelectionRevision);
    if (!q.jobId || !q.candidateId || !q.poseId || q.poseId.length > 300 || !/^\d+$/.test(q.personIndex ?? "") || !/^\d+$/.test(q.bodySelectionRevision ?? "") ||
        !Number.isSafeInteger(index) || !Number.isSafeInteger(revision) || Object.keys(q).some(k => !["jobId","candidateId","poseId","personIndex","bodySelectionRevision"].includes(k)))
      return c.json(errorEnvelope("INVALID_INPUT", "저장할 체형과 포즈를 확인해 주세요.", c.get("requestId")), 400);
    const fail = (code: string, status: 409 | 503 = 409) => c.json(errorEnvelope(code,"체형이나 포즈가 변경되었습니다. 다시 확인해 주세요.",c.get("requestId")),status);
    try {
      const owner = c.get("installationId")!, selected = await deps.selection(owner,q.jobId,index);
      if (selected.selectionRevision !== revision || selected.resolutionStatus !== "ready" || !selected.resolvedBody) return fail("BODY_PREVIEW_STALE");
      const asset = deps.catalog().assets.find(a => a.characterId === selected.resolvedBody!.characterId);
      if (!asset?.cspNative || !asset.shapeSource || !asset.shape || asset.assetSha256 !== selected.resolvedBody.assetSha256) return fail("BODY_CSP_UNSUPPORTED");
      const job = await deps.job(q.jobId,owner), person = job?.result?.candidatesByPerson.find(p => p.personIndex === index);
      if (person?.handSelection && person.handSelection.revision > 0) return fail("CSP_HANDS_UNSUPPORTED");
      const controls = normalizeControls(asset.shape,selected.shape?.controls ?? {});
      const shape:BodyShape = {schemaVersion:"body-shape.v1",controls,shapeSha256:shapeSha256(asset,controls)};
      const body = { character_id: asset.characterId, character_sha256: asset.assetSha256, shape, expected_shape_source: asset.shapeSource };
      const url = new URL(c.req.url);url.pathname = `/v1/pose-candidates/${encodeURIComponent(q.poseId)}/export`;
      url.searchParams.delete("poseId");url.searchParams.delete("bodySelectionRevision");url.searchParams.set("format","bvh");
      const pose = () => internalFetch(new Request(url,{ headers: c.req.raw.headers, signal: c.req.raw.signal }));
      const source = await pose(); if (!source.ok) return source;
      const bvh = new Uint8Array(await source.arrayBuffer());
      if (bvh.length > 8 * 1024 * 1024 || !new TextDecoder().decode(bvh.subarray(0,100)).trimStart().startsWith("HIERARCHY")) return fail("CSP_POSE_INTEGRITY");
      const generated = await deps.generate(body,c.req.raw.signal);
      const current = await deps.selection(owner,q.jobId,index), currentAsset = deps.catalog().assets.find(a => a.characterId === asset.characterId);
      const nowJob = await deps.job(q.jobId,owner), nowPerson = nowJob?.result?.candidatesByPerson.find(p => p.personIndex === index);
      if (JSON.stringify(current) !== JSON.stringify(selected) || JSON.stringify(currentAsset?.shapeSource) !== JSON.stringify(asset.shapeSource) || JSON.stringify(nowPerson?.handSelection) !== JSON.stringify(person?.handSelection)) return fail("BODY_PREVIEW_STALE");
      const fresh = await pose(); if (!fresh.ok) return fresh;
      if (sha256Hex(new Uint8Array(await fresh.arrayBuffer())) !== sha256Hex(bvh)) return fail("POSE_PREVIEW_STALE");
      const manifest = { schema:"standin-csp-shaped-bundle.v1",body: selected.resolvedBody,shape,shapeSource:asset.shapeSource,bodySelectionRevision:revision,
        selection:{jobId:q.jobId,personIndex:index,candidateId:q.candidateId,poseId:q.poseId},shapeBake:generated.report,
        artifacts:{"model.vrm":{sha256:sha256Hex(generated.bytes),bytes:generated.bytes.length},"pose.bvh":{sha256:sha256Hex(bvh),bytes:bvh.length}},
        CSP:{angleLimit:"enable in CSP",lockRegions:["chest","abdomen","pelvis"],locksEmbedded:false,poseApplicationVerified:false},
        cameraApplied:false,handSelectionApplied:false,sceneMerged:false };
      const enc = (s: string) => new TextEncoder().encode(s);
      const zip = storedZip([{name:"model.vrm",bytes:generated.bytes},{name:"pose.bvh",bytes:bvh},
        {name:"manifest.json",bytes:enc(JSON.stringify(manifest,null,2)+"\n")},
        {name:"README.txt",bytes:enc("선택한 체형과 슬라이더 값을 반영한 CSP 인형·포즈입니다.\nmodel.vrm을 3D 데이터로 가져온 뒤 모델을 선택해 pose.bvh를 포즈로 적용하세요.\n관절 각도 제한을 켜고 가슴·복부·골반을 고정해 사용하세요.\n카메라·손 선택·통합 장면은 이 저장에 포함되지 않습니다.\nCSP의 BVH 적용 결과와 고정 유지 여부는 실제 환경에서 확인해야 합니다.\n")}]);
      return new Response(zip,{headers:{"Content-Type":"application/zip","Cache-Control":"private, no-store","Content-Disposition":`attachment; filename="standin-${asset.characterId}-csp.zip"`,"Content-Length":String(zip.length),"X-Standin-Artifact-SHA256":sha256Hex(zip),"X-Standin-Shape-SHA256":shape.shapeSha256}});
    } catch (e) {
      if (e instanceof BodyError) return c.json(errorEnvelope(e.code,"체형 선택을 다시 확인해 주세요.",c.get("requestId")),e.status);
      return fail("CSP_SHAPE_UNAVAILABLE",503);
    }
  });
  return app;
}
