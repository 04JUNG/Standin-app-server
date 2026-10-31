import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { execute, queryOne, query } from "../db.js";
import { requireInstallation } from "./middleware.js";
import { errorEnvelope } from "../mapping.js";

export const ACQUISITION_VERSION = "2026-10-29";
export const CREATIVES = ["meta-poster-a", "meta-hook-a"] as const;
export type Creative = typeof CREATIVES[number];
export function parseAcquisition(body: unknown): Creative | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  return value.consent === true && value.version === ACQUISITION_VERSION &&
    CREATIVES.includes(value.creative as Creative) ? value.creative as Creative : null;
}

// This is a user-confirmed campaign-link association, not proof of an ad impression.
// First touch is immutable. A revoked receipt cannot be reclassified as a new install.
export interface AcquisitionStore {
  read(id: string): Promise<string | null>;
  claim(id: string, creative: Creative): Promise<boolean>;
  revoke(id: string): Promise<void>;
}
const store: AcquisitionStore = {
  async read(id) { return (await queryOne<{acquisition_creative: string | null}>("SELECT acquisition_creative FROM installations WHERE id=$1",[id]))?.acquisition_creative ?? null; },
  async claim(id,creative) {
    return (await execute(`UPDATE installations
      SET acquisition_creative=$2, acquisition_consented_at=now(), acquisition_version=$3
      WHERE id=$1 AND acquisition_consented_at IS NULL
        AND created_at::timestamptz >= now()-interval '24 hours'
        AND created_at::timestamptz <= now() AND revoked_at IS NULL`,
    [id,creative,ACQUISITION_VERSION])) > 0;
  },
  async revoke(id) { await execute("UPDATE installations SET acquisition_creative=NULL, acquisition_version=NULL WHERE id=$1",[id]); },
};
export function createAcquisitionRoutes(repository: AcquisitionStore = store, authenticate: MiddlewareHandler<AppEnv> = requireInstallation) {
const routes = new Hono<AppEnv>();
routes.use("*", authenticate);
routes.get("/", async (c) => c.json({creative: await repository.read(c.get("installationId")!)}));
routes.post("/", async (c) => {
  const creative = parseAcquisition(await c.req.json().catch(() => null));
  if (!creative) return c.json(errorEnvelope("INVALID_INPUT", "광고 연결 선택 동의를 확인해 주세요.", c.get("requestId")), 400);
  const changed = await repository.claim(c.get("installationId")!,creative);
  if (!changed) {
    const prior = await repository.read(c.get("installationId")!);
    if (prior !== creative)
      return c.json(errorEnvelope("ACQUISITION_UNAVAILABLE", "첫 실행 24시간 이내의 새 설치만 연결할 수 있습니다. 기존 연결은 변경하지 않습니다.", c.get("requestId")), 409);
  }
  return c.json({ creative });
});
routes.delete("/", async (c) => {
  await repository.revoke(c.get("installationId")!);
  return c.json({ creative: null });
});
return routes;
}
export const acquisitionRoutes = createAcquisitionRoutes();

export async function acquisitionSummary(days: number) {
  // Installation cohort, not all jobs during a window. Never backfill pre-consent usage.
  return query<{ creative: string; installations: number; active: number; analyzed: number; selected: number; exported: number }>(`
    SELECT COALESCE(i.acquisition_creative,'unknown') AS creative,
      count(*)::int AS installations,
      count(*) FILTER (WHERE i.acquisition_creative IS NOT NULL AND i.last_seen_at::timestamptz >= now()-interval '1 day')::int AS active,
      count(*) FILTER (WHERE i.acquisition_creative IS NOT NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.installation_id=i.id
        AND j.status='completed' AND j.created_at::timestamptz >= COALESCE(i.acquisition_consented_at,i.created_at::timestamptz)))::int AS analyzed,
      count(*) FILTER (WHERE i.acquisition_creative IS NOT NULL AND EXISTS (SELECT 1 FROM confirmed_selections s WHERE s.installation_id=i.id
        AND s.confirmed_at::timestamptz >= COALESCE(i.acquisition_consented_at,i.created_at::timestamptz)))::int AS selected,
      count(*) FILTER (WHERE i.acquisition_creative IS NOT NULL AND EXISTS (SELECT 1 FROM export_events e WHERE e.installation_id=i.id AND e.status='completed'
        AND e.occurred_at::timestamptz >= COALESCE(i.acquisition_consented_at,i.created_at::timestamptz)))::int AS exported
    FROM installations i JOIN ops_count_installations eligible ON eligible.id=i.id
    WHERE i.created_at::timestamptz >= now()-($1::int * interval '1 day')
    GROUP BY COALESCE(i.acquisition_creative,'unknown')`, [days]);
}
