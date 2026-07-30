// BFF 전용 PostgreSQL(유저·refresh·Job).
// ⚠ 추론 라이브러리 poses.db와 다른 저장소(PII 분리).
//
// SQLite에서 옮겨온 이유: 컨테이너(ECS Fargate)의 디스크는 태스크가 교체되면 사라진다.
// 파일 DB를 두면 배포할 때마다 가입한 사용자가 통째로 없어진다.
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  // undefined면 pg가 표준 PG* 환경변수를 읽는다(config.usePgEnvVars 주석 참고).
  connectionString: config.usePgEnvVars ? undefined : config.databaseUrl,
  // RDS는 TLS를 요구하지만 사설 CA라 체인 검증은 끈다. 로컬(compose)은 TLS 자체가 없다.
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: config.databasePoolMax,
});

/** 파라미터화 쿼리. 값은 항상 $1, $2로 넘기고 문자열 연결을 하지 않는다. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** 단일 행 조회. 없으면 undefined. */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** 결과를 쓰지 않는 실행. 영향받은 행 수를 돌려준다. */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(text, params);
  return res.rowCount ?? 0;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    password_hash  TEXT,                                 -- 소셜 계정은 NULL
    display_name   TEXT NOT NULL,
    created_at     TEXT NOT NULL,                        -- ISO 8601 문자열(기존 동작 유지)
    provider       TEXT NOT NULL DEFAULT 'local',        -- local | google | kakao | naver
    provider_id    TEXT,                                 -- provider의 유저 id(소셜만)
    email_verified BOOLEAN NOT NULL DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti        TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at BIGINT NOT NULL                           -- unix seconds
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

  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
  CREATE UNIQUE INDEX IF NOT EXISTS users_provider ON users (provider, provider_id)
    WHERE provider_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at ON refresh_tokens (expires_at);
  CREATE INDEX IF NOT EXISTS jobs_user_id ON jobs (user_id);
`;

// 이 앱 전용 advisory lock 키. 다른 서비스와 겹치지 않게 고정값 하나를 쓴다.
const INIT_LOCK_KEY = 0x5354_4e44; // "STND"

/**
 * 스키마 준비 + 만료 토큰 청소. 기동 시 1회.
 *
 * ECS는 태스크를 여러 개 동시에 띄우므로 CREATE ... IF NOT EXISTS가 서로 부딪힐 수 있다
 * (Postgres에서 동시 실행하면 duplicate 오류가 난다). advisory lock으로 한 번에 하나만
 * 통과시킨다. 락은 세션 단위라 같은 커넥션에서 잡고 푼다.
 */
export async function initDb(): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [INIT_LOCK_KEY]);
    try {
      await client.query(SCHEMA);
      await client.query("DELETE FROM refresh_tokens WHERE expires_at < $1", [
        Math.floor(Date.now() / 1000),
      ]);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [INIT_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Postgres 유니크 제약 위반(23505) 판별. */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "23505"
  );
}

/** 종료 시 커넥션 정리(SIGTERM 등). */
export async function closeDb(): Promise<void> {
  await pool.end();
}
