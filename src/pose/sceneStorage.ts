import { SCENE_REVIEW_VERSION, SceneError } from "./sceneContract.js";
/** Immutable scene receipts survive a BFF replica change, like person receipts. */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { ConverterError, sha256Hex } from "../converter/client.js";
import type { RefinedScene } from "./sceneRefinement.js";
export interface SceneReceipt {
  reviewVersion: typeof SCENE_REVIEW_VERSION;
  binding: string;
  expires: number;
  scene: RefinedScene;
}
const client = new S3Client({});
const MAX_BYTES = 192 * 1024 * 1024;
function objectKey(owner: string, job: string, key: string) {
  if (
    ![owner, job].every((v) => /^[A-Za-z0-9_-]+$/.test(v)) ||
    !/^[a-f0-9]{48}$/.test(key)
  )
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "invalid scene receipt owner",
    );
  return `installations/${owner}/jobs/${job}/scene-receipts/${key}.json`;
}
export function encodeSceneReceipt(receipt: SceneReceipt) {
  const bytes = Buffer.from(
    JSON.stringify({
      version: 2,
      ...receipt,
      scene: {
        ...receipt.scene,
        bytes: Buffer.from(receipt.scene.bytes).toString("base64"),
      },
    }),
  );
  if (bytes.length > MAX_BYTES)
    throw new ConverterError("CONVERTER_INTEGRITY", "scene receipt size");
  return bytes;
}
export function decodeSceneReceipt(data: Uint8Array): SceneReceipt {
  try {
    if (data.length > MAX_BYTES) throw new Error("size");
    const value = JSON.parse(Buffer.from(data).toString("utf8"));
    const scene = value.scene;
    const bytes = Buffer.from(scene.bytes, "base64");
    const preview = Buffer.from(scene.preview, "base64");
    if (
      value.version !== 2 ||
      value.reviewVersion !== SCENE_REVIEW_VERSION ||
      !/^[a-f0-9]{64}$/.test(value.binding) ||
      !Number.isSafeInteger(value.expires) || value.expires <= 0 ||
      bytes.toString("base64") !== scene.bytes || preview.toString("base64") !== scene.preview ||
      !Array.isArray(scene.summary) ||
      scene.summary.length > 8 ||
      !bytes
        .subarray(0, 23)
        .equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) ||
      sha256Hex(bytes) !== scene.sha256 ||
      sha256Hex(preview) !== scene.previewSha256 ||
      (scene.artifactContract === "verified-scene-fbx-v1"
        ? preview.length !== 0
        : !preview.length)
    )
      throw new Error("lineage");
    return {
      reviewVersion: value.reviewVersion,
      binding: value.binding,
      expires: value.expires,
      scene: { ...scene, bytes },
    };
  } catch {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "stored scene receipt mismatch",
    );
  }
}
/** Local development may re-prepare on replica change; production must share. */
export function sceneReceiptStorageAvailable() {
  return !!config.betaDataBucket || process.env.NODE_ENV !== "production";
}
export async function saveSceneReceipt(
  owner: string,
  job: string,
  key: string,
  receipt: SceneReceipt,
) {
  if (!config.betaDataBucket) {
    if (process.env.NODE_ENV === "production")
      throw new ConverterError(
        "CONVERTER_UNAVAILABLE",
        "scene storage unavailable",
      );
    return;
  }
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.betaDataBucket,
      Key: objectKey(owner, job, key),
      Body: encodeSceneReceipt(receipt),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }));
  } catch (error) {
    if (error instanceof ConverterError) throw error;
    throw new SceneError("SCENE_UNAVAILABLE", "scene receipt publication failed");
  }
}
export async function loadSceneReceipt(
  owner: string,
  job: string,
  key: string,
): Promise<SceneReceipt | undefined> {
  if (!config.betaDataBucket) return undefined;
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.betaDataBucket,
        Key: objectKey(owner, job, key),
      }),
    );
    if (!response.Body || (response.ContentLength ?? 0) > MAX_BYTES)
      throw new ConverterError("CONVERTER_INTEGRITY", "scene receipt size");
    return decodeSceneReceipt(await response.Body.transformToByteArray());
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode === 404
    )
      return undefined;
    if (error instanceof ConverterError) throw error;
    throw new SceneError("SCENE_UNAVAILABLE", "scene receipt load failed");
  }
}
