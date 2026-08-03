import { Hono } from "hono";
import { config } from "../config.js";
import type { AppEnv } from "../env.js";
import { deleteInstallationObjects } from "../inputStorage.js";
import { errorEnvelope } from "../mapping.js";
import { requireInstallation } from "./middleware.js";
import { createInstallation, revokeAndDeleteInstallationData } from "./store.js";

export const installationRoutes = new Hono<AppEnv>();

function shortString(value: unknown, max = 64): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

installationRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const consentVersion = shortString(body?.consentVersion);
  const consentedAt = shortString(body?.consentedAt);
  const appVersion = shortString(body?.appVersion);
  const osName = shortString(body?.osName);
  const osVersion = shortString(body?.osVersion);
  const architecture = shortString(body?.architecture);
  const locale = shortString(body?.locale);
  if (
    consentVersion !== config.consentVersion ||
    !consentedAt ||
    !appVersion ||
    !osName ||
    !osVersion ||
    !architecture ||
    !locale ||
    Number.isNaN(Date.parse(consentedAt))
  ) {
    return c.json(
      errorEnvelope("INVALID_INPUT", "유효한 동의 및 설치 환경정보가 필요합니다.", c.get("requestId")),
      400,
    );
  }
  const installation = await createInstallation({
    consentVersion,
    consentedAt: new Date().toISOString(),
    appVersion,
    osName,
    osVersion,
    architecture,
    locale,
  });
  return c.json({ ...installation, consentVersion }, 201);
});

installationRoutes.delete("/current/data", requireInstallation, async (c) => {
  const installationId = c.get("installationId")!;
  await deleteInstallationObjects(installationId);
  await revokeAndDeleteInstallationData(installationId);
  return c.json({ deleted: true, backupExpiryDays: 7 });
});
