import type { Appearance } from "../appearance/model.js";
/** Existing verified individual FBX -> private, separately certified appearance postprocess. */
import { OUTLINE_SUPPORT } from "../appearance/support.js";
import { config } from "../config.js";
import { loadBodyCatalog } from "../body-selection/catalog.js";
import { sameShapeSource } from "../body-selection/shape.js";
import { hash, InteractiveError, type Operation } from "../interactive-state/model.js";
import type { ResolvedSelection } from "../interactive-state/selection.js";
import type { OutlineArtifacts } from "../interactive-state/service.js";
import { sha256Hex } from "./client.js";
import { checkContract, outlineBinding, parseOutlinedArtifact, MAX_OUTLINE_BYTES } from "../appearance/contract.js";
import { PrivateOutlineStorage, type OutlineStorage } from "../appearance/storage.js";
export function resolvedStature(selection: ResolvedSelection): number {
  const asset = loadBodyCatalog().assets.find(a => a.characterId === selection.characterId &&
    a.assetSha256 === selection.body.resolvedBody?.assetSha256);
  const control = asset?.shape?.controls.find(c => c.key === "height");
  if (!selection.body.shape && !control) {
    const current = Object.entries(OUTLINE_SUPPORT).find(([id, value]) =>
      id === selection.characterId && value.sha256 === selection.body.resolvedBody?.assetSha256)?.[1];
    if (current) return current.statureM;
    // Published converter release-manifest metadata, pinned by bytes rather than model names.
    const baseline = new Set([
      "809a131510434089888429605bf7cd2e3bc75b63109e4ac5c9734b211ee52365",
      "e6947d8e2aeb1014e9505a61d2f42e6bd9d34965cc7bb3a6c2fcd2722d4f280a",
    ]);
    if (baseline.has(selection.body.resolvedBody?.assetSha256 ?? "")) return 1.75;
  }
  if (!asset || !control || (selection.body.shape && !sameShapeSource(asset.shapeSource, selection.body.shapeSource)))
    throw new InteractiveError("OUTLINE_UNSUPPORTED");
  // body-shape.v1 height is the approved centimetre control, including its default for a plain asset.
  const cm = selection.body.shape?.controls.height ?? control.default;
  if (!Number.isFinite(cm) || cm < control.min || cm > control.max || cm < 100 || cm > 250)
    throw new InteractiveError("OUTLINE_UNSUPPORTED");
  return cm / 100;
}
interface OutlineDeps {
  enabled(): boolean;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  timeoutMs: number;
  storage: OutlineStorage;
  stature(selection: ResolvedSelection): number;
}
export function createOutlineArtifacts(overrides: Partial<OutlineDeps> = {}): OutlineArtifacts {
  const deps: OutlineDeps = { enabled: () => config.outlineExportEnabled && !!config.betaDataBucket,
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""), token: config.interactiveConverterToken,
    fetch, timeoutMs: config.converterShapeTimeoutMs, storage: new PrivateOutlineStorage(), stature: resolvedStature, ...overrides };
  async function request(path: string, signal?: AbortSignal, body?: FormData) {
    if (!deps.enabled() || !deps.baseUrl || deps.token.length < 32) throw new InteractiveError("OUTLINE_DISABLED", 503);
    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}${path}`, { method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${deps.token}` }, ...(body ? { body } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(deps.timeoutMs), ...(signal ? [signal] : [])]) });
    } catch { throw new InteractiveError(signal?.aborted ? "INTERACTIVE_SUPERSEDED" : "OUTLINE_UNAVAILABLE", signal?.aborted ? 409 : 503); }
    const reader = response.body?.getReader();
    if (!reader) throw new InteractiveError("OUTLINE_UNAVAILABLE", 503);
    const cap = path === "/outline-contract" ? 16384 : response.ok ? 42 * 1024 * 1024 : 16384;
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > cap) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
        chunks.push(value);
      }
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) !== size)) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) {
        const code = (raw as { error?: { code?: unknown } })?.error?.code;
        const allowed = ["INVALID_OUTLINE", "SOURCE_FBX_SHA256_MISMATCH", "OUTLINE_BINDING_MISMATCH", "OUTLINE_UNSUPPORTED", "OUTLINE_DISABLED", "OUTLINE_NOT_CSP_CERTIFIED", "OUTLINE_INTEGRITY_ERROR", "OUTLINE_TIMEOUT"];
        throw new InteractiveError(typeof code === "string" && allowed.includes(code) ? code : "OUTLINE_UNAVAILABLE", response.status >= 500 ? 503 : 409);
      }
      return raw;
    } catch (e) {
      if (e instanceof InteractiveError) throw e;
      throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function context(selection: ResolvedSelection, signal?: AbortSignal, appearance?: Appearance) {
    const contract = checkContract(await request("/outline-contract", signal), selection, appearance?.width), stature = deps.stature(selection);
    if (!Number.isFinite(stature) || stature < 1 || stature > 2.5) throw new InteractiveError("OUTLINE_UNSUPPORTED");
    return { contract, stature };
  }
  return {
    async check(selection, appearance) { await context(selection, undefined, appearance); },
    async prepare(op, selection, source, signal) {
      const { contract, stature } = await context(selection, signal, op.appearance), binding = outlineBinding(op, selection, stature, contract);
      if (source.length > MAX_OUTLINE_BYTES || sha256Hex(source) !== op.receipt!.artifactSha256 ||
          !Buffer.from(source.subarray(0, 23)).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")))
        throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
      let raw = await deps.storage.load(op, binding);
      if (!raw) {
        const body = new FormData();
        body.set("fbx", new Blob([source], { type: "application/octet-stream" }), "source.fbx");
        body.set("source_artifact_sha256", String(op.receipt!.artifactSha256));
        body.set("appearance", JSON.stringify(op.appearance)); body.set("output_scope", selection.scope);
        body.set("character_id", selection.characterId); body.set("character_sha256", selection.body.resolvedBody!.assetSha256);
        body.set("binding_sha256", binding); body.set("stature_m", String(stature));
        raw = await request("/outline-fbx", signal, body);
        parseOutlinedArtifact(raw, op, selection, stature, contract);
        if (signal.aborted) throw new InteractiveError("INTERACTIVE_SUPERSEDED");
        const fresh = await context(selection, signal, op.appearance);
        if (outlineBinding(op, selection, fresh.stature, fresh.contract) !== binding) throw new InteractiveError("OUTLINE_BINDING_MISMATCH");
        raw = await deps.storage.publish(op, binding, raw);
      }
      return parseOutlinedArtifact(raw, op, selection, stature, contract).receipt;
    },
    async file(op, selection, signal) {
      const { contract, stature } = await context(selection, signal, op.appearance), binding = outlineBinding(op, selection, stature, contract);
      if (op.outlineReceipt?.bindingSha256 !== binding) throw new InteractiveError("OUTLINE_BINDING_MISMATCH");
      const raw = await deps.storage.load(op, binding);
      if (!raw) throw new InteractiveError("INTERACTIVE_EXPIRED", 410);
      const parsed = parseOutlinedArtifact(raw, op, selection, stature, contract);
      if (hash(parsed.receipt) !== hash(op.outlineReceipt)) throw new InteractiveError("OUTLINE_INTEGRITY_ERROR");
      const fresh = await context(selection, signal, op.appearance);
      if (outlineBinding(op, selection, fresh.stature, fresh.contract) !== binding) throw new InteractiveError("OUTLINE_BINDING_MISMATCH");
      return parsed.bytes;
    },
  };
}
