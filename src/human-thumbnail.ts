/** Static public-library reference images. Never starts a Converter job. */
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { getPoseBvh, getPosePoster } from "./inference.js";
import { sha256Hex } from "./converter/client.js";
import { verifiedPoster } from "./pose-posters.js";
import { errorEnvelope } from "./mapping.js";

const defaults = { getPoseBvh, getPosePoster };
/** Mount behind installation auth, or admin auth + quality-review guard. */
export function createHumanThumbnailRoutes(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  const routes = new Hono<AppEnv>();
  routes.get("/:id/reference-thumbnail", async (c) => {
    const unavailable = () => c.json(errorEnvelope(
      "PREVIEW_UNAVAILABLE", "참고 이미지를 불러오지 못했습니다.", c.get("requestId"),
    ), 404, { "Cache-Control": "private, no-store" });
    try {
      // The upstream registry/quarantine check remains authoritative. Do not trust a
      // caller-provided source hash, and never fall back to legacy joint drawings.
      const source = await deps.getPoseBvh(c.req.param("id"));
      if (!source.ok) {
        await source.body?.cancel();
        return unavailable();
      }
      const reader = source.body?.getReader();
      if (!reader) return unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 2_000_000) return unavailable();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!size) return unavailable();
      const response = await verifiedPoster(
        c.req.param("id"), sha256Hex(Buffer.concat(chunks)), deps.getPosePoster, "full",
      );
      if (response.headers.get("X-Standin-Poster-Kind") !== "default-body") {
        await response.body?.cancel();
        return unavailable();
      }
      return response;
    } catch {
      return unavailable();
    }
  });
  return routes;
}
