// BFF의 핵심 역할: 동기 추론(/analyze)을 백그라운드로 호출해 Job으로 감싼다.
// ⚠ Phase 0: 프로세스 내 비동기 실행(await 하지 않고 fire-and-forget).
//    Phase 3: 큐(BullMQ/Redis 등)로 교체 — 이 함수 시그니처는 유지.
import { analyze } from "../inference.js";
import { extractRefineContexts, mapCutResult } from "../mapping.js";
import type { AnalysisResult } from "../types.js";
import { getJob, persistAnalysisRecords, updateJob } from "./store.js";

/**
 * 인물 단위 품질 분포를 job마다 남긴다(BFF-08).
 *
 * soft/hard fallback과 crop 재추론 비율은 스켈레톤 보완이 실제로 듣고 있는지 판단하는
 * 1차 지표다. 코드형 값만 담고 좌표·점수 같은 원본은 남기지 않는다.
 */
function logQualityMetrics(jobId: string, result: AnalysisResult): void {
  const people = result.candidatesByPerson;
  if (people.length === 0) return;
  console.log(
    JSON.stringify({
      type: "analysis_quality",
      jobId,
      peopleCount: people.length,
      softFallback: people.filter((p) => p.fallbackMode === "soft").length,
      hardFallback: people.filter((p) => p.fallbackMode === "hard").length,
      cropRetry: people.filter((p) => p.skeletonSource === "crop_retry").length,
      refineAllowed: people.filter((p) => p.refineAllowed).length,
    }),
  );
}

export async function runAnalysisJob(jobId: string, file: Blob, hint = ""): Promise<void> {
  const startedAt = Date.now();
  if (!(await getJob(jobId))) return;
  await updateJob(jobId, { status: "running" });
  try {
    const cut = await analyze(file, hint);
    const result = mapCutResult(jobId, cut);
    await persistAnalysisRecords(jobId, result, extractRefineContexts(cut));
    await updateJob(jobId, { status: "completed", result });
    logQualityMetrics(jobId, result);
  } catch {
    // 상태 기록까지 실패하면 Job이 running에 머문다. 로그로 남겨 추적 가능하게 한다.
    await updateJob(jobId, { status: "failed", errorCode: "INFERENCE_FAILED" }).catch(() =>
      console.error(
        JSON.stringify({
          type: "analysis_job",
          jobId,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errorCode: "FAILURE_STATUS_PERSIST_FAILED",
        }),
      ),
    );
    console.error(
      JSON.stringify({
        type: "analysis_job",
        jobId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: "INFERENCE_FAILED",
      }),
    );
  }
}
