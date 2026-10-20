/** Private, immutable review pairs shared by BFF replicas and restarts. */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { ConverterError, sha256Hex } from "./client.js";
import type { FramedArtifact } from "./framing.js";

export interface FramedLocation { installationId: string; jobId: string }
export interface FramedPairStore {
  load(location: FramedLocation, key: string): Promise<FramedArtifact | null>;
  publish(location: FramedLocation, key: string, pair: FramedArtifact): Promise<FramedArtifact>;
}
const MAX_BYTES = 48 * 1024 * 1024;
const client = new S3Client({});
const hash = (key: string) => sha256Hex(Buffer.from(key));
export function framedObjectKey(location: FramedLocation, key: string) {
  for (const value of [location.installationId, location.jobId])
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid framed owner");
  return `installations/${location.installationId}/jobs/${location.jobId}/framed/${hash(key)}.json`;
}
export function encodeFramedPair(key: string, pair: FramedArtifact): Buffer {
  const body = Buffer.from(JSON.stringify({
    version: 1, keySha256: hash(key), ...pair,
    fbx: Buffer.from(pair.fbx).toString("base64"),
    preview: Buffer.from(pair.preview).toString("base64"),
    previewSha256: sha256Hex(pair.preview),
  }));
  if (body.length > MAX_BYTES) throw new ConverterError("CONVERTER_INTEGRITY", "review pair too large");
  return body;
}
export function decodeFramedPair(key: string, body: Uint8Array): FramedArtifact {
  try {
    if (body.length > MAX_BYTES) throw new Error("size");
    const value = JSON.parse(Buffer.from(body).toString("utf8"));
    if (value.version !== 1 || value.keySha256 !== hash(key) ||
        typeof value.fbx !== "string" || typeof value.preview !== "string" ||
        typeof value.conversionId !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sourceBvhSha256) ||
        [value.characterSha256, value.previewRevision].some(v => v !== undefined && !/^[a-f0-9]{64}$/.test(v)))
      throw new Error("identity");
    const fbx = Buffer.from(value.fbx, "base64"), preview = Buffer.from(value.preview, "base64");
    if (!fbx.length || !preview.length || sha256Hex(fbx) !== value.artifactSha256 ||
        sha256Hex(preview) !== value.previewSha256) throw new Error("digest");
    return { fbx, preview, conversionId: value.conversionId, artifactSha256: value.artifactSha256,
      sourceBvhSha256: value.sourceBvhSha256,
      ...(value.characterSha256 ? { characterSha256: value.characterSha256 } : {}),
      ...(value.previewRevision ? { previewRevision: value.previewRevision } : {}) };
  } catch {
    throw new ConverterError("CONVERTER_INTEGRITY", "stored review pair invalid");
  }
}
function missing(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
}
function conflict(error: unknown) {
  return [409, 412].includes((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0);
}
export const framedPairStore: FramedPairStore = {
  async load(location, key) {
    if (!config.betaDataBucket) {
      if (process.env.NODE_ENV === "production") throw new ConverterError("CONVERTER_UNAVAILABLE", "review storage unavailable");
      return null;
    }
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: config.betaDataBucket, Key: framedObjectKey(location, key) }));
      if (!res.Body || (res.ContentLength ?? 0) > MAX_BYTES)
        throw new ConverterError("CONVERTER_INTEGRITY", "stored review pair size");
      return decodeFramedPair(key, await res.Body.transformToByteArray());
    } catch (error) {
      if (missing(error)) return null;
      if (error instanceof ConverterError) throw error;
      throw new ConverterError("CONVERTER_UNAVAILABLE", "review storage read failed");
    }
  },
  async publish(location, key, pair) {
    if (!config.betaDataBucket) {
      if (process.env.NODE_ENV === "production") throw new ConverterError("CONVERTER_UNAVAILABLE", "review storage unavailable");
      return pair;
    }
    try {
      await client.send(new PutObjectCommand({ Bucket: config.betaDataBucket, Key: framedObjectKey(location, key),
        Body: encodeFramedPair(key, pair), ContentType: "application/json", IfNoneMatch: "*" }));
      return pair;
    } catch (error) {
      // Concurrent renders may contain different FBX metadata. Both callers must
      // serve the first committed pair, including its PNG and receipt hash.
      if (conflict(error)) {
        const winner = await this.load(location, key);
        if (winner) return winner;
      }
      if (error instanceof ConverterError) throw error;
      throw new ConverterError("CONVERTER_UNAVAILABLE", "review storage write failed");
    }
  },
};
