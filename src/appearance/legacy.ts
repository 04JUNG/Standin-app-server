/** Legacy file formats never silently discard requested appearance. */
import { appearanceSchema, nonzeroAppearance, outlineMessage } from "./model.js";
import { skinSchema, nondefaultSkin, skinMessage } from "./skin.js";
import { errorEnvelope } from "../mapping.js";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
type AppearanceError = "INVALID_OUTLINE" | "OUTLINE_UNSUPPORTED" | "INVALID_SKIN" | "SKIN_UNSUPPORTED";
function fieldError(key: string, value: unknown): AppearanceError | undefined {
  if (/^skin/i.test(key)) {
    const parsed = key === "skin" ? skinSchema.safeParse(value) : undefined;
    if (!parsed?.success) return "INVALID_SKIN";
    if (nondefaultSkin(parsed.data)) return "SKIN_UNSUPPORTED";
  } else if (/^(outline|appearance)/i.test(key)) {
    const parsed = key === "appearance" ? appearanceSchema.safeParse(value) : undefined;
    if (!parsed?.success) return "INVALID_OUTLINE";
    if (nonzeroAppearance(parsed.data)) return "OUTLINE_UNSUPPORTED";
  }
}
export function legacyAppearanceError(c: Context<AppEnv>) {
  for (const key of Object.keys(c.req.query())) {
    if (!/^(outline|appearance|skin)/i.test(key)) continue;
    const raw = c.req.queries(key); let value: unknown;
    try { value = raw?.length === 1 ? JSON.parse(raw[0]) : null; } catch { value = null; }
    const code = fieldError(key, value);
    if (code) return c.json(errorEnvelope(code, code.includes("SKIN") ? skinMessage(code) : outlineMessage(code), c.get("requestId")), code.startsWith("INVALID") ? 400 : 409);
  }
}
/** Check explicit root/person fields without changing the established scene contract. */
export function unsupportedSceneAppearance(value: unknown): AppearanceError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(object)) {
    const error = fieldError(key, item);
    if (error) return error;
  }
  if (Array.isArray(object.persons)) {
    for (const person of object.persons) {
      const error = unsupportedSceneAppearance(person);
      if (error) return error;
    }
  }
}
