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
  file: Blob,
): Promise<{ key: string | null; sha256: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedSignature(bytes, file.type)) {
    throw new InvalidImageContentError("input image signature does not match MIME type");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!config.betaDataBucket) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BETA_DATA_BUCKET is required in production");
    }
    return { key: null, sha256, bytes };
  }
  const key = `installations/${installationId}/jobs/${jobId}/input.${extensionFor(file.type)}`;
  await client.send(
    new PutObjectCommand({
      Bucket: config.betaDataBucket,
      Key: key,
      Body: bytes,
      ContentType: file.type || "application/octet-stream",
    }),
  );
  return { key, sha256, bytes };
}

export async function validateInputImage(file: Blob): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedSignature(bytes, file.type)) {
    throw new InvalidImageContentError("input image signature does not match MIME type");
  }
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
