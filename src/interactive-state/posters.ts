/** Private UI asset. Immutable key and a separately fenced current-operation pointer. */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { sha256Hex } from "../converter/client.js";
import { InteractiveError, type Operation } from "./model.js";
import type { PosterStorage } from "./service.js";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  MAX = 4 * 1024 * 1024;
export function checkPoster(png: Uint8Array) {
  if (
    png.length < 24 ||
    png.length > MAX ||
    !Buffer.from(png.subarray(0, 8)).equals(PNG)
  )
    throw new InteractiveError("POSTER_INTEGRITY");
  const b = Buffer.from(png);
  if (
    b.readUInt32BE(16) > 4096 ||
    b.readUInt32BE(20) > 4096 ||
    !b.readUInt32BE(16) ||
    !b.readUInt32BE(20)
  )
    throw new InteractiveError("POSTER_INTEGRITY");
}
function key(op: Operation) {
  if (
    !op.stateHash ||
    ![op.installationId, op.jobId].every((s) => /^[A-Za-z0-9_-]+$/.test(s))
  )
    throw new InteractiveError("POSTER_INTEGRITY");
  return `installations/${op.installationId}/jobs/${op.jobId}/interactive/${op.stateHash}/poster.png`;
}
export class PrivatePosters implements PosterStorage {
  private client = new S3Client({});
  async publishAuxiliary(op: Operation, png: Uint8Array, sha256: string) {
    checkPoster(png);
    if (sha256Hex(png) !== sha256 || !config.betaDataBucket)
      throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: config.betaDataBucket,
          Key: key(op).replace("poster.png", `ui-${sha256}.png`),
          Body: png,
          ContentType: "image/png",
          IfNoneMatch: "*",
        }),
      );
    } catch (e) {
      if (
        ![409, 412].includes(
          (e as { $metadata?: { httpStatusCode: number } })?.$metadata
            ?.httpStatusCode ?? 0,
        )
      )
        throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
    }
  }
  async publish(op: Operation, png: Uint8Array) {
    checkPoster(png);
    if (!config.betaDataBucket)
      throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: config.betaDataBucket,
          Key: key(op),
          Body: png,
          ContentType: "image/png",
          IfNoneMatch: "*",
        }),
      );
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode: number } })
        ?.$metadata?.httpStatusCode;
      if (status !== 409 && status !== 412)
        throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
      // Concurrent PNG metadata may differ; retain the first committed static frame.
      const existing = await this.read({ ...op, poster: null });
      if (!existing)
        throw new InteractiveError("POSTER_STORAGE_UNAVAILABLE", 503);
      return {
        sha256: sha256Hex(existing),
        renderer: "verified-fbx-final-preview-v1",
      };
    }
    return {
      sha256: sha256Hex(png),
      renderer: "verified-fbx-final-preview-v1",
    };
  }
  async read(op: Operation) {
    if (!config.betaDataBucket) return null;
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: config.betaDataBucket, Key: key(op) }),
      );
      if (!r.Body || (r.ContentLength ?? 0) > MAX)
        throw new InteractiveError("POSTER_INTEGRITY");
      const png = await r.Body.transformToByteArray();
      checkPoster(png);
      if (op.poster && sha256Hex(png) !== op.poster.sha256)
        throw new InteractiveError("POSTER_INTEGRITY");
      return png;
    } catch (e) {
      if (
        (e as { $metadata?: { httpStatusCode: number } })?.$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw e;
    }
  }
}
