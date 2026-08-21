// BFF의 핵심 역할: 동기 추론(/analyze)을 백그라운드로 호출해 Job으로 감싼다.
// ⚠ Phase 0: 프로세스 내 비동기 실행(await 하지 않고 fire-and-forget).
//    Phase 3: 큐(BullMQ/Redis 등)로 교체 — 이 함수 시그니처는 유지.
import { analyze, analysisFailureCode, shouldRefundQuota } from "../inference.js";
import { errorFields, log } from "../log.js";
import { extractRefineContexts, mapCutResult } from "../mapping.js";
import { notify } from "../notify.js";
import { amendContext } from "../requestContext.js";
import type { AnalysisResult } from "../types.js";
import { failJob, getJob, persistAnalysisRecords, updateJob } from "./store.js";

/**
 * 인물 단위 품질 분포를 job마다 남긴다(BFF-08).
 *
 * soft/hard fallback과 crop 재추론 비율은 스켈레톤 보완이 실제로 듣고 있는지 판단하는
 * 1차 지표다. 코드형 값만 담고 좌표·점수 같은 원본은 남기지 않는다.
 */
function logQualityMetrics(jobId: string, result: AnalysisResult): void {
  const people = result.candidatesByPerson;
  if (people.length === 0) return;
  log.info({
    type: "analysis_quality",
    jobId,
    peopleCount: people.length,
    softFallback: people.filter((p) => p.fallbackMode === "soft").length,
    hardFallback: people.filter((p) => p.fallbackMode === "hard").length,
    cropRetry: people.filter((p) => p.skeletonSource === "crop_retry").length,
    refineAllowed: people.filter((p) => p.refineAllowed).length,
  });
}

/** 사유별 알림 문구. 운영자가 첫 줄만 보고 대응을 고를 수 있게 쓴다. */
const FAILURE_ALERTS: Record<string, string> = {
  ANALYSIS_TIMEOUT: "분석이 시간 초과로 실패했습니다. 추론 서버가 느리거나 멈춰 있습니다.",
  ANALYSIS_UNAVAILABLE:
    "상류 VLM 혼잡으로 분석이 실패했습니다. 사용자에게는 재시도 안내가 나갑니다.",
  INFERENCE_FAILED: "분석이 추론 서버 오류로 실패했습니다.",
};

export async function runAnalysisJob(
  jobId: string,
  file: Blob,
  hint = "",
  alreadyRunning = false,
): Promise<void> {
  const startedAt = Date.now();
  if (!(await getJob(jobId))) return;
  // fire-and-forget으로 불리므로 요청 컨텍스트가 이미 끊겼을 수 있다. jobId만은
  // 반드시 물고 가야 이 Job의 로그가 하나로 이어진다.
  amendContext({ jobId });
  if (!alreadyRunning) await updateJob(jobId, { status: "running" });
  try {
    const cut = await analyze(file, hint);
    const result = mapCutResult(jobId, cut);
    await persistAnalysisRecords(jobId, result, extractRefineContexts(cut));
    await updateJob(jobId, { status: "completed", result });
    logQualityMetrics(jobId, result);
  } catch (error) {
    // timeout·상류 혼잡·그 외를 구분한다 — "추론이 응답하지 않는다", "상류가 붐빈다",
    // "추론이 거절했다"는 운영 대응이 다르고, 사용자에게 줄 안내도 다르다.
    const errorCode = analysisFailureCode(error);
    // 상태 기록까지 실패하면 Job이 running에 머문다. 로그로 남겨 추적 가능하게 한다.
    // 상류가 요청을 받아주지 않아 분석이 아예 수행되지 않았으면 하루 쿼터도 돌려준다.
    const refundQuota = shouldRefundQuota(errorCode);
    await failJob(jobId, errorCode, { refundQuota }).catch((persistError) =>
      log.error({
        type: "analysis_job",
        jobId,
        jobStatus: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: "FAILURE_STATUS_PERSIST_FAILED",
        ...errorFields(persistError),
      }),
    );
    log.error({
      type: "analysis_job",
      jobId,
      jobStatus: "failed",
      durationMs: Date.now() - startedAt,
      errorCode,
      quotaRefunded: refundQuota,
      ...errorFields(error),
    });
    // 사유별로 접는다 — timeout이 쏟아지는 것과 추론이 거절하는 것은 다른 사건이다.
    // 상류 혼잡(ANALYSIS_UNAVAILABLE)은 우리가 고칠 것이 없다. 같은 통에 담으면
    // "우리 장애"의 빈도를 실제보다 크게 보게 된다.
    notify({
      severity: "P2",
      code: errorCode,
      key: `P2:analysis:${errorCode}`,
      message: FAILURE_ALERTS[errorCode],
    });
  }
}
