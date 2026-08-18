import { createHash } from "node:crypto";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";
import { readImageSize, type ImageSize } from "./imageHeader.js";

const client = new S3Client({});

export class InvalidImageContentError extends Error {}

function extensionFor(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function hasExpectedSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  }
  if (mime === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  return false;
}

export async function storeInput(
  installationId: string,
  jobId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ key: string | null; sha256: string }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!config.betaDataBucket) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BETA_DATA_BUCKET is required in production");
    }
    return { key: null, sha256 };
  }
  const key = `installations/${installationId}/jobs/${jobId}/input.${extensionFor(mime)}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.betaDataBucket,
      Key: key,
      Body: bytes,
      ContentType: mime || "application/octet-stream",
    }),
  );
  return { key, sha256 };
}

/** 헤더에서 읽어낸 실제 크기. 형식을 못 읽으면 null(= 확인 불가). */
export interface InspectedImage {
  size: ImageSize | null;
}

/**
 * 업로드된 바이트가 주장한 MIME과 실제로 맞는지 확인하고 실제 크기를 읽는다.
 *
 * 바이트를 인자로 받는 이유: 예전에는 검증과 저장이 각각 `arrayBuffer()`를 불러
 * 같은 20MB를 최소 두 번 메모리에 올렸다. 호출부가 한 번만 읽어 넘긴다.
 */
export function inspectInputImage(bytes: Uint8Array, mime: string): InspectedImage {
  if (!hasExpectedSignature(bytes, mime)) {
    throw new InvalidImageContentError("input image signature does not match MIME type");
  }
  return { size: readImageSize(bytes, mime) };
}

export async function deleteInstallationObjects(installationId: string): Promise<void> {
  if (!config.betaDataBucket) return;
  const prefix = `installations/${installationId}/`;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.betaDataBucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (page.Contents ?? []).flatMap((entry) =>
      entry.Key ? [{ Key: entry.Key }] : [],
    );
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: config.betaDataBucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}

export async function signedInputUrl(key: string): Promise<string | null> {
  if (!config.betaDataBucket) return null;
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.betaDataBucket, Key: key }),
    { expiresIn: 300 },
  );
}

/** Worker가 S3의 원본을 읽어 추론 서버에 전달한다. 메시지에는 이미지 바이트를 넣지 않는다. */
export async function loadInput(key: string): Promise<Blob> {
  if (!config.betaDataBucket) throw new Error("BETA_DATA_BUCKET is required for queued jobs");
  const response = await client.send(
    new GetObjectCommand({ Bucket: config.betaDataBucket, Key: key }),
  );
  if (!response.Body) throw new Error("queued job input is empty");
  const bytes = await response.Body.transformToByteArray();
  return new Blob([bytes], { type: response.ContentType ?? "application/octet-stream" });
}
