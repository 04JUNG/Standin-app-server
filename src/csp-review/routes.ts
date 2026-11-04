import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { sha256Hex } from "../converter/client.js";
import { createAssetLoader, reviewSettings } from "./assets.js";
import { storedZip } from "./zip.js";

const instructions = `스테이징 CSP 검증용: 기본 체형 VRM + 선택 포즈 BVH
1. model.vrm을 CSP [파일 → 가져오기 → 3D 데이터]로 가져옵니다.
2. 해당 모델을 선택하고 pose.bvh를 포즈로 적용합니다.
3. 관절 각도 제한을 켜고 가슴·복부·골반을 고정한 뒤 손발 표면을 끌어 확인합니다.
4. 어깨·겨드랑이·손가락·골반 접힘을 확인합니다.
이 묶음의 모델은 명시적으로 고른 검토용 기본 체형입니다. 앱에서 선택한
기존 체형·슬라이더·손 설정·카메라·통합 장면을 재현하는 완성 출력은 아닙니다.
VRM에 CSP 관절 고정 상태를 저장하지 않았습니다. 고정 지속 여부는 별도 확인합니다.
BVH 적용 후 모습과 native 제한은 CSP에서 검증해야 합니다. 비공개 검토용입니다.
`;

export function createCspReviewRoutes(
  internalFetch: (request: Request) => Response | Promise<Response>,
  load = createAssetLoader(), enabled = () => reviewSettings().enabled,
) {
  const routes = new Hono<AppEnv>();
  routes.get("/:sex/bundle", async c => {
    if (!enabled()) return c.notFound();
    const sex = c.req.param("sex"), poseId = c.req.query("poseId");
    if ((sex !== "male" && sex !== "female") || !poseId || poseId.length > 300 ||
        Object.keys(c.req.query()).some(k => !["poseId", "jobId", "candidateId", "personIndex"].includes(k)))
      return c.json(errorEnvelope("INVALID_INPUT", "검토 모델과 선택 포즈를 지정해 주세요.", c.get("requestId")), 400);
    // Reuse the complete authenticated BVH export path: ownership, confirmed
    // selection, manual-review exclusions, quarantine and refined/base choice.
    const url = new URL(c.req.url);
    url.pathname = `/v1/pose-candidates/${encodeURIComponent(poseId)}/export`;
    url.searchParams.delete("poseId"); url.searchParams.set("format", "bvh");
    const response = await internalFetch(new Request(url, { headers: c.req.raw.headers }));
    if (!response.ok) return response;
    const bvh = new Uint8Array(await response.arrayBuffer());
    if (bvh.length > 8 * 1024 * 1024 || !new TextDecoder().decode(bvh.subarray(0, 100)).trimStart().startsWith("HIERARCHY"))
      return c.json(errorEnvelope("CSP_REVIEW_INTEGRITY", "포즈 파일 검증에 실패했습니다.", c.get("requestId")), 502);
    try {
      const asset = await load(sex);
      const manifest = { schema: "standin-csp-review-bundle.v1", releaseId: asset.release.releaseId,
        body: { sex, version: asset.model.version, application: "explicit-review-base-body", slidersApplied: false },
        selection: { poseId, jobId: c.req.query("jobId"), candidateId: c.req.query("candidateId"), personIndex: Number(c.req.query("personIndex")) },
        artifacts: { "model.vrm": { bytes: asset.bytes.length, sha256: asset.model.sha256 },
          "pose.bvh": { bytes: bvh.length, sha256: sha256Hex(bvh) } },
        CSP: { angleLimit: "enable in CSP", lockRegions: ["chest", "abdomen", "pelvis"], locksEmbedded: false, poseImportVerified: false },
        unsupported: ["body-sliders", "hand-selection", "camera", "multi-person-scene"], productionApproved: false };
      const encode = (s: string) => new TextEncoder().encode(s);
      const zip = storedZip([{ name: "model.vrm", bytes: asset.bytes }, { name: "pose.bvh", bytes: bvh },
        { name: "manifest.json", bytes: encode(JSON.stringify(manifest, null, 2) + "\n") },
        { name: "README.txt", bytes: encode(instructions) }]);
      return new Response(zip, { headers: { "Content-Type": "application/zip", "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="standin-csp-${sex}-review.zip"`,
        "X-Standin-Artifact-SHA256": sha256Hex(zip), "X-Standin-CSP-Review-Release": asset.release.releaseId,
        "Content-Length": String(zip.length) } });
    } catch {
      return c.json(errorEnvelope("CSP_REVIEW_UNAVAILABLE", "검토용 모델을 지금은 받을 수 없습니다.", c.get("requestId")), 503);
    }
  });
  return routes;
}
