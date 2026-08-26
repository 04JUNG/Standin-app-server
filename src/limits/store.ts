// 사용량 카운터 저장소(PostgreSQL).
//
// ⚠ 인메모리 카운터를 쓰지 않는 이유: ECS는 태스크를 여러 개 띄우고 배포마다 교체한다.
//    프로세스 메모리에 세면 태스크 수만큼 한도가 늘어나고 배포할 때마다 초기화된다.
import type { Pool, PoolClient } from "pg";
import { pool } from "../db.js";
import type { UsageWindow } from "./policy.js";

export type UsageScope =
  | "installation_week"
  | "global_day"
  | "ip_register"
  | "ip_analyze";

/** pool 또는 트랜잭션 client. Job 생성처럼 다른 쓰기와 묶어야 할 때 client를 넘긴다. */
type Executor = Pool | PoolClient;

/** 창이 끝난 뒤에도 잠시 남겨 뒀다가 청소한다(경계 시각 오차·시계 차이 흡수). */
const RETENTION_GRACE_SECONDS = 3600;

/**
 * 카운터를 1 올리면서 한도를 넘는지 **한 문장으로** 판정한다.
 *
 * 읽고 나서 쓰면 태스크 두 개가 동시에 같은 값을 읽어 한도를 넘긴다.
 * ON CONFLICT ... DO UPDATE ... WHERE 는 한도 미만일 때만 갱신하고,
 * 갱신되지 않으면 RETURNING이 아무 행도 주지 않는다 → 그게 곧 "초과"다.
 *
 * @returns 소비에 성공하면 true, 한도 초과면 false
 */
export async function tryConsume(
  scope: UsageScope,
  subject: string,
  window: UsageWindow,
  limit: number,
  executor: Executor = pool,
): Promise<boolean> {
  const expiresAt = Math.floor(window.resetAtMs / 1000) + RETENTION_GRACE_SECONDS;
  const res = await executor.query(
    `INSERT INTO usage_counters (scope, subject, window_start, count, expires_at)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (scope, subject, window_start)
     DO UPDATE SET count = usage_counters.count + 1
       WHERE usage_counters.count < $5
     RETURNING count`,
    [scope, subject, window.key, expiresAt, limit],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 소비를 되돌린다. 트랜잭션 커밋 뒤에 요청이 실패한 경우(예: 입력 저장 실패)에만 쓴다.
 * 트랜잭션 안에서 실패하면 롤백이 알아서 처리하므로 부를 필요가 없다.
 */
export async function refund(
  scope: UsageScope,
  subject: string,
  window: UsageWindow,
  executor: Executor = pool,
): Promise<void> {
  await executor.query(
    `UPDATE usage_counters SET count = GREATEST(count - 1, 0)
     WHERE scope = $1 AND subject = $2 AND window_start = $3`,
    [scope, subject, window.key],
  );
}

/** 현재 창의 사용량(관리자 조회용). 없으면 0. */
export async function currentUsage(
  scope: UsageScope,
  subject: string,
  window: UsageWindow,
  executor: Executor = pool,
): Promise<number> {
  const res = await executor.query(
    "SELECT count FROM usage_counters WHERE scope = $1 AND subject = $2 AND window_start = $3",
    [scope, subject, window.key],
  );
  return (res.rows[0] as { count: number } | undefined)?.count ?? 0;
}
