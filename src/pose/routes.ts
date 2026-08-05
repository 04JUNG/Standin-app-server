// /v1/pose-candidates — 선택 후보의 BVH를 도원 서버에서 프록시.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getPoseBvh, getPoseThumbnail } from "../inference.js";
import { errorEnvelope } from "../mapping.js";
import { recordExport, validateExportCandidate } from "../analytics/store.js";
import { resolveExportArtifact } from "../refine/service.js";

export const poseRoutes = new Hono<AppEnv>();

// GET /v1/pose-candidates/:id/export — 도원 GET /pose/{id}/bvh 프록시(BVH 스트림)
// TODO(Phase 1): requireAuth 적용
poseRoutes.get("/:id/export", async (c) => {
  const poseId = c.req.param("id");
  const candidateId = c.req.query("candidateId") ?? "";
  const jobId = c.req.query("jobId") ?? "";
  const personIndex = Number(c.req.query("personIndex"));
  const installationId = c.get("installationId")!;
  if (
    !jobId ||
    !Number.isInteger(personIndex) ||
    personIndex < 0 ||
    !candidateId ||
    !(await validateExportCandidate(installationId, jobId, personIndex, candidateId))
  ) {
    return c.json(
      errorEnvelope("INVALID_EXPORT", "작업에서 선택된 후보가 아닙니다.", c.get("requestId")),
      409,
    );
  }
  await recordExport({
    installationId,
    jobId,
    personIndex,
    candidateId,
    status: "requested",
  });

  // 이 URL은 조정본과 베이스 중 무엇이 최종인지를 서버가 정한다(BFF-06). 클라이언트는
  // 추론 서버의 로컬 handle을 알 필요가 없고, 알아서도 안 된다.
  const artifact = await resolveExportArtifact(jobId, personIndex, candidateId);
  if (artifact.variant === "refined") {
    await recordExport({
      installationId,
      jobId,
      personIndex,
      candidateId,
      status: "completed",
      variant: "refined",
    });
    return new Response(artifact.bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${poseId}.bvh"`,
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await getPoseBvh(poseId);
  } catch {
    await recordExport({
      installationId,
      jobId,
      personIndex,
      candidateId,
      status: "failed",
      errorCode: "INFERENCE_UNAVAILABLE",
      variant: "base",
      fallbackReason: artifact.fallbackReason ?? undefined,
    });
    throw new Error("pose export upstream unavailable");
  }
  await recordExport({
    installationId,
    jobId,
    personIndex,
    candidateId,
    status: upstream.ok ? "completed" : "failed",
    errorCode: upstream.ok ? undefined : `HTTP_${upstream.status}`,
    variant: "base",
    fallbackReason: artifact.fallbackReason ?? undefined,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition":
        upstream.headers.get("Content-Disposition") ??
        `attachment; filename="${poseId}.bvh"`,
    },
  });
});

// GET /v1/pose-candidates/:id/thumbnail?view=front — 인증된 PNG 프록시
poseRoutes.get("/:id/thumbnail", async (c) => {
  const view = c.req.query("view");
  if (!view) {
    return c.json(
      errorEnvelope(
        "INVALID_INPUT",
        "view 쿼리 파라미터가 필요합니다.",
        c.get("requestId"),
      ),
      400,
    );
  }

  const upstream = await getPoseThumbnail(c.req.param("id"), view);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control":
        upstream.headers.get("Cache-Control") ?? "private, max-age=86400",
    },
  });
});
