// /v1/pose-candidates — 선택 후보의 BVH를 도원 서버에서 프록시.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getPoseBvh } from "../inference.js";

export const poseRoutes = new Hono<AppEnv>();

// GET /v1/pose-candidates/:id/export — 도원 GET /pose/{id}/bvh 프록시(BVH 스트림)
// TODO(Phase 1): requireAuth 적용
poseRoutes.get("/:id/export", async (c) => {
  const poseId = c.req.param("id");
  const upstream = await getPoseBvh(poseId);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition":
        upstream.headers.get("Content-Disposition") ?? `attachment; filename="${poseId}.bvh"`,
    },
  });
});
