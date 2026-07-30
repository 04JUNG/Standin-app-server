// 유저 저장소(PostgreSQL) + 비밀번호 해시(argon2). local + 소셜(google/kakao/naver).
// ⚠ 추론 라이브러리 poses.db와 분리된 BFF 전용 DB(PII).
import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { execute, isUniqueViolation, queryOne } from "../db.js";

export type Provider = "local" | "google" | "kakao" | "naver";

export interface User {
  id: string;
  email: string;
  passwordHash: string | null; // 소셜 계정은 null
  displayName: string;
  provider: Provider;
  providerId: string | null;
  emailVerified: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  provider: Provider;
  emailVerified: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  provider: string;
  provider_id: string | null;
  email_verified: boolean;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    displayName: r.display_name,
    provider: r.provider as Provider,
    providerId: r.provider_id,
    emailVerified: r.email_verified,
  };
}

export function publicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    provider: u.provider,
    emailVerified: u.emailVerified,
  };
}

export class EmailTakenError extends Error {}

const COLS = "id, email, password_hash, display_name, provider, provider_id, email_verified";

const INSERT = `
  INSERT INTO users (id, email, password_hash, display_name, created_at, provider, provider_id, email_verified)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/** 신규 유저 저장. 이메일·provider 중복은 EmailTakenError로 바꾼다. */
async function insertUser(user: User): Promise<void> {
  try {
    await execute(INSERT, [
      user.id,
      user.email,
      user.passwordHash,
      user.displayName,
      new Date().toISOString(),
      user.provider,
      user.providerId,
      user.emailVerified,
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new EmailTakenError(user.email);
    throw e;
  }
}

// local 회원가입(이메일 미인증 상태로 생성)
export async function createUser(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const user: User = {
    id: `user_${randomUUID()}`,
    email,
    passwordHash: await hash(password),
    displayName,
    provider: "local",
    providerId: null,
    emailVerified: false,
  };
  await insertUser(user);
  return user;
}

// 소셜 로그인 신규 유저(provider가 이메일을 검증했으므로 email_verified=true)
export async function createOAuthUser(
  provider: Exclude<Provider, "local">,
  providerId: string,
  email: string,
  displayName: string,
): Promise<User> {
  const user: User = {
    id: `user_${randomUUID()}`,
    email,
    passwordHash: null,
    displayName,
    provider,
    providerId,
    emailVerified: true,
  };
  await insertUser(user);
  return user;
}

export async function findByEmail(email: string): Promise<User | undefined> {
  const row = await queryOne<UserRow>(`SELECT ${COLS} FROM users WHERE lower(email) = lower($1)`, [
    email,
  ]);
  return row ? toUser(row) : undefined;
}

export async function findById(id: string): Promise<User | undefined> {
  const row = await queryOne<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return row ? toUser(row) : undefined;
}

export async function findByProvider(
  provider: Provider,
  providerId: string,
): Promise<User | undefined> {
  const row = await queryOne<UserRow>(
    `SELECT ${COLS} FROM users WHERE provider = $1 AND provider_id = $2`,
    [provider, providerId],
  );
  return row ? toUser(row) : undefined;
}

export async function setEmailVerified(userId: string): Promise<void> {
  await execute("UPDATE users SET email_verified = TRUE WHERE id = $1", [userId]);
}

export function verifyPassword(user: User, password: string): Promise<boolean> {
  if (!user.passwordHash) return Promise.resolve(false); // 소셜 계정엔 비번 없음
  return verify(user.passwordHash, password);
}
