/** Legacy file formats never silently discard requested appearance. */
import { appearanceSchema, outlineMessage } from "./model.js";
import { errorEnvelope } from "../mapping.js";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
export function legacyAppearanceError(c: Context<AppEnv>) {
  const query = c.req.query();
  if (Object.keys(query).some(k => /^(outline|appearance)/i.test(k) && k !== "appearance"))
    return c.json(errorEnvelope("INVALID_OUTLINE", outlineMessage("INVALID_OUTLINE"), c.get("requestId")), 400);
  const raw = c.req.queries("appearance");
  if (!raw) return;
  let value: unknown;
  try { value = raw.length === 1 ? JSON.parse(raw[0]) : null; } catch { value = null; }
  const parsed = appearanceSchema.safeParse(value);
  if (!parsed.success)
    return c.json(errorEnvelope("INVALID_OUTLINE", outlineMessage("INVALID_OUTLINE"), c.get("requestId")), 400);
  if (parsed.data.width > 0)
    return c.json(errorEnvelope("OUTLINE_UNSUPPORTED", outlineMessage("OUTLINE_UNSUPPORTED"), c.get("requestId")), 409);
}
/** Check explicit root/person fields without changing the established scene contract. */
export function unsupportedSceneAppearance(value: unknown): "INVALID_OUTLINE" | "OUTLINE_UNSUPPORTED" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (/^(outline|appearance)/i.test(key)) {
      if (key !== "appearance") return "INVALID_OUTLINE";
      const parsed = appearanceSchema.safeParse(object[key]);
      if (!parsed.success) return "INVALID_OUTLINE";
      if (parsed.data.width > 0) return "OUTLINE_UNSUPPORTED";
    }
  }
  if (Array.isArray(object.persons)) {
    for (const person of object.persons) {
      const error = unsupportedSceneAppearance(person);
      if (error) return error;
    }
  }
}
