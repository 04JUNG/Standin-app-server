// 장애 알림(디스코드 웹훅). 설계 정본:
// Standin-master-docs/관측성_로그모니터링_알림_2026-08-18.md §5.
//
// 이 모듈의 값어치는 "무엇을 보내는가"가 아니라 **"어떻게 안 보내는가"**에 있다.
// 디스코드 웹훅에는 자체 레이트리밋이 있어서, 장애 때 초당 수백 건의 에러를 그대로
// 쏘면 레이트리밋에 걸려 알림이 통째로 유실된다. 그래서 세 겹으로 줄인다.
//   1. 배치      — 배치 창(기본 10초) 안의 이벤트를 한 메시지로 묶는다.
//   2. 중복 억제 — 같은 키는 억제 창(기본 5분) 동안 첫 건만 보내고 나머지는 세기만 한다.
//   3. 상한      — 한 메시지의 임베드를 5개로 자르고 나머지는 "외 N종"으로 요약한다.
//
// 2번 결정표는 시간에만 의존하므로 `AlertBuffer`로 떼어 냈다 — 네트워크도 타이머도
// 없이 검증할 수 있어야 실제로 검증된다(refine/service.ts의 deps 주입과 같은 이유).
//
// ⚠ 알림 실패가 앱을 죽이면 안 된다. 전송 오류는 전부 삼키고 로그만 남긴다.
//   그 로그는 절대 notify()를 다시 부르지 않는다(무한 재귀).
import { config } from "./config.js";
import { log } from "./log.js";
import { currentContext } from "./requestContext.js";

/**
 * P1 — 사람을 깨운다. 서비스가 죽었거나 잘못된 결과를 서빙 중이다.
 * P2 — 업무시간에 본다. 일부 요청이 실패하거나 품질이 떨어진다.
 * P3 — 기록. 기동·배포·일일 요약.
 */
export type Severity = "P1" | "P2" | "P3";

export interface Alert {
  severity: Severity;
  /** 코드형 식별자(`INFERENCE_DOWN`). 중복 억제 키의 기본값이 된다. */
  code: string;
  /** 사람이 읽는 한 줄. */
  message: string;
  /** 같은 원인을 접을 키. 라우트별로 나누고 싶을 때 지정한다. 기본값 = `severity:code`. */
  key?: string;
  /** 임베드에 붙일 부가 정보. 로그와 같은 PII 규칙이 적용된다. */
  context?: Record<string, unknown>;
}

export interface PendingAlert extends Alert {
  /** 억제 창에서 삼킨 횟수를 포함한 총 발생 건수. */
  count: number;
  firstAt: number;
  lastAt: number;
  requestId?: string;
}

export function alertKey(alert: Alert): string {
  return alert.key ?? `${alert.severity}:${alert.code}`;
}

/**
 * 배치 + 중복 억제 결정표. 시간을 인자로 받으므로 타이머 없이 검증할 수 있다.
 *
 * 상태 전이는 셋뿐이다.
 *   대기 중인 같은 키가 있다 → 카운트만 올린다(같은 배치로 합쳐진다).
 *   억제 창 안이다          → 보내지 않고 따로 센다.
 *   그 외                   → 대기열에 넣는다. 이때 억제 창에서 센 값을 함께 싣는다.
 */
export class AlertBuffer {
  private readonly pending = new Map<string, PendingAlert>();
  /** key → 억제 해제 시각. */
  private readonly suppressedUntil = new Map<string, number>();
  /** 억제 창 동안 삼킨 횟수. 창이 끝나고 처음 재발할 때 "×N"으로 함께 보고한다. */
  private readonly suppressedCounts = new Map<string, number>();

  constructor(private readonly suppressMs: number) {}

  /** 큐에 넣는다. 새로 대기열에 들어갔으면 true(호출측이 flush를 예약한다). */
  add(alert: Alert, now: number, requestId?: string): boolean {
    const key = alertKey(alert);

    const existing = this.pending.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
      return false;
    }

    const until = this.suppressedUntil.get(key);
    if (until !== undefined && now < until) {
      this.suppressedCounts.set(key, (this.suppressedCounts.get(key) ?? 0) + 1);
      return false;
    }

    const carried = this.suppressedCounts.get(key) ?? 0;
    this.suppressedCounts.delete(key);
    this.suppressedUntil.delete(key);
    this.pending.set(key, { ...alert, count: 1 + carried, firstAt: now, lastAt: now, requestId });
    return true;
  }

  /** 대기열을 비우고 각 키의 억제 창을 건다. */
  drain(now: number): PendingAlert[] {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.suppressedUntil.set(alertKey(entry), now + this.suppressMs);
    }
    return entries;
  }

  get size(): number {
    return this.pending.size;
  }
}

const COLORS: Record<Severity, number> = {
  P1: 0xe0_31_31,
  P2: 0xf0_8c_00,
  P3: 0x86_8e_96,
};

const ICONS: Record<Severity, string> = { P1: "🔴", P2: "🟠", P3: "⚪" };

/** 디스코드 임베드 필드 값 상한은 1024자다. 여유를 두고 자른다. */
const MAX_FIELD_VALUE = 900;
const SEND_TIMEOUT_MS = 5_000;
const SERVICE_LABEL = `standin/bff · ${process.env.NODE_ENV ?? "development"}`;

const buffer = new AlertBuffer(config.alertSuppressSeconds * 1000);
let flushTimer: NodeJS.Timeout | null = null;

function webhookFor(severity: Severity): string {
  const { webhookAlert, webhookWarn, webhookOps } = config.discord;
  // 채널을 하나만 만든 팀도 그대로 동작해야 한다 — 없으면 다른 채널로 흘린다.
  if (severity === "P1") return webhookAlert || webhookWarn || webhookOps;
  if (severity === "P2") return webhookWarn || webhookAlert || webhookOps;
  return webhookOps || webhookWarn || webhookAlert;
}

/**
 * 알림을 큐에 넣는다. 절대 throw하지 않고 await할 필요도 없다.
 *
 * 웹훅이 설정되지 않은 환경(로컬)에서는 큐에 넣되 전송하지 않는다. 같은 사건이 이미
 * 로그에 남아 있으므로 개발 중에 놓치는 정보가 없다.
 */
export function notify(alert: Alert): void {
  if (buffer.add(alert, Date.now(), currentContext()?.requestId)) scheduleFlush();
}

/** 큐에 넣고 즉시 보낸다. 곧 프로세스가 종료되는 경로에서만 쓴다. */
export async function notifyNow(alert: Alert): Promise<void> {
  notify(alert);
  await flush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, config.alertFlushMs);
  // 알림 타이머가 프로세스 종료를 붙잡지 않게 한다. 종료 직전에는 flush()를 직접 부른다.
  flushTimer.unref();
}

/** 큐를 즉시 비운다. 종료 직전·기동 실패처럼 다음 배치를 기다릴 수 없을 때 쓴다. */
export async function flush(): Promise<void> {
  const entries = buffer.drain(Date.now());
  if (entries.length === 0) return;
  // 등급별로 채널이 다르므로 등급별로 묶어 보낸다.
  for (const severity of ["P1", "P2", "P3"] as const) {
    const group = entries.filter((entry) => entry.severity === severity);
    if (group.length > 0) await send(severity, group);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describe(entry: PendingAlert): string {
  const lines: string[] = [truncate(entry.message, MAX_FIELD_VALUE)];
  if (entry.count > 1) lines.push(`발생 ${entry.count}건`);
  if (entry.requestId) lines.push(`requestId: ${entry.requestId}`);
  for (const [key, value] of Object.entries(entry.context ?? {})) {
    lines.push(`${key}: ${truncate(String(value), 200)}`);
  }
  return truncate(lines.join("\n"), MAX_FIELD_VALUE);
}

async function send(severity: Severity, entries: PendingAlert[]): Promise<void> {
  const webhook = webhookFor(severity);
  if (!webhook) return; // 미설정(로컬) — 로그에는 이미 같은 사건이 남아 있다.

  const shown = entries.slice(0, config.alertMaxPerFlush);
  const hidden = entries.slice(shown.length);
  const footer = { text: `${SERVICE_LABEL} · ${config.deploymentVersion}` };

  const embeds = shown.map((entry) => ({
    title: truncate(`${ICONS[severity]} ${severity} · ${entry.code}`, 256),
    description: describe(entry),
    color: COLORS[severity],
    timestamp: new Date(entry.lastAt).toISOString(),
    footer,
  }));
  if (hidden.length > 0) {
    embeds.push({
      title: `… 외 ${hidden.length}종`,
      description: truncate(hidden.map((entry) => entry.code).join(", "), MAX_FIELD_VALUE),
      color: COLORS[severity],
      timestamp: new Date().toISOString(),
      footer,
    });
  }

  const mention = severity === "P1" ? config.discord.mention : "";
  const body = {
    ...(mention ? { content: mention } : {}),
    embeds,
    // 멘션을 명시적으로 켜지 않으면 디스코드가 @here를 실제 알림으로 처리하지 않는다.
    allowed_mentions: mention ? { parse: ["everyone", "roles"] } : { parse: [] },
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 여기서 notify()를 부르면 실패가 실패를 부른다. 로그만 남긴다.
      log.warn({ type: "notify_failed", severity, status: res.status, errorCode: "WEBHOOK_REJECTED" });
    }
  } catch (error) {
    log.warn({
      type: "notify_failed",
      severity,
      errorCode: "WEBHOOK_UNREACHABLE",
      errorName: error instanceof Error ? error.name : "NonError",
    });
  }
}
