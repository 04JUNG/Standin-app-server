/** Immutable catalog choice. Asset paths and UVs are owned by Converter. */
import { z } from "zod";
import type { BodyScope } from "../output-scope/model.js";
export const skinSchema = z.object({
  version: z.literal("fbx-skin-v1"),
  id: z.enum(["default", "gray-guide", "flesh", "flesh-guide", "muscle", "flesh-muscle"]),
}).strict();
export type Skin = z.infer<typeof skinSchema>;
export function nondefaultSkin(value?: Skin): Skin | undefined {
  return value && value.id !== "default" ? value : undefined;
}
export const skinMessage = (code: string) => code === "SKIN_UNSUPPORTED" || code === "SKIN_UV_INCOMPATIBLE"
  ? "이 저장 형식은 선택한 스킨을 아직 지원하지 않아요."
  : "스킨 파일을 준비하지 못했어요. 다시 시도해 주세요.";
/** Approved skin assets and CSP evidence cover only uncropped full meshes. The Converter crops every
 * other output scope (`converter/framing.py::crop_meshes`), so its vertices never match the pinned UV. */
export const skinSupportsScope = (scope: BodyScope) => scope === "full";
const UNAVAILABLE_CODES = ["SKIN_UNSUPPORTED", "SKIN_UV_INCOMPATIBLE", "SKIN_DISABLED", "SKIN_NOT_CSP_CERTIFIED",
  "SKIN_ASSETS_UNAVAILABLE", "SKIN_UNAVAILABLE", "SKIN_INTEGRITY_ERROR"] as const;
/** Why the owned head reports `skinExport.available=false`. `outputScope` is present only when the
 * cropped output scope is the reason, so clients can offer the default skin instead of a retry. */
export interface SkinUnavailable {
  code: (typeof UNAVAILABLE_CODES)[number];
  outputScope?: BodyScope;
}
/** Only known skin codes reach clients; anything else (transport, abort, bugs) reads as transient. */
export function skinUnavailableCode(error: unknown): SkinUnavailable["code"] {
  const code = (error as { code?: unknown } | null)?.code;
  return UNAVAILABLE_CODES.find(known => known === code) ?? "SKIN_UNAVAILABLE";
}
