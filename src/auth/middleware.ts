// JWT 검증 미들웨어. TODO(Phase 1): 실제 유저 조회·권한·userId 주입.
// 현재는 토큰 서명/만료 유효성만 확인한다.
import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";

const secret = new TextEncoder().encode(config.jwtSecret);

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return c.json(errorEnvelope("UNAUTHENTICATED", "토큰이 필요합니다.", c.get("requestId")), 401);
  }
  try {
    await jwtVerify(token, secret);
    // TODO(Phase 1): payload.sub → c.set("userId", ...)
    await next();
    return;
  } catch {
    return c.json(errorEnvelope("INVALID_TOKEN", "토큰이 유효하지 않습니다.", c.get("requestId")), 401);
  }
};
