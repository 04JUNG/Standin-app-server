// JWT 발급·검증 + refresh 회전. 유효 refresh는 jti를 SQLite에 화이트리스트로 저장.
// 회전 시 이전 jti를 삭제 → 재사용 즉시 무효(클라 ADR-002 single-flight와 맞물림).
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import { db } from "../db.js";

const secret = new TextEncoder().encode(config.jwtSecret);

const insertJti = db.prepare("INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)");
const hasJti = db.prepare("SELECT 1 FROM refresh_tokens WHERE jti = ?");
const deleteJti = db.prepare("DELETE FROM refresh_tokens WHERE jti = ?");

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
  const exp = nowSec() + config.refreshTokenTtl;
  const token = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret);
  insertJti.run(jti, userId, exp);
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

// refresh 회전: JWT 검증(만료 포함) → 화이트리스트 확인 → 이전 jti 삭제 → 새 쌍 발급.
export async function rotateRefresh(token: string): Promise<TokenPair> {
  const { payload } = await jwtVerify(token, secret);
  const jti = payload.jti;
  if (payload.typ !== "refresh" || typeof payload.sub !== "string" || typeof jti !== "string") {
    throw new Error("not a refresh token");
  }
  if (!hasJti.get(jti)) throw new Error("refresh revoked or already rotated");
  deleteJti.run(jti);
  return issueTokens(payload.sub);
}

// 로그아웃: refresh 폐기.
export async function revokeRefresh(token: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.jti === "string") deleteJti.run(payload.jti);
  } catch {
    // 이미 만료/위조 → 무시
  }
}
