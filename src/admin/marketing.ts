import { config } from '../config.js';

export const MARKETING_CREATIVES = [
  { creative: 'meta-poster-a', label: '포스터 A', phase: 'landing', adId: '52571670110169' },
  { creative: 'meta-hook-a', label: '영상 A', phase: 'landing', adId: '52571947001569' },
  { creative: 'meta-poster-a', label: '포스터 A', phase: 'download', adId: '52572453148369' },
  { creative: 'meta-hook-a', label: '영상 A', phase: 'download', adId: '52572454477769' },
] as const;
// Events Manager: Standin | DownloadClick, created 2026-10-31. Do not sum
// fb_pixel_custom or other custom conversions: they include unrelated actions.
export const DOWNLOAD_ACTION = 'offsite_conversion.custom.1680558963511586';
export interface AdMetrics { creative: string; adId: string; phase: 'landing' | 'download'; spend: number; impressions: number; clicks: number; landingViews: number; downloadClicks: number }
interface Snapshot { fetchedAt: string; since: string; until: string; rows: AdMetrics[] }
export interface MetaResult { status: 'ready' | 'unconfigured' | 'unavailable' | 'stale'; snapshot: Snapshot | null; reason?: 'access_blocked' }
interface Settings { token: string; version: string; accountId: string }
async function checkedResponse(response: Response): Promise<unknown> {
  if (response.ok) return response.json();
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  if (error && typeof error === 'object' && 'code' in error && error.code === 200
    && 'message' in error && error.message === 'API access blocked.') throw new Error('access_blocked');
  throw new Error('meta_unavailable');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('invalid_metric');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || value === '') throw new Error('invalid_metric');
  return n;
}
export function metaWindow(days: number, now: number) {
  const until = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const since = new Date(Date.parse(until + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { since, until };
}
// Cache per bounded reporting window; failed responses never become zero activity.
export function createMetaReader(settings: Settings, request: typeof fetch = fetch, clock = Date.now) {
  const cache = new Map<string, { checked: number; result: MetaResult }>();
  const pending = new Map<string, Promise<MetaResult>>();
  return async (days: number): Promise<MetaResult> => {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('invalid_window');
    if (!settings.token || !/^v\d+\.\d+$/.test(settings.version) || !/^\d+$/.test(settings.accountId))
      return { status: 'unconfigured', snapshot: null };
    const window = metaWindow(days, clock());
    const key = window.since + ':' + window.until;
    const previous = cache.get(key);
    if (previous && clock() - previous.checked < 60000) return previous.result;
    const running = pending.get(key);
    if (running) return running;
    const work = (async (): Promise<MetaResult> => {
      try {
        const signal = AbortSignal.timeout(10000);
        const headers = { Authorization: 'Bearer ' + settings.token };
        const base = 'https://graph.facebook.com/' + settings.version + '/act_' + settings.accountId;
        const accountResponse = await request(base + '?fields=currency,timezone_name', { headers, signal, redirect: 'error' });
        const account = record(await checkedResponse(accountResponse));
        if (account.currency !== 'KRW' || account.timezone_name !== 'Asia/Seoul') throw new Error('account_locale');
        const rows: AdMetrics[] = MARKETING_CREATIVES.map(c => ({ creative: c.creative, adId: c.adId, phase: c.phase, spend: 0, impressions: 0, clicks: 0, landingViews: 0, downloadClicks: 0 }));
        const seen = new Set<string>();
        let after = '';
        for (let page = 0; page < 10; page++) {
          const url = new URL(base + '/insights');
          url.searchParams.set('level', 'ad');
          url.searchParams.set('fields', 'ad_id,spend,impressions,inline_link_clicks,actions');
          url.searchParams.set('time_range', JSON.stringify(window));
          url.searchParams.set('filtering', JSON.stringify([{ field: 'ad.id', operator: 'IN', value: MARKETING_CREATIVES.map(c => c.adId) }]));
          url.searchParams.set('limit', '100');
          if (after) url.searchParams.set('after', after);
          const response = await request(url, { headers, signal, redirect: 'error' });
          const body = record(await checkedResponse(response));
          if (!Array.isArray(body.data)) throw new Error('invalid_response');
          for (const raw of body.data) {
            const item = record(raw);
            const index = MARKETING_CREATIVES.findIndex(c => c.adId === item.ad_id);
            if (index < 0 || seen.has(String(item.ad_id))) throw new Error('unexpected_ad');
            seen.add(String(item.ad_id));
            const actions = item.actions === undefined ? [] : item.actions;
            if (!Array.isArray(actions)) throw new Error('invalid_actions');
            const parsed = actions.map(record);
            const landing = parsed.find(a => a.action_type === 'landing_page_view');
            const downloads = parsed.filter(a => a.action_type === DOWNLOAD_ACTION);
            if (downloads.length > 1) throw new Error('duplicate_action');
            rows[index] = { ...rows[index], spend: number(item.spend), impressions: number(item.impressions),
              clicks: item.inline_link_clicks === undefined ? 0 : number(item.inline_link_clicks), landingViews: landing ? number(landing.value) : 0,
              downloadClicks: downloads.length ? number(downloads[0].value) : 0 };
          }
          const paging = body.paging ? record(body.paging) : {};
          if (!paging.next) break;
          const cursor = record(paging.cursors).after;
          if (typeof cursor !== 'string' || !cursor || cursor === after || page === 9) throw new Error('invalid_pagination');
          after = cursor; // Never follow a returned URL containing a token or another host.
        }
        return { status: 'ready', snapshot: { ...window, rows, fetchedAt: new Date(clock()).toISOString() } };
      } catch (error) {
        return { status: previous?.result.snapshot ? 'stale' : 'unavailable', snapshot: previous?.result.snapshot ?? null,
          ...(error instanceof Error && error.message === 'access_blocked' ? { reason: 'access_blocked' as const } : {}) };
      }
    })();
    pending.set(key, work);
    try {
      const result = await work;
      if (cache.size >= 90 && !cache.has(key)) cache.delete(cache.keys().next().value!);
      cache.set(key, { checked: clock(), result });
      return result;
    } finally { pending.delete(key); }
  };
}
export const readMetaMarketing = createMetaReader({ token: config.metaMarketingToken, version: config.metaMarketingVersion, accountId: config.metaMarketingAccountId });
