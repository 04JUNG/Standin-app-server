// IP 기반 burst 제한 미들웨어.
//
// 일일 쿼터(설치 단위)와 별개다 — 등록 폭주·재시도 루프처럼 짧은 시간에 몰리는
// 트래픽을 막는 게 목적이라 창이 훨씬 짧다.
import type { MiddlewareHandler } from "hono";
import { clientIp, ipBucketKey } from "../clientIp.js";
import type { AppEnv } from "../env.js";
import { limitErrorResponse } from "./http.js";
import { LimitExceededError, fixedWindow, isDisabled, secondsUntil } from "./policy.js";
import { tryConsume, type UsageScope } from "./store.js";

export function rateLimitByIp(
  scope: Extract<UsageScope, "ip_register" | "ip_analyze">,
  limit: number,
  windowSeconds: number,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isDisabled(limit)) return next();
    const nowMs = Date.now();
    const window = fixedWindow(nowMs, windowSeconds);
    const ok = await tryConsume(scope, ipBucketKey(clientIp(c)), window, limit);
    if (!ok) {
      return limitErrorResponse(
        c,
        new LimitExceededError("RATE_LIMITED", secondsUntil(window.resetAtMs, nowMs), {
          limit,
          windowSeconds,
        }),
      );
    }
    return next();
  };
}
