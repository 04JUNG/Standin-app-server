import { z } from "zod";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
export const PROTOCOL = "session-replay.v1";
export const LIMITS = {
  chunkBytes: 1048576,
  assetBytes: 8388608,
  sessionBytes: 67108864,
  installationDailyBytes: 268435456,
  eventsPerChunk: 10000,
  sessionDurationMs: 14400000,
  maxStreams: 16,
  maxChunks: 4096,
  maxAssets: 512,
} as const;
export class ReplayError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409 | 410 | 413 | 429 | 503 = 400,
  ) {
    super(code);
  }
}
export const fail = (
  code: string,
  status: ReplayError["status"] = 400,
): never => {
  throw new ReplayError(code, status);
};
export const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
  .refine((v) => !v.includes(".."));
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().min(0).max(LIMITS.sessionDurationMs);
export const createSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL),
    replayId: z.uuid(),
    appSessionId: identifier,
    startedAt: z.number().int().positive(),
    appVersion: z.string().max(64),
    os: identifier,
    authorizationMode: z.enum(["assumed", "explicit"]),
    policyVersion: z.literal("2026-10-28"),
  })
  .strict();
export const chunkSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL),
    surface: z.enum(["app", "bar", "capture"]),
    contentHash: sha,
    encoding: z.enum(["json", "gzip-base64"]),
    events: z.array(z.unknown()).min(1).max(LIMITS.eventsPerChunk).optional(),
    data: z.string().max(1500000).optional(),
    startedOffsetMs: offset,
    endedOffsetMs: offset,
    clock: z
      .object({
        epochMs: z.number().int().nonnegative(),
        monotonicOffsetMs: offset,
      })
      .strict(),
    inputAttemptId: identifier.optional(),
    jobId: identifier.optional(),
    attemptId: identifier.optional(),
    screen: identifier.optional(),
    feature: identifier.optional(),
    failed: z.boolean().optional(),
    saveState: z.enum(["unknown", "saved", "failed", "cancelled"]).optional(),
  })
  .strict();
export const assetSchema = z
  .object({
    contentType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "font/woff2",
    ]),
    dataBase64: z.string().max(11184812),
    kind: z.enum([
      "rough",
      "thumbnail",
      "final",
      "csp_result",
      "capture_background",
      "canvas_frame",
      "font",
    ]),
    jobId: identifier.optional(),
    inputAttemptId: identifier.optional(),
    snapshotVersion: identifier,
    artifactHash: sha.optional(),
    assessment: z
      .enum(["good", "bad", "cannot_import", "unspecified"])
      .optional(),
    sourceExpiresAt: z.iso.datetime().optional(),
  })
  .strict();
export const finishSchema = z
  .object({
    streams: z
      .array(
        z
          .object({
            windowInstanceId: identifier,
            lastSequence: z.number().int().min(-1).max(4095),
          })
          .strict(),
      )
      .max(16),
    reason: z.enum(["completed", "stopped", "crash_recovered"]),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail("REPLAY_INVALID");
  return result.data;
}
export function base64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return fail("REPLAY_INVALID");
  return Buffer.from(value, "base64");
}
export function eventsBytes(chunk: z.infer<typeof chunkSchema>): Buffer {
  let bytes: Buffer;
  try {
    bytes =
      chunk.encoding === "json"
        ? Buffer.from(JSON.stringify(chunk.events))
        : gunzipSync(base64(chunk.data ?? ""), {
            maxOutputLength: LIMITS.chunkBytes,
          });
  } catch {
    return fail("REPLAY_TOO_LARGE", 413);
  }
  if (bytes.length > LIMITS.chunkBytes) return fail("REPLAY_TOO_LARGE", 413);
  if (hash(bytes) !== chunk.contentHash) return fail("REPLAY_HASH_MISMATCH");
  let events: unknown;
  try {
    events = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("REPLAY_INVALID");
  }
  if (
    !Array.isArray(events) ||
    !events.length ||
    events.length > LIMITS.eventsPerChunk
  )
    return fail("REPLAY_INVALID");
  for (const e of events)
    if (
      !e ||
      typeof e !== "object" ||
      !Number.isFinite(e.timestamp) ||
      !Number.isInteger(e.type) ||
      e.type < 0 ||
      e.type > 5
    )
      return fail("REPLAY_INVALID");
  assertSafe(events);
  return bytes;
}
/** Defense in depth; recorder masking/exclusion remains necessary before bytes leave the app. */
export function assertSafe(value: unknown, depth = 0): void {
  if (depth > 80) return fail("REPLAY_INVALID");
  if (typeof value === "string") {
    if (
      /(?:Bearer\s+[\w.-]{12,}|eyJ[\w-]{8,}\.eyJ|(?:file:\/\/|\/(?:Users|home|private)\/|[A-Za-z]:\\)|[?&](?:token|password|secret|X-Amz-Signature)=)/i.test(
        value,
      )
    )
      fail("REPLAY_UNSAFE_CONTENT");
  } else if (Array.isArray(value))
    value.forEach((v) => assertSafe(v, depth + 1));
  else if (value && typeof value === "object")
    for (const [key, v] of Object.entries(value)) {
      if (
        /^(?:password|accessToken|refreshToken|deviceToken|authorization|cookie|localPath|fullPath|__TAURI_INTERNALS__)$/i.test(
          key,
        ) &&
        v
      )
        fail("REPLAY_UNSAFE_CONTENT");
      assertSafe(v, depth + 1);
    }
}
export interface ReplayPolicy {
  enabled: boolean;
  captureEnabled: boolean;
  cspEnabled: boolean;
  consentMode: string;
  environment: string;
}
export function checkPolicy(policy: ReplayPolicy, mode: string): void {
  if (!policy.enabled) fail("REPLAY_DISABLED", 403);
  if (
    mode !== policy.consentMode ||
    (mode === "assumed" &&
      !["development", "staging"].includes(policy.environment))
  )
    fail("REPLAY_AUTHORIZATION_DENIED", 403);
}
