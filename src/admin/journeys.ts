import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { JOURNEY_VERSION } from '../journey/contract.js';

// Individual paths require the new purpose-specific link consent, even if operational totals are available.
const visibleLinks = `SELECT l.* FROM journey_links l JOIN installations i ON i.id=l.installation_id
 JOIN journey_visitors v ON v.id=l.visitor_id
 WHERE l.revoked_at IS NULL AND l.expires_at>$2 AND v.revoked_at IS NULL AND v.expires_at>$2
 AND l.consented_at<=$2 AND i.revoked_at IS NULL AND i.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=i.id)`;

const webCte = `WITH web AS (
 SELECT e.* FROM journey_web_events e JOIN journey_visitors v ON v.id=e.visitor_id
 WHERE e.occurred_at >= $1 AND e.occurred_at <= $2 AND v.revoked_at IS NULL AND v.expires_at>$2
), dwell AS (
 SELECT visitor_id,page_id,section,SUM(elapsed_ms)::bigint AS ms FROM web
 WHERE event_name='section_engagement' GROUP BY visitor_id,page_id,section
), visits AS (
 SELECT visitor_id,MIN(occurred_at)::text AS "firstAt",MAX(occurred_at)::text AS "lastAt",
 count(DISTINCT page_id)::int AS pages,COUNT(*) FILTER(WHERE event_name='download_click')::int AS downloads,
 MAX(depth)::int AS depth FROM web GROUP BY visitor_id
), latest AS (
 SELECT DISTINCT ON(visitor_id) visitor_id,section,event_name,path,creative,source,device
 FROM web ORDER BY visitor_id,occurred_at DESC,sequence DESC,event_id DESC
), links AS (
 ${visibleLinks}
), app AS (
 SELECT l.visitor_id,l.id,
 EXISTS(SELECT 1 FROM jobs j WHERE j.installation_id=l.installation_id AND j.created_at::timestamptz>=l.consented_at
 AND j.created_at::timestamptz<=$2 AND j.status='completed') AS analyzed,
 EXISTS(SELECT 1 FROM journey_app_events e WHERE e.link_id=l.id AND e.event_name='export_completed'
 AND e.occurred_at>=l.consented_at AND e.occurred_at<=$2) AS exported
 FROM links l
) `;

export async function journeySummary(days:number,now=new Date().toISOString()) {
  if(!Number.isInteger(days)||days<1||days>90||!Number.isFinite(Date.parse(now)))throw Error('invalid_window');
  const since=new Date(Date.parse(now)-days*86400000).toISOString();
  const params=[since,now];
  const [totals,sections,visitors,installations]=await Promise.all([
    query(webCte+`SELECT (SELECT count(*)::int FROM visits) AS visitors,
      (SELECT count(DISTINCT page_id)::int FROM web) AS pages,
      (SELECT count(*)::int FROM visits WHERE downloads>0) AS "downloadVisitors",
      (SELECT COALESCE(sum(downloads),0)::int FROM visits) AS "downloadClicks",
      (SELECT count(DISTINCT a.visitor_id)::int FROM app a JOIN visits v ON v.visitor_id=a.visitor_id) AS "linkedVisitors",
      (SELECT count(DISTINCT a.visitor_id)::int FROM app a JOIN visits v ON v.visitor_id=a.visitor_id WHERE a.analyzed) AS "analyzedVisitors",
      (SELECT count(DISTINCT a.visitor_id)::int FROM app a JOIN visits v ON v.visitor_id=a.visitor_id WHERE a.exported) AS "exportedVisitors",
      (SELECT COALESCE(sum(ms),0)::bigint FROM dwell) AS "engagedMs"`,params),
    query(webCte+`SELECT w.section,count(DISTINCT w.visitor_id)::int AS visitors,count(DISTINCT w.page_id)::int AS pages,
      COALESCE((SELECT SUM(d.ms) FROM dwell d WHERE d.section=w.section),0)::bigint AS "engagedMs",
      (SELECT count(*)::int FROM latest l JOIN visits v ON v.visitor_id=l.visitor_id
       WHERE l.section=w.section AND v."lastAt"::timestamptz <= $2::timestamptz-interval '30 minutes') AS "lastObserved"
      FROM web w WHERE w.event_name IN ('section_view','section_engagement') GROUP BY w.section ORDER BY visitors DESC`,params),
    query<Record<string,unknown> & {visitor_id:string; linkedApps:number}>(webCte+`SELECT v.*,l.section,l.event_name AS "lastEvent",l.path,l.creative,l.source,l.device,
      COALESCE((SELECT sum(d.ms) FROM dwell d WHERE d.visitor_id=v.visitor_id),0)::bigint AS "engagedMs",
      (SELECT count(*)::int FROM app a WHERE a.visitor_id=v.visitor_id) AS "linkedApps",
      (SELECT bool_or(a.analyzed) FROM app a WHERE a.visitor_id=v.visitor_id) AS analyzed,
      (SELECT bool_or(a.exported) FROM app a WHERE a.visitor_id=v.visitor_id) AS exported,
      (SELECT COALESCE(json_agg(t ORDER BY t.at,t.sequence),'[]') FROM (
        SELECT event_name AS name,section,target,occurred_at::text AS at,sequence FROM web e
        WHERE e.visitor_id=v.visitor_id AND event_name NOT IN ('section_engagement','scroll_depth')
        ORDER BY occurred_at DESC,sequence DESC LIMIT 40) t) AS timeline
      FROM visits v JOIN latest l ON l.visitor_id=v.visitor_id ORDER BY v."lastAt"::timestamptz DESC,v.visitor_id LIMIT 100`,params),
    query(`WITH links AS (${visibleLinks}), eligible AS (
      SELECT i.* FROM installations i JOIN links l ON l.installation_id=i.id
      WHERE i.created_at::timestamptz >= $1 AND i.created_at::timestamptz<=$2
      ORDER BY i.created_at DESC,i.id LIMIT 100
    ) SELECT i.id,i.created_at AS "firstAt",i.last_seen_at AS "lastAt",i.app_version AS version,i.os_name AS os,
      l.visitor_id AS "visitorId",l.consented_at::text AS "linkedAt",
      (SELECT count(*)::int FROM jobs j WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.created_at::timestamptz<=$2) AS started,
      (SELECT count(*)::int FROM jobs j WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.created_at::timestamptz<=$2 AND j.status='completed') AS completed,
      (SELECT count(*)::int FROM jobs j WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.created_at::timestamptz<=$2 AND j.status='failed') AS failed,
      (SELECT MAX(j.updated_at)::text FROM jobs j WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.updated_at::timestamptz<=$2) AS "lastJobAt",
      (SELECT COALESCE(json_agg(t ORDER BY t.at),'[]') FROM (
        SELECT e.event_name AS name,e.occurred_at::text AS at FROM journey_app_events e WHERE e.link_id=l.id AND e.occurred_at<=$2
        UNION ALL SELECT 'analysis_started',j.created_at FROM jobs j WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.created_at::timestamptz<=$2
        UNION ALL SELECT CASE WHEN j.status='completed' THEN 'analysis_success' ELSE 'analysis_failed' END,j.updated_at FROM jobs j
        WHERE j.installation_id=i.id AND j.created_at::timestamptz>=l.consented_at AND j.updated_at::timestamptz<=$2 AND j.status IN ('completed','failed')
        ORDER BY at DESC LIMIT 40) t) AS timeline
      FROM eligible i JOIN links l ON l.installation_id=i.id ORDER BY i.created_at DESC,i.id`,params)
  ]);
  const label=(id:string)=>createHash('sha256').update('journey-display:'+id).digest('hex').slice(0,12);
  return {status:'ready' as const,version:JOURNEY_VERSION,since,until:now,totals:totals[0],sections,
    visitors:visitors.map(v=>({...v,visitor_id:undefined,id:label(String(v.visitor_id))})),
    installations:installations.map(i=>({...i,id:label(String(i.id)),visitorId:i.visitorId?label(String(i.visitorId)):null})),
    rowLimit:100,retentionDays:90,linkedAppOnlyAfterConsent:true};
}
