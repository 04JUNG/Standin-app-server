// /v1/pose-candidates — 선택 후보의 BVH를 도원 서버에서 프록시.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getPoseBvh, getPoseThumbnail } from "../inference.js";
import { errorEnvelope } from "../mapping.js";

export const poseRoutes = new Hono<AppEnv>();

// GET /v1/pose-candidates/:id/export — 도원 GET /pose/{id}/bvh 프록시(BVH 스트림)
// TODO(Phase 1): requireAuth 적용
poseRoutes.get("/:id/export", async (c) => {
  const poseId = c.req.param("id");
  const upstream = await getPoseBvh(poseId);
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
