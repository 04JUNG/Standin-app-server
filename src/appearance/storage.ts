/** Immutable, private postprocess artifacts. Parent-job retention owns this prefix. */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { InteractiveError, type Operation } from "../interactive-state/model.js";
export interface OutlineStorage {
  load(op: Operation, binding: string): Promise<unknown | null>;
  publish(op: Operation, binding: string, artifact: unknown): Promise<unknown>;
}
type ArtifactKind = "outline" | "skin";
function artifactObjectKey(op: Operation, binding: string, kind: ArtifactKind) {
  if (![op.installationId, op.jobId].every(v => /^[A-Za-z0-9_-]{1,200}$/.test(v)) ||
      !Number.isSafeInteger(op.personIndex) || op.personIndex < 0 || !/^[a-f0-9]{64}$/.test(binding))
    throw new InteractiveError(`${kind.toUpperCase()}_BINDING_MISMATCH`);
  return `installations/${op.installationId}/jobs/${op.jobId}/interactive-${kind}/${op.personIndex}/${binding}.json`;
}
export const outlineObjectKey = (op: Operation, binding: string) => artifactObjectKey(op, binding, "outline");
export const skinObjectKey = (op: Operation, binding: string) => artifactObjectKey(op, binding, "skin");
const MAX = 42 * 1024 * 1024;
export class PrivateOutlineStorage implements OutlineStorage {
  private client = new S3Client({});
  constructor(private readonly kind: ArtifactKind = "outline") {}
  private error(suffix: string) { return `${this.kind.toUpperCase()}_${suffix}`; }
  async load(op: Operation, binding: string) {
    if (!config.betaDataBucket) throw new InteractiveError(this.error("UNAVAILABLE"), 503);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: config.betaDataBucket, Key: artifactObjectKey(op, binding, this.kind) }));
      if (!r.Body || (r.ContentLength ?? 0) > MAX) throw new InteractiveError(this.error("INTEGRITY_ERROR"));
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX) throw new InteractiveError(this.error("INTEGRITY_ERROR"));
        chunks.push(chunk);
      }
      if (r.ContentLength !== undefined && size !== r.ContentLength) throw new InteractiveError(this.error("INTEGRITY_ERROR"));
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
      if (e instanceof InteractiveError) throw e;
      throw new InteractiveError(this.error("UNAVAILABLE"), 503);
    }
  }
  async publish(op: Operation, binding: string, artifact: unknown) {
    if (!config.betaDataBucket) throw new InteractiveError(this.error("UNAVAILABLE"), 503);
    const body = Buffer.from(JSON.stringify(artifact));
    if (body.length > MAX) throw new InteractiveError(this.error("INTEGRITY_ERROR"));
    try {
      await this.client.send(new PutObjectCommand({ Bucket: config.betaDataBucket, Key: artifactObjectKey(op, binding, this.kind), Body: body,
        ContentType: "application/json", IfNoneMatch: "*" }));
      return artifact;
    } catch (e) {
      if ([409, 412].includes((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0)) {
        const existing = await this.load(op, binding);
        if (existing) return existing;
      }
      throw new InteractiveError(this.error("UNAVAILABLE"), 503);
    }
  }
}

/** Separate owned namespace; parent-job retention covers both. */
export class PrivateSkinStorage extends PrivateOutlineStorage {
  constructor() { super("skin"); }
}
