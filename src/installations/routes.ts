import { createBodyPreferenceRoutes } from "../body-selection/routes.js";
import { Hono } from "hono";
import { pool, transaction } from "../db.js";
import {
  parseQualityConsent,
  readQualityConsent,
  writeQualityConsent,
} from "./qualityConsent.js";
import { config } from "../config.js";
import type { AppEnv } from "../env.js";
import { deleteInstallationObjects } from "../inputStorage.js";
import { errorEnvelope } from "../mapping.js";
import { requireInstallation } from "./middleware.js";
import {
  createInstallation,
  revokeAndDeleteInstallationData,
} from "./store.js";

export const installationRoutes = new Hono<AppEnv>();
installationRoutes.use("/current/body-preferences", requireInstallation);
installationRoutes.use("/current/body-preferences/*", requireInstallation);
installationRoutes.route(
  "/current/body-preferences",
  createBodyPreferenceRoutes(),
);

function shortString(value: unknown, max = 64): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

installationRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
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
      errorEnvelope(
        "INVALID_INPUT",
        "유효한 동의 및 설치 환경정보가 필요합니다.",
        c.get("requestId"),
      ),
      400,
    );
  }
  const qualityConsent =
    body?.qualityConsent === undefined
      ? undefined
      : parseQualityConsent(body.qualityConsent);
  if (qualityConsent === null)
    return c.json(
      errorEnvelope(
        "INVALID_INPUT",
        "선택 동의 형식을 확인해 주세요.",
        c.get("requestId"),
      ),
      400,
    );
  const installation = await createInstallation({
    qualityConsent,
    consentVersion,
    consentedAt: new Date().toISOString(),
    appVersion,
    osName,
    osVersion,
    architecture,
    locale,
  });
  return c.json(
    {
      ...installation,
      consentVersion,
      qualityConsent: await readQualityConsent(
        pool,
        installation.installationId,
      ),
    },
    201,
  );
});

installationRoutes.delete("/current/data", requireInstallation, async (c) => {
  const installationId = c.get("installationId")!;
  await deleteInstallationObjects(installationId);
  await revokeAndDeleteInstallationData(installationId);
  return c.json({ deleted: true, backupExpiryDays: 7 });
});

installationRoutes.get(
  "/current/quality-consent",
  requireInstallation,
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await readQualityConsent(pool, c.get("installationId")!));
  },
);
installationRoutes.put(
  "/current/quality-consent",
  requireInstallation,
  async (c) => {
    const input = parseQualityConsent(await c.req.json().catch(() => null));
    if (!input)
      return c.json(
        errorEnvelope(
          "INVALID_INPUT",
          "선택 동의 형식을 확인해 주세요.",
          c.get("requestId"),
        ),
        400,
      );
    const result = await transaction((db) =>
      writeQualityConsent(db, c.get("installationId")!, input),
    );
    c.header("Cache-Control", "no-store");
    return c.json(result);
  },
);
