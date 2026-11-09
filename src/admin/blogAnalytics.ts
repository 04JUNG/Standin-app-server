import { query } from '../db.js';
import { BLOG_CATALOG, BLOG_SHARED_SECTIONS } from '../journey/blogCatalog.js';

// A view cohort requires an actual page_view in the selected window. Later events from
// earlier visits cannot inflate denominators; revoked/expired visitors are excluded.
const cte = `WITH events AS (
 SELECT e.* FROM journey_web_events e JOIN journey_visitors v ON v.id=e.visitor_id
 WHERE e.occurred_at >= $1 AND e.occurred_at <= $2 AND v.revoked_at IS NULL AND v.expires_at>$2
 AND e.path = ANY($3::text[])
), views AS (
 SELECT DISTINCT ON(visitor_id,page_id,path) visitor_id,page_id,path,source,device,occurred_at
 FROM events WHERE event_name='page_view' ORDER BY visitor_id,page_id,path,occurred_at,sequence
), tracked AS (
 SELECT e.* FROM events e JOIN views v USING(visitor_id,page_id,path)
), visits AS (
 SELECT v.visitor_id,v.page_id,v.path,v.source,v.device,v.occurred_at,
 COALESCE(SUM(e.elapsed_ms) FILTER(WHERE e.event_name='section_engagement' AND e.section<>'footer'),0)::bigint AS ms,
 COALESCE(MAX(e.depth),0)::int AS depth,
 bool_or(e.event_name IN ('section_view','section_engagement') AND e.section='article-related') AS reached_end,
 bool_or(e.event_name='cta_click' AND e.target='beta') AS download_cta
 FROM views v JOIN tracked e USING(visitor_id,page_id,path)
 GROUP BY v.visitor_id,v.page_id,v.path,v.source,v.device,v.occurred_at
), section_visits AS (
 SELECT visitor_id,page_id,path,section,
 COALESCE(SUM(elapsed_ms) FILTER(WHERE event_name='section_engagement'),0)::bigint AS ms
 FROM tracked WHERE event_name IN ('section_view','section_engagement')
 GROUP BY visitor_id,page_id,path,section
) `;
export async function blogAnalytics(days: number, now = new Date().toISOString()) {
  if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isFinite(Date.parse(now))) throw Error('invalid_window');
  const since = new Date(Date.parse(now) - days * 86400000).toISOString();
  const params = [since, now, Object.keys(BLOG_CATALOG)];
  const [totals, posts, sources, sections, daily] = await Promise.all([
    query(cte + `SELECT COUNT(*)::int AS views,COUNT(DISTINCT visitor_id)::int AS visitors,
      COALESCE(SUM(ms),0)::bigint AS "engagedMs",COUNT(*) FILTER(WHERE reached_end)::int AS "endViews",
      COUNT(*) FILTER(WHERE download_cta)::int AS "downloadCtaViews" FROM visits`, params),
    query(cte + `SELECT path,COUNT(*)::int AS views,COUNT(DISTINCT visitor_id)::int AS visitors,
      COALESCE(SUM(ms),0)::bigint AS "engagedMs",COUNT(*) FILTER(WHERE depth>=75)::int AS "depth75Views",
      COUNT(*) FILTER(WHERE reached_end)::int AS "endViews",COUNT(*) FILTER(WHERE download_cta)::int AS "downloadCtaViews",
      COUNT(*) FILTER(WHERE device='mobile')::int AS "mobileViews" FROM visits GROUP BY path ORDER BY views DESC,path`, params),
    query(cte + `SELECT path,source,COUNT(*)::int AS views,COUNT(DISTINCT visitor_id)::int AS visitors
      FROM visits GROUP BY path,source ORDER BY views DESC,path,source`, params),
    query(cte + `SELECT path,section,COUNT(*)::int AS "exposedViews",COUNT(DISTINCT visitor_id)::int AS visitors,
      COUNT(*) FILTER(WHERE ms>=5000)::int AS "engagedViews",SUM(ms)::bigint AS "engagedMs"
      FROM section_visits GROUP BY path,section`, params),
    query(cte + `SELECT (occurred_at AT TIME ZONE 'Asia/Seoul')::date::text AS day,COUNT(*)::int AS views,
      COUNT(DISTINCT visitor_id)::int AS visitors FROM visits GROUP BY day ORDER BY day`, params),
  ]);
  return { status: 'ready' as const, since, until: now, timezone: 'Asia/Seoul', measurementStarted: '2026-11-09',
    totals: totals[0], posts, sources, sections, daily,
    catalog: Object.entries(BLOG_CATALOG).map(([path, post]) => ({ path, title: post.title, sections: { 'article-intro': BLOG_SHARED_SECTIONS['article-intro'], ...post.sections, 'article-sources': BLOG_SHARED_SECTIONS['article-sources'], 'article-related': BLOG_SHARED_SECTIONS['article-related'], footer: BLOG_SHARED_SECTIONS.footer, page: BLOG_SHARED_SECTIONS.page } })) };
}
