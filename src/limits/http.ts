// 한도 초과를 /v1 오류봉투 + 429로 번역한다(계약 번역은 BFF의 책임).
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import type { LimitCode, LimitExceededError } from "./policy.js";

/**
 * 사용자에게 보일 안내. 클라는 code로 분기하지만(docs/API.md), 문구가 그대로 노출되는
 * 화면이 있을 수 있으니 원인과 다음 행동이 드러나게 쓴다.
 */
const MESSAGES: Record<LimitCode, string> = {
  RATE_LIMITED: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
  WEEKLY_QUOTA_EXCEEDED: "이번 주에 사용할 수 있는 분석 횟수를 모두 사용했습니다.",
  CONCURRENCY_LIMIT: "이미 진행 중인 분석이 있습니다. 완료된 뒤에 다시 시도해 주세요.",
  GLOBAL_QUOTA_EXCEEDED: "오늘 베타 전체 분석 한도에 도달했습니다. 내일 다시 시도해 주세요.",
};

export function limitErrorResponse(c: Context<AppEnv>, error: LimitExceededError) {
  return c.json(
    errorEnvelope(error.code, MESSAGES[error.code], c.get("requestId"), {
      retryAfterSeconds: error.retryAfterSeconds,
      ...error.details,
    }),
    429,
    { "Retry-After": String(error.retryAfterSeconds) },
  );
}
