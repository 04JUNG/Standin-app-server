// JWT 발급·검증 + refresh 회전. 유효 refresh는 jti를 DB에 화이트리스트로 저장.
// 회전 시 이전 jti를 삭제 → 재사용 즉시 무효(클라 ADR-002 single-flight와 맞물림).
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import { execute } from "../db.js";

const secret = new TextEncoder().encode(config.jwtSecret);

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
  await execute("INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)", [
    jti,
    userId,
    exp,
  ]);
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

// 이메일 인증용 토큰(stateless). 인증 링크에 담아 발송 → 클릭 시 검증.
export async function signEmailVerifyToken(userId: string): Promise<string> {
  return new SignJWT({ typ: "email_verify" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(nowSec() + config.emailVerifyTtl)
    .sign(secret);
}

export async function verifyEmailVerifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  if (payload.typ !== "email_verify" || typeof payload.sub !== "string") {
    throw new Error("not an email-verify token");
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
  // 확인과 삭제를 한 문장으로 처리한다. 태스크가 여러 개면 "조회 → 삭제" 사이에
  // 다른 요청이 끼어들어 같은 refresh가 두 번 통과할 수 있다(SQLite 단일 프로세스에서는
  // 직렬화돼 드러나지 않던 경합). 삭제된 행이 0이면 이미 쓰인 토큰이다.
  const deleted = await execute("DELETE FROM refresh_tokens WHERE jti = $1", [jti]);
  if (deleted === 0) throw new Error("refresh revoked or already rotated");
  return issueTokens(payload.sub);
}

// 로그아웃: refresh 폐기.
export async function revokeRefresh(token: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.jti === "string") {
      await execute("DELETE FROM refresh_tokens WHERE jti = $1", [payload.jti]);
    }
  } catch {
    // 이미 만료/위조 → 무시
  }
}
