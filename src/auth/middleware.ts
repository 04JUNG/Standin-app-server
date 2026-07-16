// JWT access 토큰 검증 미들웨어. 유효하면 userId를 컨텍스트에 주입한다.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { verifyAccess } from "./tokens.js";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return c.json(errorEnvelope("UNAUTHENTICATED", "토큰이 필요합니다.", c.get("requestId")), 401);
  }
  try {
    const userId = await verifyAccess(token);
    c.set("userId", userId);
    await next();
    return;
  } catch {
    return c.json(errorEnvelope("INVALID_TOKEN", "토큰이 유효하지 않습니다.", c.get("requestId")), 401);
  }
};
