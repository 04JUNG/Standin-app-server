// 운영 스위치(kill switch). 값은 DB에 두고 모든 태스크가 같은 값을 읽는다.
//
// env로 두면 반영에 ECS 태스크 정의 갱신과 재배포가 필요해 "즉시 중단"이 되지 않는다.
import { execute, queryOne } from "../db.js";
import { errorFields, log } from "../log.js";
import { notify } from "../notify.js";

export const ANALYSIS_ENABLED = "analysis_enabled";

export interface ServiceFlag {
  key: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
}

/**
 * 요청마다 DB를 때리지 않도록 짧게 캐시한다.
 * 대가는 전 태스크 반영까지 최대 5초 지연 — 운영 중단 용도로는 충분하고,
 * 이 지연은 runbook에 적혀 있다.
 */
const CACHE_TTL_MS = 5_000;
let cache: { flag: ServiceFlag; readAtMs: number } | null = null;

async function readFlag(key: string): Promise<ServiceFlag> {
  const row = await queryOne<{ value: string; reason: string | null; updated_at: string }>(
    "SELECT value, reason, updated_at FROM service_flags WHERE key = $1",
    [key],
  );
  // 행이 없으면 켜져 있는 상태다(기본값을 DB에 미리 넣어두지 않는다).
  return {
    key,
    enabled: row ? row.value === "true" : true,
    reason: row?.reason ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getAnalysisFlag(): Promise<ServiceFlag> {
  const now = Date.now();
  if (cache && now - cache.readAtMs < CACHE_TTL_MS) return cache.flag;
  try {
    const flag = await readFlag(ANALYSIS_ENABLED);
    cache = { flag, readAtMs: now };
    return flag;
  } catch (error) {
    // DB가 흔들릴 때 스위치 조회 실패만으로 분석을 막지 않는다. 뒤이은 Job 생성이
    // 어차피 같은 DB를 쓰므로, 여기서 차단해봐야 원인만 흐려진다.
    log.error({
      type: "service_flag",
      flagKey: ANALYSIS_ENABLED,
      errorCode: "FLAG_READ_FAILED",
      ...errorFields(error),
    });
    // 스위치를 못 읽는다는 건 DB가 흔들린다는 뜻이다. 분석은 막지 않되 알리기는 한다.
    notify({
      severity: "P2",
      code: "FLAG_READ_FAILED",
      message: "운영 스위치를 DB에서 읽지 못했습니다. 직전 값으로 계속 동작합니다.",
    });
    return cache?.flag ?? { key: ANALYSIS_ENABLED, enabled: true, reason: null, updatedAt: null };
  }
}

export async function isAnalysisEnabled(): Promise<boolean> {
  return (await getAnalysisFlag()).enabled;
}

export async function setAnalysisEnabled(
  enabled: boolean,
  reason: string | null,
): Promise<ServiceFlag> {
  const updatedAt = new Date().toISOString();
  await execute(
    `INSERT INTO service_flags (key, value, reason, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = $2, reason = $3, updated_at = $4`,
    [ANALYSIS_ENABLED, String(enabled), reason, updatedAt],
  );
  const flag: ServiceFlag = { key: ANALYSIS_ENABLED, enabled, reason, updatedAt };
  // 토글한 태스크에서는 즉시 보이게 한다(다른 태스크는 캐시 TTL만큼 늦다).
  cache = { flag, readAtMs: Date.now() };
  log.warn({ type: "service_flag", flagKey: ANALYSIS_ENABLED, enabled, reason });
  // 분석 전면 중단·재개는 서비스 상태가 바뀌는 사건이다. 누가 언제 눌렀는지 남긴다.
  notify({
    severity: "P1",
    code: enabled ? "ANALYSIS_RESUMED" : "ANALYSIS_HALTED",
    message: enabled
      ? "운영자가 분석을 재개했습니다."
      : "운영자가 분석을 즉시 중단했습니다(kill switch).",
    context: { 사유: reason ?? "-", 전파: "최대 5초" },
  });
  return flag;
}
