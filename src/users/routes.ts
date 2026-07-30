// /v1/users — 현재 유저. requireAuth는 index.ts에서 경로에 적용된다.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { findById, publicUser } from "../auth/users.js";

export const usersRoutes = new Hono<AppEnv>();

// GET /v1/users/me — 세션 복원용
usersRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json(errorEnvelope("UNAUTHENTICATED", "인증이 필요합니다.", c.get("requestId")), 401);
  }
  const user = await findById(userId);
  if (!user) {
    return c.json(errorEnvelope("NOT_FOUND", "유저를 찾을 수 없습니다.", c.get("requestId")), 404);
  }
  return c.json(publicUser(user));
});
