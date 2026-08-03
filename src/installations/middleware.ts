import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import type { AppEnv } from "../env.js";
import { errorEnvelope } from "../mapping.js";
import { authenticateInstallation } from "./store.js";

export const INSTALLATION_ID_HEADER = "X-Installation-Id";
export const DEVICE_TOKEN_HEADER = "X-Device-Token";

export const requireInstallation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const installationId = c.req.header(INSTALLATION_ID_HEADER) ?? "";
  const deviceToken = c.req.header(DEVICE_TOKEN_HEADER) ?? "";
  if (!installationId || !deviceToken) {
    return c.json(
      errorEnvelope("INSTALLATION_REQUIRED", "설치 등록이 필요합니다.", c.get("requestId")),
      401,
    );
  }
  const installation = await authenticateInstallation(installationId, deviceToken);
  if (!installation) {
    return c.json(
      errorEnvelope("INVALID_INSTALLATION", "설치 인증정보가 유효하지 않습니다.", c.get("requestId")),
      401,
    );
  }
  if (installation.consentVersion !== config.consentVersion) {
    return c.json(
      errorEnvelope("CONSENT_REQUIRED", "최신 베타 데이터 수집 동의가 필요합니다.", c.get("requestId")),
      403,
    );
  }
  c.set("installationId", installation.id);
  await next();
};
