import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { loadInput } from "./inputStorage.js";
import { runAnalysisJob } from "./jobs/runner.js";
import { claimJob, renewJobLease, updateJob } from "./jobs/store.js";
import { errorFields, log } from "./log.js";
import { flush as flushAlerts, notify } from "./notify.js";
import { runWithContext } from "./requestContext.js";
import {
  deleteJobMessage,
  extendJobVisibility,
  parseQueueMessage,
  receiveJobMessages,
} from "./jobs/queue.js";

if (!config.analysisQueueUrl) throw new Error("ANALYSIS_QUEUE_URL is required for worker");
await initDb();

const workerId = `worker_${randomUUID()}`;
let stopping = false;
log.info({ type: "startup", msg: "analysis worker started", workerId });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info({ type: "shutdown", msg: `${signal} received`, signal, workerId });
  });
}

while (!stopping) {
  const messages = await receiveJobMessages().catch((error) => {
    log.error({
      type: "queue_receive",
      errorCode: "QUEUE_RECEIVE_FAILED",
      ...errorFields(error),
    });
    notify({
      severity: "P2",
      code: "QUEUE_RECEIVE_FAILED",
      message: "분석 Worker가 SQS 메시지를 받지 못했습니다.",
    });
    return [];
  });
  for (const message of messages) {
    if (!message.ReceiptHandle) continue;
    const payload = parseQueueMessage(message.Body);
    if (!payload) {
      await deleteJobMessage(message.ReceiptHandle);
      continue;
    }
    await runWithContext(
      { requestId: `req_worker_${randomUUID()}`, jobId: payload.jobId },
      async () => {
        const job = await claimJob(payload.jobId, workerId, config.workerLeaseSeconds);
        if (!job) {
          await deleteJobMessage(message.ReceiptHandle!);
          return;
        }
        const heartbeat = setInterval(() => {
          void Promise.all([
            renewJobLease(job.id, workerId, config.workerLeaseSeconds),
            extendJobVisibility(message.ReceiptHandle!),
          ]).catch((error) => {
            log.error({
              type: "job_heartbeat",
              jobId: job.id,
              errorCode: "WORKER_HEARTBEAT_FAILED",
              ...errorFields(error),
            });
            notify({
              severity: "P2",
              code: "WORKER_HEARTBEAT_FAILED",
              message: "분석 Worker의 lease 또는 SQS visibility 연장에 실패했습니다.",
            });
          });
        }, Math.max(10, Math.floor(config.workerVisibilitySeconds / 3)) * 1000);
        heartbeat.unref();
        try {
          if (!job.inputS3Key) throw new Error("queued job has no input key");
          await runAnalysisJob(job.id, await loadInput(job.inputS3Key), "", true);
          await deleteJobMessage(message.ReceiptHandle!);
        } catch (error) {
          await updateJob(job.id, { status: "failed", errorCode: "INPUT_STORAGE_FAILED" }).catch(
            (persistError) =>
              log.error({
                type: "queue_job",
                jobId: job.id,
                errorCode: "FAILURE_STATUS_PERSIST_FAILED",
                ...errorFields(persistError),
              }),
          );
          log.error({
            type: "queue_job",
            jobId: job.id,
            errorCode: "INPUT_STORAGE_FAILED",
            ...errorFields(error),
          });
          notify({
            severity: "P2",
            code: "INPUT_STORAGE_FAILED",
            message: "분석 Worker가 저장된 입력을 처리하지 못했습니다.",
          });
          await deleteJobMessage(message.ReceiptHandle!);
        } finally {
          clearInterval(heartbeat);
        }
      },
    );
  }
}

await flushAlerts().catch(() => undefined);
await closeDb();
