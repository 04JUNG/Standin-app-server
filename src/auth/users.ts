// 유저 저장소(SQLite) + 비밀번호 해시(argon2). local + 소셜(google/kakao/naver).
// ⚠ 추론 라이브러리 poses.db와 분리된 BFF 전용 DB(PII).
import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { db, isUniqueViolation } from "../db.js";

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
  email_verified: number;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    displayName: r.display_name,
    provider: r.provider as Provider,
    providerId: r.provider_id,
    emailVerified: r.email_verified === 1,
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
const insert = db.prepare(
  `INSERT INTO users (id, email, password_hash, display_name, created_at, provider, provider_id, email_verified)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selByEmail = db.prepare(`SELECT ${COLS} FROM users WHERE lower(email) = lower(?)`);
const selById = db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`);
const selByProvider = db.prepare(`SELECT ${COLS} FROM users WHERE provider = ? AND provider_id = ?`);
const updVerified = db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?");

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
  try {
    insert.run(user.id, user.email, user.passwordHash, user.displayName, new Date().toISOString(), "local", null, 0);
  } catch (e) {
    if (isUniqueViolation(e)) throw new EmailTakenError(email);
    throw e;
  }
  return user;
}

// 소셜 로그인 신규 유저(provider가 이메일을 검증했으므로 email_verified=1)
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
  try {
    insert.run(user.id, user.email, null, user.displayName, new Date().toISOString(), provider, providerId, 1);
  } catch (e) {
    if (isUniqueViolation(e)) throw new EmailTakenError(email);
    throw e;
  }
  return user;
}

export function findByEmail(email: string): User | undefined {
  const row = selByEmail.get(email) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function findById(id: string): User | undefined {
  const row = selById.get(id) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function findByProvider(provider: Provider, providerId: string): User | undefined {
  const row = selByProvider.get(provider, providerId) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function setEmailVerified(userId: string): void {
  updVerified.run(userId);
}

export function verifyPassword(user: User, password: string): Promise<boolean> {
  if (!user.passwordHash) return Promise.resolve(false); // 소셜 계정엔 비번 없음
  return verify(user.passwordHash, password);
}
