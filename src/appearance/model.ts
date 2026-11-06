/** Logical UI width; conversion to physical geometry belongs to Converter. */
import { z } from "zod";
export const appearanceSchema = z.object({
  version: z.literal("fbx-outline-v1"),
  width: z.number().finite().min(0).max(2),
}).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export function nonzeroAppearance(value?: Appearance): Appearance | undefined {
  return value && value.width > 0 ? value : undefined;
}
export const outlineMessage = (code: string) => code === "OUTLINE_UNSUPPORTED"
  ? "이 저장 형식은 외곽선을 아직 지원하지 않아요."
  : "외곽선 파일을 준비하지 못했어요. 다시 시도해 주세요.";
