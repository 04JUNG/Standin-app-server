/** Approved neutral UV/texture overlay metadata; canonical model bytes stay unchanged. */
import { Worker } from "node:worker_threads";
import { hash, InteractiveError } from "../interactive-state/model.js";
import { sha256Hex } from "../converter/client.js";
import { log } from "../log.js";
import type { SkinContext } from "./skin-proof.js";
import type { SkinUvPin } from "./skin-uv.js";
import { triangleIndexJson, type SolvedModelV2 } from "../interactive-state/shared/interactive_pose_v2.mjs";
export interface SkinPreview {
  schema: "skin-preview-v1";
  skin: SkinContext["skin"];
  assetVersion: string;
  assetManifestSha256: string;
  compatibility: { characterId: string; characterSha256: string; previewMesh: string; vertices: number;
    bones: number; polygonIndicesSha256: string; weightsSha256: string; trianglesSha256: string };
  uv: { sha256: string; bytes: number };
  texture: { sha256: string; bytes: number };
}
export function skinPreview(context: SkinContext, characterId: string): SkinPreview {
  const a = context.asset, texture = a.previewTextures[context.skin.id];
  if (!texture) throw new InteractiveError("SKIN_UNSUPPORTED");
  return { schema: "skin-preview-v1", skin: context.skin, assetVersion: context.assetVersion,
    assetManifestSha256: context.assetManifestSha256,
    compatibility: { characterId, characterSha256: a.characterSha256, previewMesh: a.previewMesh, vertices: a.vertices,
      bones: a.bones, polygonIndicesSha256: a.polygonIndicesSha256, weightsSha256: a.weightsSha256, trianglesSha256: a.trianglesSha256 },
    uv: { sha256: a.uvSha256, bytes: a.uvBytes }, texture };
}
export function checkSkinPreviewModel(preview: SkinPreview | undefined, model: { meshes: { name: string; positions: unknown[]; triangles: number[][] }[]; bones: unknown[] }) {
  if (!preview) return;
  const pin = preview.compatibility, mesh = model.meshes[0];
  if (model.meshes.length !== 1 || !mesh || mesh.name !== pin.previewMesh || mesh.positions.length !== pin.vertices ||
    model.bones.length !== pin.bones || hash(mesh.triangles) !== pin.trianglesSha256)
    throw new InteractiveError("SKIN_UV_INCOMPATIBLE");
}
/** Same pin for binary states: triangleIndexJson(triangles) is the canonical JSON the v1 `hash` digests. */
export function checkSkinPreviewBinaryModel(preview: SkinPreview | undefined, model: SolvedModelV2) {
  if (!preview) return;
  const pin = preview.compatibility, mesh = model.meshes[0];
  if (model.meshes.length !== 1 || !mesh || mesh.name !== pin.previewMesh || mesh.vertexCount !== pin.vertices ||
    model.bones.length !== pin.bones ||
    sha256Hex(Buffer.from(triangleIndexJson(mesh.triangles), "ascii")) !== pin.trianglesSha256)
    throw new InteractiveError("SKIN_UV_INCOMPATIBLE");
}
type UvVerdict = "ok" | "invalid" | "unavailable";
/** Structure verdicts for exact pinned bytes. Sound because every call re-checks length and SHA-256
 * against the pin before consulting it; transient worker failures are never remembered. */
const uvVerdicts = new Map<string, "ok" | "invalid">();
const uvPending = new Map<string, Promise<UvVerdict>>();
let uvQueue: Promise<unknown> = Promise.resolve(), uvRuns = 0;
/** Off-thread UV structure checks this process has started (observability and tests). */
export const skinUvVerificationRuns = () => uvRuns;
function checkUvOffThread(bytes: Uint8Array, pin: SkinUvPin): Promise<UvVerdict> {
  uvRuns++;
  const started = performance.now();
  return new Promise<UvVerdict>(resolve => {
    let worker: Worker | undefined, settled = false;
    const done = (verdict: UvVerdict) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker?.terminate().catch(() => {});
      log.info({ type: "skin_uv_verification", durationMs: performance.now() - started, verdict, payloadBytes: bytes.length });
      resolve(verdict);
    };
    const timer = setTimeout(() => done("unavailable"), 120_000);
    try {
      // Private copy: never detach the caller's (or the asset cache's) buffer.
      const copy = Uint8Array.from(bytes);
      worker = new Worker(new URL("./skin-uv-worker.js", import.meta.url), { workerData: { bytes: copy, pin },
        // The 139k-vertex male UV passes within 128 MB; 2x headroom keeps the 1 GB task safe.
        transferList: [copy.buffer], resourceLimits: { maxOldGenerationSizeMb: 256 } });
      worker.once("message", (m: { ok?: unknown }) => done(m?.ok === true ? "ok" : "invalid"));
      worker.once("error", () => done("unavailable"));
      worker.once("exit", () => done("unavailable"));
    } catch { done("unavailable"); }
  });
}
function verifyUv(digest: string, bytes: Uint8Array, pin: SkinUvPin): Promise<UvVerdict> {
  const key = [digest, pin.characterSha256, pin.vertices, pin.trianglesSha256].join(":");
  const known = uvVerdicts.get(key);
  if (known) return Promise.resolve(known);
  let pending = uvPending.get(key);
  if (!pending) {
    // One check at a time: each decodes ~40 MB of JSON and the BFF task has 1 GB in total.
    const run = uvQueue.then(() => checkUvOffThread(bytes, pin));
    uvQueue = run;
    pending = run.then(verdict => {
      if (verdict !== "unavailable") { if (uvVerdicts.size >= 64) uvVerdicts.clear(); uvVerdicts.set(key, verdict); }
      return verdict;
    }).finally(() => uvPending.delete(key));
    uvPending.set(key, pending);
  }
  return pending;
}
/** Exact pinned bytes. The UV structure check (all former schema rules, `skin-uv.ts`) runs in a
 * worker once per pinned digest, so a 9 MB UV never holds the HTTP event loop. */
export async function verifySkinPreviewAsset(preview: SkinPreview, digest: string, bytes: Uint8Array) {
  const pin = digest === preview.uv.sha256 ? preview.uv : digest === preview.texture.sha256 ? preview.texture : undefined;
  if (!pin || bytes.length !== pin.bytes || sha256Hex(bytes) !== digest) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
  if (digest === preview.texture.sha256) {
    const png = Buffer.from(bytes);
    if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.subarray(12, 16).toString("ascii") !== "IHDR" || png.readUInt32BE(16) < 1 || png.readUInt32BE(20) < 1 ||
      png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) > 2048) throw new InteractiveError("SKIN_INTEGRITY_ERROR");
    return "image/png";
  }
  const c = preview.compatibility;
  const verdict = await verifyUv(digest, bytes, { characterSha256: c.characterSha256, vertices: c.vertices, trianglesSha256: c.trianglesSha256 });
  if (verdict === "unavailable") throw new InteractiveError("SKIN_UNAVAILABLE", 503);
  if (verdict !== "ok") throw new InteractiveError("SKIN_INTEGRITY_ERROR");
  return "application/gzip";
}
