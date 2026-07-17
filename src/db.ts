// BFF 전용 SQLite(유저·refresh·Job). 동기 드라이버(better-sqlite3).
// ⚠ 추론 라이브러리 poses.db와 다른 파일(PII 분리). 경로는 config.dbPath(기본 data/bff.db).
// ⚠ 동기화 폴더(드롭박스/OneDrive)에 두면 락 오류 → 로컬 디스크 경로.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti        TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    result_json TEXT,
    error_code  TEXT,
    rerun_of    TEXT
  );
`);

// 만료된 refresh 토큰 청소(기동 시 1회). 화이트리스트가 무한정 쌓이지 않게.
db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").run(Math.floor(Date.now() / 1000));

// 진위 판별용 SQLite 유니크 제약 위반 코드
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string" &&
    (e as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}
