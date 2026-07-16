// BFF의 핵심 역할: 동기 추론(/analyze)을 백그라운드로 호출해 Job으로 감싼다.
// ⚠ Phase 0: 프로세스 내 비동기 실행(await 하지 않고 fire-and-forget).
//    Phase 3: 큐(BullMQ/Redis 등)로 교체 — 이 함수 시그니처는 유지.
import { analyze } from "../inference.js";
import { mapCutResult } from "../mapping.js";
import { getJob, updateJob } from "./store.js";

export async function runAnalysisJob(jobId: string, file: Blob, hint = ""): Promise<void> {
  if (!getJob(jobId)) return;
  updateJob(jobId, { status: "running" });
  try {
    const cut = await analyze(file, hint);
    updateJob(jobId, { status: "completed", result: mapCutResult(jobId, cut) });
  } catch (err) {
    updateJob(jobId, { status: "failed", errorCode: "INFERENCE_FAILED" });
    console.error(`[job ${jobId}] inference failed:`, err);
  }
}
