// 유저 저장소 + 비밀번호 해시.
// ⚠ Phase 1: 인메모리(프로세스 재시작 시 소실). BFF 전용 DB(SQLite/Postgres)로 교체 예정.
//    ⚠ 추론 라이브러리 poses.db와 절대 섞지 않는다(PII).
import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

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

const byEmail = new Map<string, User>();
const byId = new Map<string, User>();

export function publicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, displayName: u.displayName };
}

export class EmailTakenError extends Error {}

export async function createUser(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const key = email.toLowerCase();
  if (byEmail.has(key)) throw new EmailTakenError(email);
  const user: User = {
    id: `user_${randomUUID()}`,
    email,
    passwordHash: await hash(password),
    displayName,
  };
  byEmail.set(key, user);
  byId.set(user.id, user);
  return user;
}

export function findByEmail(email: string): User | undefined {
  return byEmail.get(email.toLowerCase());
}

export function findById(id: string): User | undefined {
  return byId.get(id);
}

export function verifyPassword(user: User, password: string): Promise<boolean> {
  return verify(user.passwordHash, password);
}
