import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { MINIMUM_CLIENT_VERSION } from "./policy.js";

export function updateRequired(c: Context<AppEnv>) {
  c.header("Cache-Control", "no-store");
  return c.json(
    errorEnvelope(
      "UPDATE_REQUIRED",
      `Standin ${MINIMUM_CLIENT_VERSION} 이상으로 업데이트해야 사용할 수 있습니다.`,
      c.get("requestId"),
      { minimumVersion: MINIMUM_CLIENT_VERSION },
    ),
    426,
  );
}
