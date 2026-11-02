import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
export interface ReplayStorage {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  deletePrefix(prefix: string): Promise<void>;
}
export class LocalReplayStorage implements ReplayStorage {
  constructor(private root: string) {}
  private path(key: string) {
    if (
      !/^replays\/[a-f0-9-]{36}\/(?:[a-zA-Z0-9_./:-]+)?$/.test(key) ||
      key.includes("..")
    )
      throw new Error("invalid replay key");
    return resolve(this.root, key);
  }
  async put(key: string, bytes: Uint8Array) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async deletePrefix(prefix: string) {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
}
/** Never publishes ACLs or presigned URLs. Every read goes through the admin authorization check. */
export class S3ReplayStorage implements ReplayStorage {
  constructor(
    private bucket: string,
    private client = new S3Client({}),
  ) {}
  async put(key: string, bytes: Uint8Array, mime: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        ServerSideEncryption: "AES256",
        CacheControl: "private, no-store",
      }),
    );
  }
  async get(key: string) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!r.Body) throw new Error("missing replay object");
    return r.Body.transformToByteArray();
  }
  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const objects = (r.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (objects.length) {
        const d = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (d.Errors?.length) throw new Error("replay delete failed");
      }
      token = r.NextContinuationToken;
    } while (token);
  }
}
