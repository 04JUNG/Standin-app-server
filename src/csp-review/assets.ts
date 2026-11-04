import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "../converter/client.js";
import { config } from "../config.js";

export type ReviewSex = "male" | "female";
export interface ReviewModel { sex: ReviewSex; version: string; key: string; sha256: string; bytes: number }
export interface ReviewRelease {
  schema: "standin-csp-review.v1"; releaseId: string;
  mode: "neutral-vrm-plus-selected-bvh"; models: ReviewModel[];
}
export interface ReviewSettings { enabled: boolean; bucket: string; manifestKey: string; manifestSha256: string }
export function reviewSettings(): ReviewSettings {
  return {
    enabled: config.cspReviewEnabled,
    bucket: config.cspReviewBucket,
    manifestKey: config.cspReviewManifestKey,
    manifestSha256: config.cspReviewManifestSha256,
  };
}
export function parseReviewRelease(bytes: Uint8Array, expected: string, key: string): ReviewRelease {
  if (!/^[0-9a-f]{64}$/.test(expected) || sha256Hex(bytes) !== expected) throw new Error("review manifest integrity");
  const d = JSON.parse(new TextDecoder().decode(bytes)) as ReviewRelease;
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  if (!prefix.startsWith("body-models/csp-review/") || key.includes("..") ||
      d.schema !== "standin-csp-review.v1" || d.mode !== "neutral-vrm-plus-selected-bvh" ||
      !/^[a-z0-9-]{1,100}$/.test(d.releaseId) || !Array.isArray(d.models) || d.models.length !== 2 ||
      new Set(d.models.map(m => m.sex)).size !== 2) throw new Error("invalid review release");
  for (const m of d.models) {
    if (!["male", "female"].includes(m.sex) || !/^[0-9.]{1,20}$/.test(m.version) ||
        !m.key.startsWith(prefix) || m.key.includes("..") || !m.key.endsWith(".vrm") ||
        !/^[0-9a-f]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) ||
        m.bytes < 100 || m.bytes > 25 * 1024 * 1024) throw new Error("invalid review model");
  }
  return d;
}
export function createAssetLoader(settings = reviewSettings()) {
  const s3 = new S3Client({});
  async function read(key: string, limit: number): Promise<Uint8Array> {
    const result = await s3.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    if (result.ContentLength === undefined || result.ContentLength > limit || !result.Body)
      throw new Error("review asset size");
    const bytes = await result.Body.transformToByteArray();
    if (bytes.length > limit) throw new Error("review asset size");
    return bytes;
  }
  let cached: ReviewRelease | undefined;
  return async (sex: ReviewSex) => {
    if (!settings.enabled) throw new Error("review disabled");
    const release = cached ??= parseReviewRelease(await read(settings.manifestKey, 32768), settings.manifestSha256, settings.manifestKey);
    const model = release.models.find(m => m.sex === sex)!;
    const bytes = await read(model.key, model.bytes);
    if (bytes.length !== model.bytes || sha256Hex(bytes) !== model.sha256) throw new Error("review model integrity");
    return { release, model, bytes };
  };
}
