import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { closeDb, initDb } from "./db.js";
import { loadInput } from "./inputStorage.js";
import { runAnalysisJob } from "./jobs/runner.js";
import { claimJob, renewJobLease, updateJob } from "./jobs/store.js";
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
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  const messages = await receiveJobMessages().catch((error) => {
    console.error(JSON.stringify({ type: "queue_receive", status: "failed", error: String(error) }));
    return [];
  });
  for (const message of messages) {
    if (!message.ReceiptHandle) continue;
    const payload = parseQueueMessage(message.Body);
    if (!payload) {
      await deleteJobMessage(message.ReceiptHandle);
      continue;
    }
    const job = await claimJob(payload.jobId, workerId, config.workerLeaseSeconds);
    if (!job) {
      await deleteJobMessage(message.ReceiptHandle);
      continue;
    }
    const heartbeat = setInterval(() => {
      void Promise.all([
        renewJobLease(job.id, workerId, config.workerLeaseSeconds),
        extendJobVisibility(message.ReceiptHandle!),
      ]).catch(() => console.error(JSON.stringify({ type: "job_heartbeat", jobId: job.id, status: "failed" })));
    }, Math.max(10, Math.floor(config.workerVisibilitySeconds / 3)) * 1000);
    heartbeat.unref();
    try {
      if (!job.inputS3Key) throw new Error("queued job has no input key");
      await runAnalysisJob(job.id, await loadInput(job.inputS3Key), "", true);
      await deleteJobMessage(message.ReceiptHandle);
    } catch (error) {
      await updateJob(job.id, { status: "failed", errorCode: "INPUT_STORAGE_FAILED" }).catch(() => {});
      console.error(JSON.stringify({ type: "queue_job", jobId: job.id, status: "failed", error: String(error) }));
      await deleteJobMessage(message.ReceiptHandle);
    } finally {
      clearInterval(heartbeat);
    }
  }
}

await closeDb();
