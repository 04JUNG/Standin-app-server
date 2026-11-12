/** Immutable catalog choice. Asset paths and UVs are owned by Converter. */
import { z } from "zod";
export const skinSchema = z.object({
  version: z.literal("fbx-skin-v1"),
  id: z.enum(["default", "gray-guide", "flesh", "flesh-guide", "muscle"]),
}).strict();
export type Skin = z.infer<typeof skinSchema>;
export function nondefaultSkin(value?: Skin): Skin | undefined {
  return value && value.id !== "default" ? value : undefined;
}
export const skinMessage = (code: string) => code === "SKIN_UNSUPPORTED" || code === "SKIN_UV_INCOMPATIBLE"
  ? "이 저장 형식은 선택한 스킨을 아직 지원하지 않아요."
  : "스킨 파일을 준비하지 못했어요. 다시 시도해 주세요.";
