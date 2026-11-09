import { BLOG_CATALOG, BLOG_SHARED_SECTIONS } from './blogCatalog.js';
export const JOURNEY_VERSION = '2026-11-09';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const WEB_EVENTS = ['page_view','section_view','section_engagement','scroll_depth','cta_click','download_click','app_open_click','pc_link_copy','page_hidden','page_exit'] as const;
export const SECTIONS = ['page','hero','input','process','result','features','guides','beta','faq','footer','blog-list',...Object.keys(BLOG_SHARED_SECTIONS),...Object.values(BLOG_CATALOG).flatMap(post=>Object.keys(post.sections))];
export const TARGETS = ['none','download_windows','download_macos','app_open','pc_copy','beta','guide','blog','toc','feedback','faq','external'] as const;
export const PATHS = ['/','/ja/','/guides/rough-to-3d-pose/','/guides/clip-studio-pose-import/','/blog/',...Object.keys(BLOG_CATALOG)];
export const SOURCES = ['instagram','google','naver','daum','bing','yahoo','x','youtube','facebook','internal','referral','direct','other'] as const;
export const APP_EVENTS = ['app_started','input_confirmed','results_viewed','candidate_selected','selection_confirmed','analysis_failed','export_completed','export_failed','capture_failed'] as const;
export type WebEvent = {
  id: string; page: string; sequence: number; name: typeof WEB_EVENTS[number]; at: string;
  path: typeof PATHS[number]; section: typeof SECTIONS[number]; target: typeof TARGETS[number];
  creative: 'meta-poster-a'|'meta-hook-a'|'other'; source: typeof SOURCES[number];
  device: 'mobile'|'desktop'; elapsedMs: number; depth: number;
};
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
function member(value: unknown, values: readonly string[]) { return typeof value === 'string' && values.includes(value); }
export function validTime(value: unknown, now = Date.now()) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now+60000 && Date.parse(value) >= now-86400000;
}
export function parseWebEvent(raw: unknown, now = Date.now()): WebEvent | null {
  const v = record(raw);
  if (!v || Object.keys(v).sort().join(',') !== 'at,creative,depth,device,elapsedMs,id,name,page,path,section,sequence,source,target' ||
      typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.page !== 'string' || !UUID.test(v.page) ||
      !Number.isSafeInteger(v.sequence) || Number(v.sequence)<0 || Number(v.sequence)>100000 ||
      !member(v.name,WEB_EVENTS) || !validTime(v.at,now) || !member(v.path,PATHS) || !member(v.section,SECTIONS) ||
      !member(v.target,TARGETS) || !member(v.creative,['meta-poster-a','meta-hook-a','other']) ||
      !member(v.source,SOURCES) || !member(v.device,['mobile','desktop']) ||
      !Number.isSafeInteger(v.elapsedMs) || Number(v.elapsedMs)<0 || Number(v.elapsedMs)>3600000 ||
      !Number.isSafeInteger(v.depth) || Number(v.depth)<0 || Number(v.depth)>100) return null;
  if (typeof v.path === 'string' && BLOG_CATALOG[v.path] && !Object.hasOwn(BLOG_SHARED_SECTIONS, String(v.section)) && !Object.hasOwn(BLOG_CATALOG[v.path].sections, String(v.section))) return null;
  return v as WebEvent;
}
