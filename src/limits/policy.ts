// 사용량 제한의 "언제·얼마나" 계산. 순수 함수만 둔다(DB·요청 컨텍스트를 모른다).
//
// 정본 카운터는 PostgreSQL에 있다(스프린트 2026-08-11 결정). 여기서는 어떤 창(window)에
// 몇 번째 요청인지 판정할 키와, 초과 시 클라에 돌려줄 재시도 시각만 만든다.

/**
 * 일일 쿼터의 리셋 기준은 UTC 자정이 아니라 **KST 자정**이다.
 * 사용자가 한국 시간대라 "오늘 10회"가 체감과 맞아야 한다.
 * Asia/Seoul은 DST가 없으므로 고정 오프셋으로 충분하다(Intl 없이 계산).
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageWindow {
  /** usage_counters.window_start 값. 같은 창이면 같은 문자열이어야 한다. */
  key: string;
  /** 창이 끝나고 카운터가 사실상 리셋되는 시각(ms). */
  resetAtMs: number;
}

/** KST 기준 일자('2026-08-11'). */
export function kstDayKey(nowMs: number): string {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 다음 KST 자정(ms). */
export function nextKstMidnightMs(nowMs: number): number {
  const shifted = nowMs + KST_OFFSET_MS;
  return (Math.floor(shifted / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS;
}

/** 클라가 그대로 보여줄 수 있는 KST 표기('2026-08-12T00:00:00.000+09:00'). */
export function kstIsoString(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** 일일 쿼터 창(KST 하루). */
export function dailyWindow(nowMs: number): UsageWindow {
  return { key: kstDayKey(nowMs), resetAtMs: nextKstMidnightMs(nowMs) };
}

/**
 * burst용 고정 창. windowSeconds 단위로 잘린 구간을 하나의 키로 쓴다.
 * 슬라이딩 창이 아니라 경계에서 최대 2배까지 통과할 수 있지만, DB 한 문장으로
 * 원자 처리되는 단순함이 베타 규모에서는 더 중요하다.
 */
export function fixedWindow(nowMs: number, windowSeconds: number): UsageWindow {
  const windowMs = windowSeconds * 1000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  return { key: String(Math.floor(startMs / 1000)), resetAtMs: startMs + windowMs };
}

/** 0 이하 한도는 "제한 없음"으로 읽는다(전체 일일 상한 기본 off를 이 규칙으로 처리). */
export function isDisabled(limit: number): boolean {
  return !Number.isFinite(limit) || limit <= 0;
}

/** Retry-After 헤더 값. 최소 1초(0을 주면 클라가 즉시 재시도한다). */
export function secondsUntil(targetMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((targetMs - nowMs) / 1000));
}

export type LimitCode =
  | "RATE_LIMITED"
  | "DAILY_QUOTA_EXCEEDED"
  | "CONCURRENCY_LIMIT"
  | "GLOBAL_QUOTA_EXCEEDED";

/** 한도 초과. 라우트가 잡아서 429 + Retry-After로 번역한다. */
export class LimitExceededError extends Error {
  constructor(
    readonly code: LimitCode,
    readonly retryAfterSeconds: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "LimitExceededError";
  }
}

export function isLimitExceeded(e: unknown): e is LimitExceededError {
  return e instanceof LimitExceededError;
}
