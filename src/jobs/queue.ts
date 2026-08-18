import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { config } from "../config.js";
import { execute, query } from "../db.js";

const sqs = new SQSClient({});

export interface AnalysisQueueMessage {
  version: 1;
  jobId: string;
}

function queueUrl(): string {
  if (!config.analysisQueueUrl) throw new Error("ANALYSIS_QUEUE_URL is required in sqs mode");
  return config.analysisQueueUrl;
}

export function parseQueueMessage(body: string | undefined): AnalysisQueueMessage | null {
  try {
    const value = JSON.parse(body ?? "") as Partial<AnalysisQueueMessage>;
    return value.version === 1 && typeof value.jobId === "string" && /^job_[0-9a-f-]+$/i.test(value.jobId)
      ? { version: 1, jobId: value.jobId }
      : null;
  } catch {
    return null;
  }
}

/** 미발행 outbox를 보낸다. send 후 mark 사이의 crash는 중복만 만들며 worker lease가 막는다. */
export async function dispatchPendingJobs(limit = 10): Promise<number> {
  const pending = await query<{ job_id: string }>(
    `SELECT job_id FROM job_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let sent = 0;
  for (const row of pending) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl(),
        MessageBody: JSON.stringify({ version: 1, jobId: row.job_id }),
      }),
    );
    await execute(
      `UPDATE job_outbox SET published_at = $2, publish_attempts = publish_attempts + 1
       WHERE job_id = $1 AND published_at IS NULL`,
      [row.job_id, new Date().toISOString()],
    );
    sent += 1;
  }
  return sent;
}

export async function receiveJobMessages(): Promise<Message[]> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(),
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: config.workerVisibilitySeconds,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return response.Messages ?? [];
}

export async function deleteJobMessage(receiptHandle: string): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle }));
}

export async function extendJobVisibility(receiptHandle: string): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: config.workerVisibilitySeconds,
    }),
  );
}
