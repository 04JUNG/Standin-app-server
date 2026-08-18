// 구조화 로그 단일 소스. 출력 한 줄 = JSON 객체 하나.
//
// 스키마 정본: Standin-master-docs/관측성_로그모니터링_알림_2026-08-18.md §4.
// console.*를 직접 부르지 않는 이유는 두 가지다.
//   1. 뒤에 붙는 집계·알림(3단계)이 이 한 줄을 파싱한다. 형식이 제각각이면 파싱이 안 된다.
//   2. PII 차단을 여기 한 곳에서 강제할 수 있다(CLAUDE.md §2).
import { config } from "./config.js";
import { currentContext } from "./requestContext.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** 이벤트 종류. 집계·알림의 1차 키다. 새 값을 만들면 문서 §4 목록에 추가한다. */
  type: string;
  requestId?: string;
  jobId?: string;
  installationId?: string;
  /** 라우트 **패턴**(`/v1/analysis/jobs/:jobId`). 실제 경로를 넣으면 카디널리티가 터진다. */
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  /** 코드형 값만. 자유 텍스트를 넣지 않는다. */
  errorCode?: string;
  msg?: string;
  [key: string]: unknown;
}

const SERVICE = "bff";

/**
 * 이 패턴에 걸리는 **키 이름**은 값을 지운다.
 *
 * 값을 검사하지 않고 키를 보는 이유: 토큰처럼 생긴 문자열을 정규식으로 잡으려 하면
 * 반드시 새는 경로가 생긴다. 이름으로 막으면 새 필드를 추가할 때 자동으로 걸린다.
 */
const REDACT_KEY = /token|password|passwd|secret|authorization|cookie|apikey|api_key|credential|email/i;
const REDACTED = "[redacted]";
/** 로그 한 줄이 길어지면 수집·검색이 모두 나빠진다. 문자열은 여기서 자른다. */
const MAX_STRING = 512;
const MAX_ARRAY = 20;
const MAX_DEPTH = 3;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "bigint") return value.toString();
  // 함수·심볼·이미지 버퍼 같은 것은 애초에 로그에 들어올 값이 아니다.
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  }
  return sanitizeFields(value as Record<string, unknown>, depth + 1);
}

function sanitizeFields(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (REDACT_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    const sanitized = sanitizeValue(value, depth);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function emit(level: LogLevel, fields: LogFields): void {
  const context = currentContext();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    version: config.deploymentVersion,
    // 컨텍스트 값이 먼저, 명시 필드가 나중 — 호출부가 항상 이긴다.
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...(context?.jobId ? { jobId: context.jobId } : {}),
    ...(context?.installationId ? { installationId: context.installationId } : {}),
    ...sanitizeFields(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (fields: LogFields) => emit("debug", fields),
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
};

/**
 * 예외를 로그 필드로 편다.
 *
 * 스택은 12줄에서 자른다 — 전체 스택은 한 줄 로그를 수 KB로 만들고, 원인 파악에
 * 쓰이는 건 대부분 위쪽 몇 줄이다.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { stack: error.stack.split("\n").slice(0, 12).join("\n") } : {}),
    };
  }
  return { errorName: "NonError", errorMessage: String(error) };
}
