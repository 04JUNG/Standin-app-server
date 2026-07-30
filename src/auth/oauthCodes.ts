// 소셜 로그인 성공 → 클라(데스크톱)로 넘기는 1회용 교환 코드.
//
// 토큰을 딥링크 URL(standin://auth/callback?accessToken=…)에 실으면 OS 로그·최근 실행 기록·
// 다른 앱의 URL 핸들러에 장기 자격증명이 그대로 남는다(클라 docs/06 §6이 금지). 대신 60초짜리
// 1회용 코드만 넘기고, 클라가 POST /v1/auth/oauth/exchange로 토큰을 받아간다.
//
// refresh 토큰과 같은 이유로 원문이 아니라 SHA-256 해시를 저장한다 — DB가 새도 코드 자체는
// 복원되지 않는다.
import { createHash, randomBytes } from "node:crypto";
import { execute, queryOne } from "../db.js";

/** 코드 수명(초). 브라우저 → 딥링크 → 앱 왕복에 필요한 만큼만. */
const CODE_TTL = 60;

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 코드 발급. 원문은 이 반환값이 유일하고 서버에는 해시만 남는다. */
export async function issueOAuthCode(userId: string): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await execute("INSERT INTO oauth_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    hash(code),
    userId,
    nowSec() + CODE_TTL,
  ]);
  return code;
}

/**
 * 코드 소비. 확인과 삭제를 한 문장으로 처리한다 — "조회 → 삭제" 사이에 같은 코드가 두 번
 * 통과할 수 있다(tokens.ts의 refresh 회전과 같은 경합). 반환 행이 없으면 이미 쓰였거나 만료됐다.
 */
export async function consumeOAuthCode(code: string): Promise<string> {
  const row = await queryOne<{ user_id: string }>(
    "DELETE FROM oauth_codes WHERE code_hash = $1 AND expires_at > $2 RETURNING user_id",
    [hash(code), nowSec()],
  );
  if (!row) throw new Error("oauth code invalid, expired, or already used");
  return row.user_id;
}
