/** Paired FBX + PNG from the same final artifact. No pose inference lives here. */
import { config } from "../config.js";
import {
  ConverterError,
  converterEnabled,
  EXPECTED_SOLVER_VERSION,
  sha256Hex,
  type ConverterDeps,
} from "./client.js";
import type { BodyScope } from "../output-scope/model.js";

export const FRAMING_VERSION = "skin-regions-v1";
const MAX_RESPONSE = 48 * 1024 * 1024;
export interface FramedArtifact {
  fbx: Uint8Array;
  preview: Uint8Array;
  conversionId: string;
  artifactSha256: string;
  sourceBvhSha256: string;
}
export interface FramedInput {
  bvhBytes: Uint8Array;
  characterId: string;
  scope: BodyScope;
  cameraRotation?: number[][];
  previewFormat?: "model";
  modelRevision?: string;
  characterSha256?: string;
}
function dependencies(overrides: Partial<ConverterDeps>): ConverterDeps {
  return {
    fetch,
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""),
    timeoutMs: config.converterTimeoutMs,
    defaultCharacterId: config.converterCharacterId,
    ...overrides,
  };
}
async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error("response too large");
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid response");
    return parsed as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function convertFramed(
  input: FramedInput,
  overrides: Partial<ConverterDeps> = {},
): Promise<FramedArtifact> {
  const deps = dependencies(overrides);
  if (!deps.baseUrl)
    throw new ConverterError("CONVERTER_DISABLED", "converter disabled");
  const digest = sha256Hex(input.bvhBytes);
  const body = new FormData();
  body.set(
    "bvh",
    new Blob([input.bvhBytes], { type: "application/octet-stream" }),
    "final.bvh",
  );
  body.set("character_id", input.characterId);
  body.set("output_scope", input.scope);
  body.set("preview_view", "front");
  if (input.previewFormat) body.set("preview_format", input.previewFormat);
  if (input.cameraRotation)
    body.set("camera_rotation", JSON.stringify(input.cameraRotation));
  body.set("expected_bvh_sha256", digest);
  let response: Response;
  try {
    response = await deps.fetch(`${deps.baseUrl}/convert-framed`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(
        Math.max(deps.timeoutMs, input.cameraRotation ? 300_000 : 0),
      ),
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name);
    throw new ConverterError(
      timeout ? "CONVERTER_TIMEOUT" : "CONVERTER_UNAVAILABLE",
      "framing unavailable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    const code =
      response.status === 504
        ? "CONVERTER_TIMEOUT"
        : response.status === 503
          ? "CONVERTER_UNAVAILABLE"
          : [400, 409, 413, 422].includes(response.status)
            ? "CONVERTER_REJECTED"
            : "CONVERTER_FAILED";
    throw new ConverterError(code, "framing failed", null, response.status);
  }
  try {
    const value = await boundedJson(response);
    const decode = (key: string) => {
      const encoded = value[key];
      if (
        typeof encoded !== "string" ||
        !encoded ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new Error(key);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error(key);
      return bytes;
    };
    const fbx = decode("fbx_base64"),
      preview = decode("preview_base64");
    if (
      (input.cameraRotation !== undefined &&
        JSON.stringify(value.camera_rotation) !==
          JSON.stringify(input.cameraRotation)) ||
      value.solver_version !== EXPECTED_SOLVER_VERSION ||
      value.framing_version !== FRAMING_VERSION ||
      value.output_scope !== input.scope ||
      value.preview_view !== "front" ||
      value.character_id !== input.characterId ||
      value.source_bvh_sha256 !== digest ||
      typeof value.character_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.character_sha256) ||
      typeof value.conversion_id !== "string" ||
      !value.conversion_id ||
      value.fbx_sha256 !== sha256Hex(fbx) ||
      value.preview_sha256 !== sha256Hex(preview) ||
      !fbx
        .subarray(0, 19)
        .equals(Buffer.from("Kaydara FBX Binary" + String.fromCharCode(32))) ||
      (input.previewFormat === "model"
        ? !validFinalModel(preview, input, digest, sha256Hex(fbx), value)
        : !preview
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    )
      throw new Error("lineage");
    return {
      fbx,
      preview,
      conversionId: value.conversion_id,
      artifactSha256: sha256Hex(fbx),
      sourceBvhSha256: digest,
    };
  } catch {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "framed artifact integrity mismatch",
    );
  }
}

function validFinalModel(
  data: Buffer,
  input: FramedInput,
  source: string,
  fbx: string,
  value: Record<string, unknown>,
) {
  if (
    data.length < 28 ||
    data.length > 8 * 1024 * 1024 ||
    data.readUInt32LE(0) !== 0x46546c67 ||
    data.readUInt32LE(4) !== 2 ||
    data.readUInt32LE(8) !== data.length ||
    data.readUInt32LE(16) !== 0x4e4f534a
  )
    return false;
  const size = data.readUInt32LE(12);
  if (size % 4 || size > 128 * 1024 || size + 28 > data.length) return false;
  const meta = JSON.parse(data.subarray(20, 20 + size).toString("utf8")).asset
    ?.extras;
  return (
    value.preview_format === "model" &&
    !!input.modelRevision &&
    !!input.characterSha256 &&
    value.preview_model_revision === input.modelRevision &&
    value.character_sha256 === input.characterSha256 &&
    meta?.version === "framed-mesh-v1" &&
    meta.revision === input.modelRevision &&
    meta.character_sha256 === input.characterSha256 &&
    meta.character_id === input.characterId &&
    meta.source_bvh_sha256 === source &&
    meta.base_fbx_sha256 === fbx &&
    meta.scope === input.scope &&
    meta.coordinates === "Y-up-hips-origin" &&
    JSON.stringify(meta.camera_rotation) ===
      JSON.stringify(input.cameraRotation ?? null) &&
    data.readUInt32LE(24 + size) === 0x004e4942 &&
    data.readUInt32LE(20 + size) + size + 28 === data.length
  );
}

let healthCache:
  | {
      expires: number;
      supported: boolean;
      revision?: string;
      hashes?: Record<string, string>;
    }
  | undefined;
export async function framingAvailable(
  overrides: Partial<ConverterDeps> = {},
): Promise<boolean> {
  if (!Object.keys(overrides).length && !converterEnabled()) return false;
  if (
    !Object.keys(overrides).length &&
    healthCache &&
    healthCache.expires > Date.now()
  )
    return healthCache.supported;
  let supported = false;
  let revision: string | undefined;
  let hashes: Record<string, string> | undefined;
  try {
    const deps = dependencies(overrides);
    const res = await deps.fetch(`${deps.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    const value = await boundedJson(res);
    const scopes = value.output_scopes;
    supported =
      res.ok &&
      value.ok === true &&
      value.solver_version === EXPECTED_SOLVER_VERSION &&
      value.framing_version === FRAMING_VERSION &&
      Array.isArray(scopes) &&
      ["full", "half", "bust", "head"].every((scope) => scopes.includes(scope));
    if (
      supported &&
      typeof value.preview_model_revision === "string" &&
      /^[a-f0-9]{64}$/.test(value.preview_model_revision) &&
      value.character_hashes &&
      typeof value.character_hashes === "object" &&
      !Array.isArray(value.character_hashes) &&
      Object.values(value.character_hashes).every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
      )
    ) {
      revision = value.preview_model_revision;
      hashes = value.character_hashes as Record<string, string>;
    }
  } catch {
    /* Old/offline converter: keep the feature closed. */
  }
  if (!Object.keys(overrides).length)
    healthCache = { expires: Date.now() + 30_000, supported, revision, hashes };
  return supported;
}

export async function modelPreviewIdentity(
  characterId = config.converterCharacterId,
) {
  if (!(await framingAvailable())) return null;
  const characterSha256 = healthCache?.hashes?.[characterId];
  return healthCache?.supported && healthCache.revision && characterSha256
    ? { modelRevision: healthCache.revision, characterSha256 }
    : null;
}

/** Bounded, process-local paired artifact cache. Authorize before every lookup. */
export class FramedArtifactCache {
  private entries = new Map<
    string,
    { expires: number; result: FramedArtifact; size: number }
  >();
  private pending = new Map<string, Promise<FramedArtifact>>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 128 * 1024 * 1024,
    private readonly ttlMs = 600_000,
    private readonly maxPending = 4,
  ) {}
  async get(
    key: string,
    create: () => Promise<FramedArtifact>,
  ): Promise<FramedArtifact> {
    for (const [id, entry] of this.entries)
      if (entry.expires <= Date.now()) this.remove(id);
    const hit = this.entries.get(key);
    if (hit) return hit.result;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= this.maxPending)
      throw new ConverterError("CONVERTER_UNAVAILABLE", "framing queue full");
    const promise = create()
      .then((result) => {
        const size = result.fbx.byteLength + result.preview.byteLength;
        while (this.bytes + size > this.maxBytes && this.entries.size)
          this.remove(this.entries.keys().next().value!);
        if (size <= this.maxBytes) {
          this.entries.set(key, {
            result,
            size,
            expires: Date.now() + this.ttlMs,
          });
          this.bytes += size;
        }
        return result;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
}
