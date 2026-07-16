// /v1/auth — 인증(공개 라우트). Phase 1 구현.
//   POST /register : 계정 생성(argon2 해시) → 토큰 발급
//   POST /login    : 이메일·비번 검증 → access(JWT) + refresh 발급
//   POST /refresh  : refresh 회전(이전 무효화 — 클라 ADR-002 single-flight와 맞물림)
//   POST /logout   : refresh 폐기
// ⚠ 비밀번호·토큰을 로그에 남기지 않는다.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import {
  EmailTakenError,
  createUser,
  findByEmail,
  publicUser,
  verifyPassword,
} from "./users.js";
import { issueTokens, revokeRefresh, rotateRefresh } from "./tokens.js";

export const authRoutes = new Hono<AppEnv>();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Creds {
  email: string;
  password: string;
}

function parseCreds(body: unknown): Creds | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b["email"] !== "string" || typeof b["password"] !== "string") return null;
  const email = b["email"].trim();
  if (!EMAIL_RE.test(email) || b["password"].length < 8) return null;
  return { email, password: b["password"] };
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

authRoutes.post("/register", async (c) => {
  const body = await readJson(c);
  const creds = parseCreds(body);
  if (!creds) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "이메일 형식·비밀번호(8자 이상)를 확인하세요.", c.get("requestId")),
      400,
    );
  }
  const displayName =
    body && typeof (body as Record<string, unknown>)["displayName"] === "string"
      ? ((body as Record<string, unknown>)["displayName"] as string)
      : creds.email.split("@")[0]!;
  try {
    const user = await createUser(creds.email, creds.password, displayName);
    const tokens = await issueTokens(user.id);
    return c.json({ user: publicUser(user), ...tokens }, 201);
  } catch (e) {
    if (e instanceof EmailTakenError) {
      return c.json(errorEnvelope("EMAIL_TAKEN", "이미 등록된 이메일입니다.", c.get("requestId")), 409);
    }
    throw e;
  }
});

authRoutes.post("/login", async (c) => {
  const creds = parseCreds(await readJson(c));
  if (!creds) {
    return c.json(errorEnvelope("INVALID_INPUT", "이메일·비밀번호를 확인하세요.", c.get("requestId")), 400);
  }
  const user = findByEmail(creds.email);
  // 유저 없음/비번 불일치를 같은 응답으로(계정 존재 여부 노출 방지)
  if (!user || !(await verifyPassword(user, creds.password))) {
    return c.json(
      errorEnvelope("INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", c.get("requestId")),
      401,
    );
  }
  const tokens = await issueTokens(user.id);
  return c.json({ user: publicUser(user), ...tokens });
});

authRoutes.post("/refresh", async (c) => {
  const body = await readJson(c);
  const token =
    body && typeof (body as Record<string, unknown>)["refreshToken"] === "string"
      ? ((body as Record<string, unknown>)["refreshToken"] as string)
      : "";
  if (!token) {
    return c.json(errorEnvelope("INVALID_INPUT", "refreshToken이 필요합니다.", c.get("requestId")), 400);
  }
  try {
    return c.json(await rotateRefresh(token));
  } catch {
    return c.json(errorEnvelope("INVALID_TOKEN", "refresh 토큰이 유효하지 않습니다.", c.get("requestId")), 401);
  }
});

authRoutes.post("/logout", async (c) => {
  const body = await readJson(c);
  const token =
    body && typeof (body as Record<string, unknown>)["refreshToken"] === "string"
      ? ((body as Record<string, unknown>)["refreshToken"] as string)
      : "";
  if (token) await revokeRefresh(token);
  return c.json({ ok: true });
});
