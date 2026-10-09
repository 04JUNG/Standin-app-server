import { bodyUxAvailable } from "./availability.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { config } from "../config.js";
import { errorEnvelope } from "../mapping.js";
import { ConverterError } from "../converter/client.js";
import {
  BodyError,
  bodyStore,
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
  only(v, ["mode", "defaultCharacterId", "expectedRevision", "mutationId"]);
  if (
    !["auto", "fixed_default"].includes(String(v.mode)) ||
    !(v.defaultCharacterId === null || id(v.defaultCharacterId)) ||
    (v.mode === "fixed_default" && !v.defaultCharacterId)
  )
    throw new BodyError("INVALID_INPUT", 400);
  return v as unknown as PreferenceChange;
}
export function parseSelectionChange(raw: unknown): SelectionChange {
  const v = obj(raw);
  mutation(v);
  only(v, ["intent", "characterId", "expectedRevision", "mutationId"]);
  if (
    !["inherit", "auto", "manual"].includes(String(v.intent)) ||
    (v.intent === "manual" ? !id(v.characterId) : "characterId" in v)
  )
    throw new BodyError("INVALID_INPUT", 400);
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
