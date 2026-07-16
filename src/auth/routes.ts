// /v1/auth — 인증. 전부 TODO(Phase 1) stub.
//   POST /login   : 이메일·비번 검증(argon2 해시) → access(JWT) + refresh 발급
//   POST /refresh : refresh 회전(이전 무효화 — 클라 ADR-002 single-flight와 맞물림)
//   POST /logout  : refresh 폐기
//   GET  /users/me: 현재 유저 (index.ts에서 /v1/users/me로 별도 마운트 예정)
// 유저 저장: BFF 전용 DB(추론 poses.db와 분리). ⚠ 비번·토큰을 로그에 남기지 않는다.
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";

export const authRoutes = new Hono<AppEnv>();

const notImplemented = (c: import("hono").Context<AppEnv>) =>
  c.json(errorEnvelope("NOT_IMPLEMENTED", "auth는 Phase 1에서 구현", c.get("requestId")), 501);

authRoutes.post("/login", notImplemented);
authRoutes.post("/refresh", notImplemented);
authRoutes.post("/logout", notImplemented);
