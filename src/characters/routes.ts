// GET /v1/models — 저장할 체형 목록(Standin-client docs/08 §8-1, ADR-013).
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { log } from "../log.js";
import { errorEnvelope } from "../mapping.js";
import { ConverterError, converterEnabled } from "../converter/client.js";
import { listCharacters } from "./service.js";

export const characterRoutes = new Hono<AppEnv>();

characterRoutes.get("/", async (c) => {
  // converter가 없는 배포에서는 체형을 고를 수 없다. 빈 목록이 아니라 503을 준다 —
  // 빈 목록은 "모델이 하나도 없다"로 읽히고, 클라이언트는 503을 "이 배포엔 이 기능이
  // 없다"로 읽어 자기 폴백 목록을 그린다.
  if (!converterEnabled()) {
    return c.json(
      errorEnvelope(
        "CONVERTER_UNAVAILABLE",
        "지금은 모델 목록을 불러올 수 없습니다.",
        c.get("requestId"),
      ),
      503,
    );
  }

  try {
    const catalog = await listCharacters();
    // 목록은 배포 때만 바뀐다. 저장 흐름마다 converter를 다시 두드리지 않게 한다.
    c.header("Cache-Control", "public, max-age=300");
    return c.json(catalog);
  } catch (error) {
    if (error instanceof ConverterError) {
      log.warn({
        type: "converter",
        event: "characters_failed",
        errorCode: error.code,
        upstreamStatus: error.upstreamStatus,
      });
      return c.json(
        errorEnvelope(
          "CONVERTER_UNAVAILABLE",
          "지금은 모델 목록을 불러올 수 없습니다.",
          c.get("requestId"),
        ),
        503,
      );
    }
    throw error;
  }
});
