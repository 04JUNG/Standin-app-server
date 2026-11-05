/** Immutable, private postprocess artifacts. Parent-job retention owns this prefix. */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { InteractiveError, type Operation } from "../interactive-state/model.js";
export interface OutlineStorage {
  load(op: Operation, binding: string): Promise<unknown | null>;
  publish(op: Operation, binding: string, artifact: unknown): Promise<unknown>;
}
export function outlineObjectKey(op: Operation, binding: string) {
  if (![op.installationId, op.jobId].every(v => /^[A-Za-z0-9_-]{1,200}$/.test(v)) ||
      !Number.isSafeInteger(op.personIndex) || op.personIndex < 0 || !/^[a-f0-9]{64}$/.test(binding))
    throw new InteractiveError("OUTLINE_BINDING_MISMATCH");
  return `installations/${op.installationId}/jobs/${op.jobId}/interactive-outline/${op.personIndex}/${binding}.json`;
}
const MAX = 42 * 1024 * 1024;
export class PrivateOutlineStorage implements OutlineStorage {
  private client = new S3Client({});
  async load(op: Operation, binding: string) {
    if (!config.betaDataBucket) throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: config.betaDataBucket, Key: outlineObjectKey(op, binding) }));
      if (!r.Body || (r.ContentLength ?? 0) > MAX) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
        chunks.push(chunk);
      }
      if (r.ContentLength !== undefined && size !== r.ContentLength) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
      if (e instanceof InteractiveError) throw e;
      throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
    }
  }
  async publish(op: Operation, binding: string, artifact: unknown) {
    if (!config.betaDataBucket) throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
    const body = Buffer.from(JSON.stringify(artifact));
    if (body.length > MAX) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
    try {
      await this.client.send(new PutObjectCommand({ Bucket: config.betaDataBucket, Key: outlineObjectKey(op, binding), Body: body,
        ContentType: "application/json", IfNoneMatch: "*" }));
      return artifact;
    } catch (e) {
      if ([409, 412].includes((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0)) {
        const existing = await this.load(op, binding);
        if (existing) return existing;
      }
      throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
    }
  }
}
