import { bodyUxAvailable } from "./availability.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { errorEnvelope } from "../mapping.js";
import { ConverterError } from "../converter/client.js";
import {
  BodyError,
  bodyStore,
  type CardChange,
  type PreferenceChange,
  type SelectionChange,
} from "./store.js";
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new BodyError("INVALID_INPUT", 400);
  return v as Record<string, unknown>;
}
function mutation(v: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(v.expectedRevision) ||
    Number(v.expectedRevision) < 0 ||
    typeof v.mutationId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(v.mutationId)
  )
    throw new BodyError("INVALID_INPUT", 400);
}
function only(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new BodyError("INVALID_INPUT", 400);
}
const id = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;
export function parsePreferenceChange(raw: unknown): PreferenceChange {
  const v = obj(raw);
  mutation(v);
  only(v, ["mode", "expectedRevision", "mutationId"]);
  if (!["auto", "last_used"].includes(String(v.mode)))
    throw new BodyError("INVALID_INPUT", 400);
  return v as unknown as PreferenceChange;
}
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Envelope only; names, bodies and controls are checked against the catalog in the store. */
export function parseCardChange(
  op: CardChange["op"],
  raw: unknown,
  cardId?: string,
): CardChange {
  const v = obj(raw);
  mutation(v);
  const base = {
    expectedRevision: v.expectedRevision as number,
    mutationId: v.mutationId as string,
  };
  const controls = (c: unknown) =>
    !!c && typeof c === "object" && !Array.isArray(c);
  if (op !== "create" && !(cardId && CARD_ID.test(cardId)))
    throw new BodyError("INVALID_INPUT", 400);
  if (op === "create") {
    only(v, ["name", "characterId", "controls", "expectedRevision", "mutationId"]);
    if (typeof v.name !== "string" || !id(v.characterId) || !controls(v.controls))
      throw new BodyError("INVALID_INPUT", 400);
    return { ...base, op, name: v.name, characterId: v.characterId, controls: v.controls };
  }
  if (op === "update") {
    only(v, ["name", "characterId", "controls", "expectedRevision", "mutationId"]);
    if (
      ("name" in v && typeof v.name !== "string") ||
      ("characterId" in v && !id(v.characterId)) ||
      ("controls" in v && !controls(v.controls)) ||
      !["name", "characterId", "controls"].some((k) => k in v)
    )
      throw new BodyError("INVALID_INPUT", 400);
    return {
      ...base,
      op,
      cardId: cardId!,
      ...("name" in v ? { name: v.name as string } : {}),
      ...("characterId" in v ? { characterId: v.characterId as string } : {}),
      ...("controls" in v ? { controls: v.controls } : {}),
    };
  }
  only(v, ["expectedRevision", "mutationId"]);
  return { ...base, op, cardId: cardId! };
}
export function parseSelectionChange(raw: unknown): SelectionChange {
  const v = obj(raw);
  mutation(v);
  only(v, ["intent", "characterId", "shape", "expectedRevision", "mutationId"]);
  if (
    !["inherit", "auto", "manual"].includes(String(v.intent)) ||
    (v.intent === "manual" ? !id(v.characterId) : "characterId" in v)
  )
    throw new BodyError("INVALID_INPUT", 400);
  if ("shape" in v) {
    const shape = v.shape as Record<string, unknown> | null;
    if (
      v.intent !== "manual" ||
      !shape ||
      typeof shape !== "object" ||
      Array.isArray(shape) ||
      Object.keys(shape).some((k) => k !== "controls") ||
      !shape.controls ||
      typeof shape.controls !== "object" ||
      Array.isArray(shape.controls)
    )
      throw new BodyError("INVALID_INPUT", 400);
  }
  return v as unknown as SelectionChange;
}
function base(enabled: () => boolean, paths: string[] = ["*"]) {
  const app = new Hono<AppEnv>();
  for (const path of paths)
    app.use(path, async (c, next) => {
      if (!enabled())
        return c.json(
          errorEnvelope(
            "BODY_SELECTION_DISABLED",
            "체형 선택 저장이 비활성화되어 있습니다.",
            c.get("requestId"),
          ),
          503,
        );
      await next();
    });
  app.onError((e, c) => {
    if (e instanceof BodyError)
      return c.json(
        errorEnvelope(
          e.code,
          "체형 설정을 확인한 뒤 다시 시도해 주세요.",
          c.get("requestId"),
          e.details,
        ),
        e.status,
      );
    if (e instanceof ConverterError)
      return c.json(
        errorEnvelope(
          "BODY_UNAVAILABLE",
          "체형 사용 가능 여부를 확인할 수 없습니다.",
          c.get("requestId"),
        ),
        503,
      );
    throw e;
  });
  return app;
}
export function createBodyPreferenceRoutes(
  store = bodyStore,
  enabled = bodyUxAvailable,
) {
  const app = base(enabled);
  app.get("/", async (c) =>
    c.json(await store.preferences(c.get("installationId")!)),
  );
  app.put("/", async (c) =>
    c.json(
      await store.savePreferences(
        c.get("installationId")!,
        parsePreferenceChange(await c.req.json().catch(() => null)),
      ),
    ),
  );
  // 체형 카드("주인공 A"). 응답은 GET과 같은 설정 전체(새 revision 포함).
  app.post("/cards", async (c) =>
    c.json(
      await store.saveCards(
        c.get("installationId")!,
        parseCardChange("create", await c.req.json().catch(() => null)),
      ),
    ),
  );
  app.put("/cards/:cardId", async (c) =>
    c.json(
      await store.saveCards(
        c.get("installationId")!,
        parseCardChange(
          "update",
          await c.req.json().catch(() => null),
          c.req.param("cardId"),
        ),
      ),
    ),
  );
  app.delete("/cards/:cardId", async (c) =>
    c.json(
      await store.saveCards(
        c.get("installationId")!,
        parseCardChange(
          "delete",
          await c.req.json().catch(() => null),
          c.req.param("cardId"),
        ),
      ),
    ),
  );
  return app;
}
export function createBodySelectionRoutes(
  store = bodyStore,
  enabled = () => config.bodySelectionEnabled,
) {
  const app = base(enabled, [
    "/:jobId/people/:personIndex/body-selection",
    "/:jobId/people/:personIndex/body-options",
  ]);
  const prefix = "/:jobId/people/:personIndex";
  const index = (raw: string) => {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new BodyError("INVALID_INPUT", 400);
    return Number(raw);
  };
  app.get(`${prefix}/body-selection`, async (c) =>
    c.json(
      await store.selection(
        c.get("installationId")!,
        c.req.param("jobId"),
        index(c.req.param("personIndex")),
      ),
    ),
  );
  app.put(`${prefix}/body-selection`, async (c) =>
    c.json(
      await store.saveSelection(
        c.get("installationId")!,
        c.req.param("jobId"),
        index(c.req.param("personIndex")),
        parseSelectionChange(await c.req.json().catch(() => null)),
      ),
    ),
  );
  app.get(`${prefix}/body-options`, async (c) =>
    c.json(
      await store.options(
        c.get("installationId")!,
        c.req.param("jobId"),
        index(c.req.param("personIndex")),
      ),
    ),
  );
  return app;
}
