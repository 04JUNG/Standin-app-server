/** Approved UV overlay structure: the exact rules of the former zod schema, checked in one pass.
 *
 * A schema parse deep-copied ~1.1M tuples of the 139k-vertex male UV (+~235 MB heap). On the
 * 0.5 vCPU production BFF that held the event loop ~10 s per request, so the follow-up Converter
 * read reused a socket uvicorn had already closed (ECONNRESET → SKIN_UNAVAILABLE). This module
 * keeps every rule; `skin-uv-worker.ts` runs it off the HTTP event loop. */
import { gunzipSync } from "node:zlib";
import { hash } from "../interactive-state/model.js";

export interface SkinUvPin { characterSha256: string; vertices: number; trianglesSha256: string }

const MAX_UV = 1_000_000, MAX_TRIANGLES = 333_333;
const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const index = (v: unknown, vertices: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < vertices;

/** Throws on any deviation; returns nothing so decoded geometry is never handed back. */
export function checkSkinUv(bytes: Uint8Array, pin: SkinUvPin): void {
  const raw: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("UV root");
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !["source_sha256", "uv", "triangles"].every(k => keys.includes(k))) throw new Error("UV keys");
  const { source_sha256, uv, triangles } = raw as Record<string, unknown>;
  if (source_sha256 !== pin.characterSha256) throw new Error("UV source");
  if (!Array.isArray(uv) || uv.length < 3 || uv.length > MAX_UV) throw new Error("UV corners");
  for (const c of uv)
    if (!Array.isArray(c) || c.length !== 2 || !unit(c[0]) || !unit(c[1])) throw new Error("UV corner");
  if (!Array.isArray(triangles) || triangles.length < 1 || triangles.length > MAX_TRIANGLES ||
    uv.length !== triangles.length * 3) throw new Error("UV triangles");
  for (const t of triangles)
    if (!Array.isArray(t) || t.length !== 3 || !index(t[0], pin.vertices) || !index(t[1], pin.vertices) || !index(t[2], pin.vertices))
      throw new Error("UV triangle");
  if (hash(triangles) !== pin.trianglesSha256) throw new Error("UV topology");
}
