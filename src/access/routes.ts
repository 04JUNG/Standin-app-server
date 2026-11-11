import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { config } from "../config.js";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { installationAccess } from "./policy.js";
import { consumeAccessAttempt, redeemAccessCode } from "./store.js";

export function createAccessRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (c,next) => { c.header("Cache-Control","private, no-store"); await next(); });
  routes.get("/", async c => c.json(await installationAccess(c.get("installationId")!)));
  routes.post("/redeem", bodyLimit({ maxSize: 4096 }), async c => {
    const id = c.get("installationId")!;
    const status = await installationAccess(id);
    if (status.allowed) return c.json(status);
    if (!config.supporterAccessEnabled)
      return c.json(errorEnvelope("SUPPORTER_ACCESS_CLOSED","현재 서포터즈 이용이 종료되었습니다.",c.get("requestId")),403);
    if (!await consumeAccessAttempt(id)) {
      c.header("Retry-After","600");
      return c.json(errorEnvelope("ACCESS_CODE_RATE_LIMITED","잠시 후 다시 시도해 주세요.",c.get("requestId")),429);
    }
    const body = await c.req.json().catch(() => null);
    if (typeof body?.code !== "string" || body.code.length > 100 ||
        !await redeemAccessCode(id,body.code))
      return c.json(errorEnvelope("ACCESS_CODE_INVALID","사용할 수 없는 코드입니다. 전달받은 코드를 확인해 주세요.",c.get("requestId")),400);
    return c.json(await installationAccess(id));
  });
  return routes;
}
