import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from './config.js';
import { query, execute } from './db.js';

export const CAMPAIGN_COUNT_PATH = '/v1/metrics/campaign-counts';
export const COUNT_CREATIVES = ['meta-poster-a', 'meta-hook-a'] as const;
export const COUNT_EVENTS = ['first_run', 'first_analysis_success'] as const;
type Creative = typeof COUNT_CREATIVES[number];
type CountEvent = typeof COUNT_EVENTS[number];
export type CampaignCount = { v: 1; creative: Creative; event: CountEvent };
const DAY = 86400000;
const MINIMUM_CELL = 5;
export function seoulDay(now: number) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
export function parseCampaignCount(input: unknown): CampaignCount | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'creative,event,v' || v.v !== 1 ||
    !COUNT_CREATIVES.includes(v.creative as Creative) || !COUNT_EVENTS.includes(v.event as CountEvent)) return null;
  return { v: 1, creative: v.creative as Creative, event: v.event as CountEvent };
}
export async function incrementCampaignCount(value: CampaignCount, now: number) {
  // No receipt, request timestamp, installation/job foreign key or raw event row.
  await execute(`INSERT INTO campaign_daily_counts(day, creative, event, count)
    VALUES ($1::date,$2,$3,1) ON CONFLICT(day,creative,event)
    DO UPDATE SET count=LEAST(campaign_daily_counts.count+1,10000)`,
  [seoulDay(now), value.creative, value.event]);
}

/** Mount before authenticated/request logging middleware. Never pass through to it. */
export function createCampaignCountRoutes(options: {
  enabled?: boolean; origins?: string[]; clock?: () => number;
  increment?: (value: CampaignCount, now: number) => Promise<void>;
} = {}) {
  const enabled = options.enabled ?? config.campaignCountsEnabled;
  const origins = options.origins ?? config.corsOrigins;
  const clock = options.clock ?? Date.now;
  const increment = options.increment ?? incrementCampaignCount;
  const routes = new Hono();
  // Bounded process-wide throttle, deliberately not keyed by IP/device/header.
  let remaining = 60, nextWindow = 0;
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const origin = c.req.header('Origin');
    if (origin && !origins.includes(origin)) return c.body(null, 403);
    if (origin) { c.header('Access-Control-Allow-Origin', origin); c.header('Vary', 'Origin'); }
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (c.req.method !== 'POST') return c.body(null, 405);
    if (!enabled) return c.body(null, 503);
    if (new URL(c.req.url).search || ['authorization', 'cookie', 'x-installation-id', 'x-device-token', 'x-beta-admin-token']
      .some(name => c.req.header(name) !== undefined)) return c.body(null, 400);
    if (c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json') return c.body(null, 415);
    const now = clock();
    if (now >= nextWindow) { nextWindow = now + 60000; remaining = 60; }
    if (remaining-- <= 0) return c.body(null, 429);
    await next();
  });
  routes.use('*', bodyLimit({ maxSize: 160, onError: c => c.body(null, 413) }));
  routes.post('/', async c => {
    const value = parseCampaignCount(await c.req.json().catch(() => null));
    if (!value) return c.body(null, 400);
    try { await increment(value, clock()); return c.body(null, 204); }
    catch { return c.body(null, 503); }
  });
  routes.all('*', c => c.body(null, 404));
  routes.onError((_error, c) => c.body(null, 503));
  return routes;
}

export async function campaignCountSummary(days: number, now = Date.now(), enabled = config.campaignCountsEnabled) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('invalid_window');
  const since = seoulDay(now - days * DAY), until = seoulDay(now - DAY);
  const values = enabled ? await query<{creative: string; event: string; count: number}>(`
    SELECT creative,event,SUM(count)::int AS count FROM campaign_daily_counts
    WHERE day >= $1::date AND day <= $2::date GROUP BY creative,event`, [since, until]) : [];
  function cell(creative: Creative, event: CountEvent) {
    const count = Number(values.find(row => row.creative === creative && row.event === event)?.count ?? 0);
    return count >= MINIMUM_CELL ? count : null;
  }
  return { enabled, since, until, minimumCell: MINIMUM_CELL,
    rows: COUNT_CREATIVES.map(creative => ({ creative,
      first_run: cell(creative, 'first_run'), first_analysis_success: cell(creative, 'first_analysis_success'),
    })) };
}
