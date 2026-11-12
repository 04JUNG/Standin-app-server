/** Private verified base FBX → immutable approved textured FBX. */
import { skinPreview, verifySkinPreviewAsset, type SkinPreview } from "../appearance/skin-preview.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { hash, InteractiveError, type Operation } from "../interactive-state/model.js";
import type { ResolvedSelection } from "../interactive-state/selection.js";
import type { SkinArtifacts } from "../interactive-state/service.js";
import { sha256Hex } from "./client.js";
import { reportConverterTiming, type ConverterTrace } from "./interactive-timing.js";
import { checkSkinContract, type SkinPolicy } from "../appearance/skin-contract.js";
import { MAX_SKIN_BYTES, parseTexturedArtifact, skinBinding } from "../appearance/skin-proof.js";
import { PrivateSkinStorage, type OutlineStorage } from "../appearance/storage.js";
import type { Skin } from "../appearance/skin.js";
import type { Appearance } from "../appearance/model.js";
interface SkinDeps {
  enabled(): boolean;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  timeoutMs: number;
  storage: OutlineStorage;
  /** Tests may supply synthetic protocol pins; runtime always uses the shipped approval. */
  policy?: SkinPolicy;
}
export function createSkinArtifacts(overrides: Partial<SkinDeps> = {}): SkinArtifacts {
  const deps: SkinDeps = { enabled: () => config.skinExportEnabled && !!config.betaDataBucket,
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""), token: config.interactiveConverterToken,
    fetch, timeoutMs: config.converterShapeTimeoutMs, storage: new PrivateSkinStorage(), ...overrides };
  const bounded = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(deps.timeoutMs), ...(signal ? [signal] : [])]);
  /** Idempotent reads reconnect once. Node 20's fetch can reuse a pooled socket that the Converter
   * (uvicorn, 5 s keep-alive) already closed and fail with ECONNRESET before any response arrives. */
  async function read(path: string, route: string, signal?: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      try { return await deps.fetch(`${deps.baseUrl}${path}`, { headers: { Authorization: `Bearer ${deps.token}` }, signal: bounded(signal) }); }
      catch (error) {
        if (signal?.aborted || (error as { name?: unknown })?.name === "TimeoutError" || attempt >= 2) throw error;
        const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
        log.warn({ type: "skin_converter_read_retry", route, errorCode: typeof cause === "string" ? cause : "FETCH_FAILED" });
      }
    }
  }
  async function request(path: "/skin-contract" | "/skin-fbx", signal?: AbortSignal, body?: FormData, trace?: ConverterTrace) {
    if (!deps.enabled() || !deps.baseUrl || deps.token.length < 32) throw new InteractiveError("SKIN_DISABLED", 503);
    let response: Response;
    const startedAt = performance.now();
    try { response = body ? await deps.fetch(`${deps.baseUrl}${path}`, { method: "POST",
      headers: { Authorization: `Bearer ${deps.token}` }, body, signal: bounded(signal) }) : await read(path, path, signal); }
    catch {
      reportConverterTiming(trace, startedAt);
      throw new InteractiveError(signal?.aborted ? "INTERACTIVE_SUPERSEDED" : "SKIN_UNAVAILABLE", signal?.aborted ? 409 : 503);
    }
    const headersMs = performance.now() - startedAt;
    const reader = response.body?.getReader();
    if (!reader) {
      reportConverterTiming(trace, startedAt, response, headersMs);
      throw new InteractiveError("SKIN_UNAVAILABLE", 503);
    }
    const cap = path === "/skin-contract" ? 128 * 1024 : response.ok ? 42 * 1024 * 1024 : 16384;
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > cap) throw new InteractiveError("SKIN_INTEGRITY_ERROR"); chunks.push(value); }
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) !== size)) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) {
        const code = (raw as { error?: { code?: unknown } })?.error?.code;
        const allowed = ["INVALID_SKIN", "SKIN_DEFAULT_USE_LEGACY", "SOURCE_FBX_SHA256_MISMATCH", "SKIN_BINDING_MISMATCH",
          "SKIN_UNSUPPORTED", "SKIN_UV_INCOMPATIBLE", "SKIN_OUTLINE_ORDER", "SKIN_DISABLED", "SKIN_NOT_CSP_CERTIFIED",
          "SKIN_ASSETS_UNAVAILABLE", "SKIN_INTEGRITY_ERROR", "SKIN_TIMEOUT"];
        throw new InteractiveError(typeof code === "string" && allowed.includes(code) ? code : "SKIN_UNAVAILABLE", response.status >= 500 ? 503 : 409);
      }
      return raw;
    } catch (e) { if (e instanceof InteractiveError) throw e; throw new InteractiveError("SKIN_INTEGRITY_ERROR"); }
    finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      reportConverterTiming(trace, startedAt, response, headersMs, size);
    }
  }
  async function context(selection: ResolvedSelection, skin?: Skin, appearance?: Appearance, signal?: AbortSignal) {
    return checkSkinContract(await request("/skin-contract", signal), selection, skin, appearance, deps.policy);
  }
  const assets = new Map<string, Uint8Array>();
  async function readAsset(digest: string, expectedBytes: number, signal?: AbortSignal) {
    if (assets.has(digest)) return assets.get(digest)!;
    let response: Response;
    try { response = await read(`/skin-assets/${digest}`, "/skin-assets/:digest", signal); }
    catch { throw new InteractiveError(signal?.aborted ? "INTERACTIVE_SUPERSEDED" : "SKIN_UNAVAILABLE", signal?.aborted ? 409 : 503); }
    const reader = response.body?.getReader();
    if (!reader) throw new InteractiveError("SKIN_ASSETS_UNAVAILABLE", 503);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (!response.ok || response.headers.get("X-Skin-Asset-SHA256") !== digest) throw new InteractiveError("SKIN_ASSETS_UNAVAILABLE", 503);
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > expectedBytes || size > 16 * 1024 * 1024) throw new InteractiveError("SKIN_INTEGRITY_ERROR"); chunks.push(value); }
      const advertised = response.headers.get("content-length");
      if (size !== expectedBytes || (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) !== size)))
        throw new InteractiveError("SKIN_INTEGRITY_ERROR");
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  /** Exact pinned bytes, cached once verified. Callers still fence every response with a fresh
   * approval; a failed fence must not force another download and structure check on retry. */
  async function verifiedAsset(preview: SkinPreview, digest: string, signal?: AbortSignal) {
    const pin = digest === preview.uv.sha256 ? preview.uv : digest === preview.texture.sha256 ? preview.texture : undefined;
    if (!pin) throw new InteractiveError("NOT_FOUND", 404);
    const bytes = await readAsset(digest, pin.bytes, signal);
    const contentType = await verifySkinPreviewAsset(preview, digest, bytes);
    if (!assets.has(digest)) { if (assets.size >= 8) assets.delete(assets.keys().next().value!); assets.set(digest, bytes); }
    return { bytes, contentType };
  }
  return {
    async previewAsset(selection, skin, digest, signal) {
      const current = await context(selection, skin, undefined, signal);
      const asset = await verifiedAsset(skinPreview(current.context, selection.characterId), digest, signal);
      const fresh = await context(selection, skin, undefined, signal);
      if (fresh.approval.identity !== current.approval.identity) throw new InteractiveError("SKIN_BINDING_MISMATCH");
      return asset;
    },
    async asset(op, selection, digest, signal) {
      const current = await context(selection, op.skin, op.appearance, signal), preview = skinPreview(current.context, selection.characterId);
      if (!op.skinPreview || hash(op.skinPreview) !== hash(preview)) throw new InteractiveError("SKIN_BINDING_MISMATCH");
      const asset = await verifiedAsset(preview, digest, signal);
      const fresh = await context(selection, op.skin, op.appearance, signal);
      if (fresh.approval.identity !== current.approval.identity) throw new InteractiveError("SKIN_BINDING_MISMATCH");
      return asset;
    },
    async check(selection, skin, appearance) { return (await context(selection, skin, appearance)).approval; },
    async prepare(op, selection, source, signal) {
      const current = await context(selection, op.skin, op.appearance, signal), binding = skinBinding(op, selection, current.context);
      if (source.length > MAX_SKIN_BYTES || sha256Hex(source) !== op.receipt?.artifactSha256 ||
        !Buffer.from(source.subarray(0, 23)).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0"))) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
      let raw = await deps.storage.load(op, binding);
      if (!raw) {
        const body = new FormData();
        body.set("fbx", new Blob([source], { type: "application/octet-stream" }), "source.fbx");
        body.set("source_artifact_sha256", String(op.receipt!.artifactSha256)); body.set("skin", JSON.stringify(op.skin));
        body.set("character_id", selection.characterId); body.set("character_sha256", selection.body.resolvedBody!.assetSha256);
        body.set("output_scope", selection.scope); body.set("binding_sha256", binding);
        raw = await request("/skin-fbx", signal, body, { op, phase: "skin" });
        parseTexturedArtifact(raw, op, selection, current.context);
        if (signal.aborted) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
        const fresh = await context(selection, op.skin, op.appearance, signal);
        if (skinBinding(op, selection, fresh.context) !== binding) throw new InteractiveError("SKIN_BINDING_MISMATCH");
        raw = await deps.storage.publish(op, binding, raw);
      }
      return parseTexturedArtifact(raw, op, selection, current.context).receipt;
    },
    async file(op, selection, signal) {
      const current = await context(selection, op.skin, op.appearance, signal), binding = skinBinding(op, selection, current.context);
      if (op.skinReceipt?.bindingSha256 !== binding) throw new InteractiveError("SKIN_BINDING_MISMATCH");
      const raw = await deps.storage.load(op, binding);
      if (!raw) throw new InteractiveError("INTERACTIVE_EXPIRED", 410);
      const parsed = parseTexturedArtifact(raw, op, selection, current.context);
      if (hash(parsed.receipt) !== hash(op.skinReceipt)) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
      const fresh = await context(selection, op.skin, op.appearance, signal);
      if (skinBinding(op, selection, fresh.context) !== binding) throw new InteractiveError("SKIN_BINDING_MISMATCH");
      return parsed.bytes;
    },
  };
}
