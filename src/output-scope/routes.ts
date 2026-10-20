import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { isScopeSelection } from "./model.js";
import { saveOutputScope } from "./store.js";

export function createOutputScopeRoutes(save = saveOutputScope) {
  const routes = new Hono<AppEnv>();
  routes.put("/:id/people/:personIndex/output-scope", async (c) => {
    const rawIndex = c.req.param("personIndex");
    const personIndex = Number(rawIndex);
    const body: unknown = await c.req.json().catch(() => null);
    if (!/^(0|[1-9]\d*)$/.test(rawIndex) || !Number.isSafeInteger(personIndex) ||
        typeof body !== "object" || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !("selection" in body) ||
        !isScopeSelection(body.selection)) {
      return c.json(errorEnvelope("INVALID_INPUT", "출력 범위 선택값을 확인해 주세요.", c.get("requestId")), 400);
    }
    const installationId = c.get("installationId");
    if (!installationId) {
      return c.json(errorEnvelope("UNAUTHORIZED", "설치 인증이 필요합니다.", c.get("requestId")), 401);
    }
    const result = await save(c.req.param("id"), installationId, personIndex, body.selection);
    if (!result.ok) {
      const notReady = result.reason === "not_ready";
      return c.json(errorEnvelope(notReady ? "NOT_READY" : "NOT_FOUND",
        notReady ? "분석 완료 후 선택할 수 있습니다." : "작업 또는 인물을 찾지 못했습니다.",
        c.get("requestId")), notReady ? 409 : 404);
    }
    return c.json({ personIndex, outputScope: result.outputScope });
  });
  return routes;
}
