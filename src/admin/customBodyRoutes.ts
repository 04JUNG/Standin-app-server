import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { loadBodyCatalog } from "../body-selection/catalog.js";
import {
  CustomBodyError,
  customBody,
  publicCustomBody,
  savedCards,
  parseCustomBodyQuery,
  validInstallation,
  validCard,
  requireRenderable,
} from "./customBodies.js";
import { findCustomBodyRow, listCustomBodyRows } from "./customBodiesStore.js";
import { renderCustomBody, type BodyView } from "./customBodiesPreview.js";

const defaults = {
  find: findCustomBodyRow,
  list: listCustomBodyRows,
  catalog: loadBodyCatalog,
  render: renderCustomBody,
};
export function createCustomBodyRoutes(
  audit: (
    c: Context<AppEnv>,
    action: string,
    installationId?: string,
  ) => Promise<void>,
  deps = defaults,
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((e, c) => {
    if (e instanceof CustomBodyError)
      return c.json(
        errorEnvelope(
          e.code,
          "저장한 체형을 조회하지 못했습니다. 새로고침하거나 사용 가능 여부를 확인해 주세요.",
          c.get("requestId"),
        ),
        e.status,
      );
    throw e;
  });
  const get = async (owner: string, id: string) => {
    if (!validInstallation(owner) || !validCard(id))
      throw new CustomBodyError("INVALID_INPUT", 400);
    const row = await deps.find(owner),
      card = row && savedCards(row).find((v) => v.cardId === id);
    if (!row || !card) throw new CustomBodyError("NOT_FOUND", 404);
    return { row, body: customBody(row, card, deps.catalog()) };
  };
  app.get("/", async (c) => {
    const q = parseCustomBodyQuery(c.req.query()),
      rows = await deps.list(q),
      more = rows.length > q.limit,
      page = rows.slice(0, q.limit),
      catalog = deps.catalog();
    await audit(c, "review_custom_body_list", q.installationId ?? undefined);
    const installations = [];
    for (const row of page) {
      const fresh = await deps.find(row.installation_id);
      if (!fresh) continue;
      installations.push({
        installationId: fresh.installation_id,
        lastSeenAt: fresh.last_seen_at,
        appVersion: fresh.app_version,
        osName: fresh.os_name,
        cards: savedCards(fresh).map((card) =>
          publicCustomBody(customBody(fresh, card, catalog)),
        ),
      });
    }
    const last = page.at(-1);
    return c.json({
      installations,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                at: last.last_seen_at,
                id: last.installation_id,
              }),
            ).toString("base64url")
          : null,
      scope: "current_consented_saved_cards",
      periodApplied: false,
    });
  });
  app.get("/:installationId/:cardId", async (c) => {
    const owner = c.req.param("installationId"),
      id = c.req.param("cardId");
    await get(owner, id);
    await audit(c, "review_custom_body", owner);
    const { row, body } = await get(owner, id);
    return c.json({
      installationId: row.installation_id,
      ...publicCustomBody(body),
      previewUrl:
        body.previewStatus === "available"
          ? `/v1/admin/review/custom-bodies/${encodeURIComponent(owner)}/${encodeURIComponent(id)}/preview?revision=${body.revision}`
          : null,
    });
  });
  app.get("/:installationId/:cardId/preview", async (c) => {
    const owner = c.req.param("installationId"),
      id = c.req.param("cardId"),
      revision = c.req.query("revision"),
      view = c.req.query("view") ?? "front";
    if (
      !revision ||
      !/^[a-f0-9]{64}$/.test(revision) ||
      !["front", "side", "back"].includes(view)
    )
      throw new CustomBodyError("INVALID_INPUT", 400);
    const { body } = await get(owner, id);
    if (body.revision !== revision)
      throw new CustomBodyError("BODY_CHANGED", 409);
    const { asset, controls } = requireRenderable(body);
    await audit(c, "review_custom_body_preview", owner);
    const svg = await deps.render(asset, controls, revision, view as BodyView);
    const latest = await get(owner, id);
    if (latest.body.revision !== revision)
      throw new CustomBodyError("BODY_CHANGED", 409);
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return c.body(svg, 200, { "Content-Type": "image/svg+xml; charset=utf-8" });
  });
  return app;
}
