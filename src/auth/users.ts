// 유저 저장소(SQLite) + 비밀번호 해시(argon2).
// ⚠ 추론 라이브러리 poses.db와 분리된 BFF 전용 DB(PII).
import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { db, isUniqueViolation } from "../db.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
}

function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, passwordHash: r.password_hash, displayName: r.display_name };
}

export function publicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, displayName: u.displayName };
}

export class EmailTakenError extends Error {}

const insert = db.prepare(
  "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
);
const selByEmail = db.prepare(
  "SELECT id, email, password_hash, display_name FROM users WHERE lower(email) = lower(?)",
);
const selById = db.prepare(
  "SELECT id, email, password_hash, display_name FROM users WHERE id = ?",
);

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
  };
  try {
    insert.run(user.id, user.email, user.passwordHash, user.displayName, new Date().toISOString());
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

export function verifyPassword(user: User, password: string): Promise<boolean> {
  return verify(user.passwordHash, password);
}
