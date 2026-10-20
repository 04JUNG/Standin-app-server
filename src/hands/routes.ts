import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { HandError, PRESET, SHA } from "./model.js";
import { readyHandCatalog, getHandThumbnail } from "./service.js";
import { handStore, parseHandChange } from "./store.js";
export function createHandRoutes(
  deps = { catalog: readyHandCatalog, thumbnail: getHandThumbnail },
) {
  const app = new Hono<AppEnv>();
  app.onError(handRouteError);
  app.get("/catalog", async (c) => {
    const catalog = await deps.catalog();
    return c.json(catalog, 200, {
      "Cache-Control": "private, max-age=3600",
      ETag: `"${catalog.library_sha256.slice(0, 32)}"`,
    });
  });
  app.get("/:preset/thumbnail", async (c) => {
    const side = c.req.query("side"),
      preset = c.req.param("preset");
    if (!PRESET.test(preset) || (side !== "left" && side !== "right"))
      throw new HandError(
        "INVALID_INPUT",
        400,
        "손 모양을 다시 선택해 주세요.",
      );
    const catalog = await deps.catalog();
    const library = c.req.query("library");
    if (library !== undefined && !SHA.test(library))
      throw new HandError(
        "INVALID_INPUT",
        400,
        "손 이미지 요청을 확인해 주세요.",
      );
    if (library !== undefined && library !== catalog.library_sha256)
      throw new HandError(
        "HAND_LIBRARY_CHANGED",
        409,
        "손 목록이 변경되었습니다. 다시 불러와 주세요.",
      );
    if (!catalog.thumbnails_available)
      throw new HandError(
        "HAND_THUMBNAIL_UNAVAILABLE",
        404,
        "손 이미지가 아직 준비되지 않았습니다.",
      );
    if (!catalog.categories.some((g) => g.presets.some((p) => p.id === preset)))
      throw new HandError(
        "INVALID_HAND_PRESET",
        400,
        "손 모양을 다시 선택해 주세요.",
      );
    const response = await deps.thumbnail(
      preset,
      side,
      c.req.header("If-None-Match"),
    );
    if (response.status === 404) return c.body(null, 404);
    if (!response.ok && response.status !== 304)
      throw new HandError(
        "HANDS_UNAVAILABLE",
        503,
        "손 이미지를 불러올 수 없습니다.",
      );
    const headers = new Headers({
      "Cache-Control": "private, max-age=86400",
      "X-Standin-Hand-Library-SHA256": catalog.library_sha256,
    });
    if (response.headers.get("ETag"))
      headers.set("ETag", response.headers.get("ETag")!);
    if (response.status === 304)
      return new Response(null, { status: 304, headers });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length > 2 * 1024 * 1024 ||
      !Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    )
      throw new HandError(
        "HANDS_UNAVAILABLE",
        503,
        "손 이미지를 확인하지 못했습니다.",
      );
    headers.set("Content-Type", "image/png");
    return new Response(bytes, { headers });
  });
  return app;
}
const handRouteError: Parameters<Hono<AppEnv>["onError"]>[0] = (error, c) =>
  c.json(
    errorEnvelope(
      error instanceof HandError ? error.code : "HANDS_UNAVAILABLE",
      error instanceof HandError
        ? error.message
        : "손 선택을 완료하지 못했습니다.",
      c.get("requestId"),
    ),
    error instanceof HandError ? error.status : 503,
  );
export function createHandSelectionRoutes(store = handStore) {
  const app = new Hono<AppEnv>();
  app.onError(handRouteError);
  app.on(["GET", "PUT"], "/:id/people/:personIndex/hands", async (c) => {
    const raw = c.req.param("personIndex");
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new HandError("INVALID_INPUT", 400, "인물을 확인해 주세요.");
    const change =
      c.req.method === "PUT"
        ? parseHandChange(await c.req.json().catch(() => null))
        : undefined;
    return c.json(
      await store.selection(
        c.get("installationId")!,
        c.req.param("id"),
        Number(raw),
        change,
      ),
      200,
      { "Cache-Control": "private, no-store" },
    );
  });
  return app;
}
