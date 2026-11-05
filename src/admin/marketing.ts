import { config } from '../config.js';

export const MARKETING_CREATIVES = [
  { creative: 'meta-poster-a', label: '포스터 A', phase: 'landing', adId: '52571670110169' },
  { creative: 'meta-hook-a', label: '영상 A', phase: 'landing', adId: '52571947001569' },
  { creative: 'meta-poster-a', label: '포스터 A', phase: 'download', adId: '52572453148369' },
  { creative: 'meta-hook-a', label: '영상 A', phase: 'download', adId: '52572454477769' },
  { creative: 'supporters-poster', label: '서포터즈 모집', phase: 'supporters', adId: '52573071176169' },
] as const;
export const SUPPORTERS_ADSET = '52573071175969';
// Events Manager: Standin | DownloadClick, created 2026-10-31. Do not sum
// fb_pixel_custom or other custom conversions: they include unrelated actions.
export const DOWNLOAD_ACTION = 'offsite_conversion.custom.1680558963511586';
export interface AdMetrics {
  creative: string; adId: string; phase: 'landing' | 'download' | 'supporters';
  spend: number; impressions: number; clicks: number; landingViews: number; downloadClicks: number;
  reach: number | null; frequency: number | null; saves: number; shares: number; videoViews: number;
}
interface Snapshot { fetchedAt: string; since: string; until: string; rows: AdMetrics[] }
export interface Report<T> { status: 'ready' | 'unconfigured' | 'unavailable' | 'stale'; snapshot: T | null; reason?: 'access_blocked' }
export interface DailySnapshot { fetchedAt: string; since: string; until: string; rows: (AdMetrics & { day: string })[] }
export interface SupportersSnapshot {
  fetchedAt: string; adsetId: string; effectiveStatus: string; start: string; end: string;
  lifetimeBudget: number; remainingBudget: number; lifetime: AdMetrics;
  since: string | null; until: string | null;
}
export interface MetaResult extends Report<Snapshot> { daily?: Report<DailySnapshot>; supporters?: Report<SupportersSnapshot> }
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
  if (!Number.isFinite(n) || n < 0 || typeof value === 'string' && value.trim() === '') throw new Error('invalid_metric');
  return n;
}
function emptyMetrics(c: typeof MARKETING_CREATIVES[number]): AdMetrics {
  return { creative: c.creative, adId: c.adId, phase: c.phase, spend: 0, impressions: 0,
    clicks: 0, landingViews: 0, downloadClicks: 0, reach: null, frequency: null, saves: 0, shares: 0, videoViews: 0 };
}
function metrics(item: Record<string, unknown>, c: typeof MARKETING_CREATIVES[number]): AdMetrics {
  const actions = item.actions === undefined ? [] : item.actions;
  if (!Array.isArray(actions)) throw new Error('invalid_actions');
  const parsed = actions.map(record);
  function action(type: string) {
    const values = parsed.filter(a => a.action_type === type);
    if (values.length > 1) throw new Error('duplicate_action');
    return values.length ? number(values[0].value) : 0;
  }
  return { ...emptyMetrics(c), spend: number(item.spend), impressions: number(item.impressions),
    clicks: item.inline_link_clicks === undefined ? 0 : number(item.inline_link_clicks),
    // omni_landing_page_view and landing_page_view overlap; do not add them.
    landingViews: action('landing_page_view'), downloadClicks: action(DOWNLOAD_ACTION),
    reach: item.reach === undefined ? null : number(item.reach),
    frequency: item.frequency === undefined ? null : number(item.frequency),
    saves: action('onsite_conversion.post_save'), shares: action('post'), videoViews: action('video_view') };
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('invalid_date');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid_date');
  return value;
}
async function optionalReport<T>(load: () => Promise<T>, previous?: Report<T>): Promise<Report<T>> {
  try { return { status: 'ready', snapshot: await load() }; }
  catch { return { status: previous?.snapshot ? 'stale' : 'unavailable', snapshot: previous?.snapshot ?? null }; }
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
        const signal = AbortSignal.timeout(15000);
        const headers = { Authorization: 'Bearer ' + settings.token };
        const base = 'https://graph.facebook.com/' + settings.version + '/act_' + settings.accountId;
        const accountResponse = await request(base + '?fields=currency,timezone_name', { headers, signal, redirect: 'error' });
        const account = record(await checkedResponse(accountResponse));
        if (account.currency !== 'KRW' || account.timezone_name !== 'Asia/Seoul') throw new Error('account_locale');
        async function insightRows(daily: boolean) {
          const rows: (AdMetrics & { day?: string })[] = daily ? [] : MARKETING_CREATIVES.map(emptyMetrics);
          const seen = new Set<string>();
          let after = '';
          for (let page = 0; page < 10; page++) {
            const url = new URL(base + '/insights');
            url.searchParams.set('level', 'ad');
            url.searchParams.set('fields', 'ad_id,date_start,date_stop,spend,impressions,reach,frequency,inline_link_clicks,actions');
            url.searchParams.set('time_range', JSON.stringify(window));
            if (daily) url.searchParams.set('time_increment', '1');
            url.searchParams.set('filtering', JSON.stringify([{ field: 'ad.id', operator: 'IN', value: MARKETING_CREATIVES.map(c => c.adId) }]));
            url.searchParams.set('limit', '100');
            if (after) url.searchParams.set('after', after);
            const response = await request(url, { headers, signal, redirect: 'error' });
            const body = record(await checkedResponse(response));
            if (!Array.isArray(body.data)) throw new Error('invalid_response');
            for (const raw of body.data) {
              const item = record(raw);
              const index = MARKETING_CREATIVES.findIndex(c => c.adId === item.ad_id);
              const date = daily ? day(item.date_start) : '';
              if (daily && (date < window.since || date > window.until || item.date_stop !== date)) throw new Error('invalid_date');
              const rowKey = date + ':' + item.ad_id;
              if (index < 0 || seen.has(rowKey)) throw new Error('unexpected_ad');
              seen.add(rowKey);
              const value = metrics(item, MARKETING_CREATIVES[index]);
              if (daily) rows.push({ ...value, day: date });
              else rows[index] = value;
            }
            const paging = body.paging ? record(body.paging) : {};
            if (!paging.next) break;
            const cursor = record(paging.cursors).after;
            if (typeof cursor !== 'string' || !cursor || cursor === after || page === 9) throw new Error('invalid_pagination');
            after = cursor; // Never follow a returned URL containing a token or another host.
          }
          return rows;
        }
        const rows = await insightRows(false);
        const [daily, supporters] = await Promise.all([
          optionalReport(async (): Promise<DailySnapshot> => ({ ...window,
            rows: await insightRows(true) as DailySnapshot['rows'], fetchedAt: new Date(clock()).toISOString() }), previous?.result.daily),
          optionalReport(async (): Promise<SupportersSnapshot> => {
            const url = new URL('https://graph.facebook.com/' + settings.version + '/' + SUPPORTERS_ADSET);
            url.searchParams.set('fields', 'id,account_id,effective_status,lifetime_budget,budget_remaining,start_time,end_time,insights.date_preset(maximum){spend,impressions,reach,frequency,inline_link_clicks,actions}');
            const body = record(await checkedResponse(await request(url, { headers, signal, redirect: 'error' })));
            if (body.id !== SUPPORTERS_ADSET || body.account_id !== settings.accountId || typeof body.effective_status !== 'string') throw new Error('unexpected_adset');
            const insights = record(body.insights);
            if (!Array.isArray(insights.data) || insights.data.length > 1 || insights.paging && record(insights.paging).next) throw new Error('invalid_lifetime');
            const item = insights.data.length ? record(insights.data[0]) : null;
            const creative = MARKETING_CREATIVES[4];
            return { adsetId: SUPPORTERS_ADSET, effectiveStatus: body.effective_status,
              start: timestamp(body.start_time), end: timestamp(body.end_time),
              lifetimeBudget: number(body.lifetime_budget), remainingBudget: number(body.budget_remaining),
              lifetime: item ? metrics(item, creative) : emptyMetrics(creative),
              since: item ? day(item.date_start) : null, until: item ? day(item.date_stop) : null,
              fetchedAt: new Date(clock()).toISOString() };
          }, previous?.result.supporters),
        ]);
        return { status: 'ready', snapshot: { ...window, rows, fetchedAt: new Date(clock()).toISOString() }, daily, supporters };
      } catch (error) {
        return { status: previous?.result.snapshot ? 'stale' : 'unavailable', snapshot: previous?.result.snapshot ?? null,
          ...(previous?.result.daily ? { daily: { ...previous.result.daily, status: previous.result.daily.snapshot ? 'stale' as const : 'unavailable' as const } } : {}),
          ...(previous?.result.supporters ? { supporters: { ...previous.result.supporters, status: previous.result.supporters.snapshot ? 'stale' as const : 'unavailable' as const } } : {}),
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
