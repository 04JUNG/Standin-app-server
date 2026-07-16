// JWT 발급·검증 + refresh 회전.
// access(짧게) + refresh(길게, 회전). refresh는 jti를 서버가 기억해 회전 시 이전 것을 무효화.
// ⚠ Phase 1: 유효 refresh jti를 인메모리로 관리(재시작 시 전부 무효). DB/Redis로 교체 예정.
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

const secret = new TextEncoder().encode(config.jwtSecret);

// jti -> userId (살아있는 refresh 토큰만)
const validRefreshJtis = new Map<string, string>();

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string; // ISO 8601
  refreshToken: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function signAccess(userId: string): Promise<{ token: string; exp: number }> {
  const exp = nowSec() + config.accessTokenTtl;
  const token = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret);
  return { token, exp };
}

async function signRefresh(userId: string): Promise<string> {
  const jti = randomUUID();
  const token = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(nowSec() + config.refreshTokenTtl)
    .sign(secret);
  validRefreshJtis.set(jti, userId);
  return token;
}

export async function issueTokens(userId: string): Promise<TokenPair> {
  const access = await signAccess(userId);
  const refreshToken = await signRefresh(userId);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: new Date(access.exp * 1000).toISOString(),
    refreshToken,
  };
}

export async function verifyAccess(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  if (payload.typ !== "access" || typeof payload.sub !== "string") {
    throw new Error("not an access token");
  }
  return payload.sub;
}

// refresh 회전: 검증 → 이전 jti 무효화 → 새 쌍 발급(클라 ADR-002 single-flight 대응).
export async function rotateRefresh(token: string): Promise<TokenPair> {
  const { payload } = await jwtVerify(token, secret);
  const jti = payload.jti;
  if (payload.typ !== "refresh" || typeof payload.sub !== "string" || typeof jti !== "string") {
    throw new Error("not a refresh token");
  }
  if (!validRefreshJtis.has(jti)) throw new Error("refresh revoked or already rotated");
  validRefreshJtis.delete(jti);
  return issueTokens(payload.sub);
}

// 로그아웃: refresh 폐기.
export async function revokeRefresh(token: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.jti === "string") validRefreshJtis.delete(payload.jti);
  } catch {
    // 이미 만료/위조 → 무시
  }
}
