import { query } from "../db.js";
import { buildJourney, type JourneyRow, type JourneyWindow } from "./journey.js";

// Retain review/consent/deletion/internal visibility scopes; no raw source images, queries,
// candidate IDs, file paths, installation identifiers or session IDs leave this aggregate API.
export const JOURNEY_SQL = `WITH scoped AS (
 SELECT j.id,j.installation_id,j.created_at,j.completed_at,j.status,
 CASE WHEN EXISTS (SELECT 1 FROM internal_installations x WHERE x.id=j.installation_id)
 THEN 'internal' ELSE 'unclassified' END AS audience
 FROM quality_review_jobs j WHERE j.created_at >= $1 AND j.created_at <= $2
 AND j.installation_id IS NOT NULL
), filtered AS (SELECT * FROM scoped WHERE $3='all' OR audience=$3)
SELECT j.*,
 (SELECT min(cs.confirmed_at) FROM quality_review_confirmed_selections cs
  WHERE cs.job_id=j.id AND cs.confirmed_at <= $2) AS confirmed_at,
 coalesce(ev.events,'[]'::json) AS events,
 terminal.event_name AS last_outcome, terminal.occurred_at AS last_outcome_at
FROM filtered j
LEFT JOIN LATERAL (
 SELECT json_agg(g) AS events FROM (
  SELECT e.event_name AS name,min(e.occurred_at) AS first,max(e.occurred_at) AS last,
  count(*)::int AS count,
  CASE WHEN e.properties_json::jsonb->>'telemetryVersion'='2' THEN 2 ELSE 0 END AS version,
  coalesce(e.properties_json::jsonb->>'nativeDiskWrite'='true',false) AS native,
  coalesce(e.properties_json::jsonb->>'sessionId' ~ '^[a-zA-Z0-9_-]{1,128}$',false) AS session,
  CASE WHEN e.properties_json::jsonb->>'appVersion' ~ '^[a-zA-Z0-9._+-]{1,64}$' THEN e.properties_json::jsonb->>'appVersion' ELSE 'unknown' END AS "appVersion",
  CASE WHEN e.properties_json::jsonb->>'surface' IN ('app','bar') THEN e.properties_json::jsonb->>'surface' ELSE 'unknown' END AS surface
  FROM quality_review_analytics_events e WHERE e.job_id=j.id AND e.installation_id=j.installation_id
  AND e.occurred_at >= j.created_at AND e.occurred_at <= $2
  GROUP BY 1,5,6,7,8,9
 ) g
) ev ON TRUE
LEFT JOIN LATERAL (
 SELECT e.event_name,e.occurred_at FROM quality_review_analytics_events e
 WHERE e.job_id=j.id AND e.installation_id=j.installation_id
 AND e.occurred_at >= j.created_at AND e.occurred_at <= $2
 AND e.properties_json::jsonb->>'telemetryVersion'='2'
 AND e.properties_json::jsonb->>'sessionId' ~ '^[a-zA-Z0-9_-]{1,128}$'
 AND (e.event_name <> 'export_completed' OR e.properties_json::jsonb->>'nativeDiskWrite'='true')
 AND e.event_name IN ('preparation_started','preparation_ready','preparation_failed',
 'export_requested','export_completed','export_failed','export_cancelled')
 ORDER BY e.occurred_at DESC,e.sequence_number DESC,e.event_id DESC LIMIT 1
) terminal ON TRUE
ORDER BY j.created_at DESC LIMIT 10001`;
export async function journeyMetrics(window:JourneyWindow) {
 const rows=await query<JourneyRow>(JOURNEY_SQL,[window.from,window.to,window.audience]);
 // Fail explicitly instead of silently changing the cohort denominator at high volume.
 if(rows.length>10000) throw new Error("JOURNEY_WINDOW_TOO_LARGE");
 const result=buildJourney(rows,window);
 const [inputs,durations]=await Promise.all([
   query<{key:string;events:number;installations:number}>(JOURNEY_INPUT_SQL,[window.from,window.to,window.audience]),
   query<{key:string;samples:number;medianMs:number|null;p90Ms:number|null}>(JOURNEY_DURATION_SQL,[window.from,window.to,window.audience]),
 ]);
 return {...result,
   inputs: ([['input_started','입력 시작'],['input_cancelled','입력 취소'],['input_failed','입력 실패']] as const).map(([key,label])=>({key,label,events:inputs.find(r=>r.key===key)?.events??0,installations:inputs.find(r=>r.key===key)?.installations??0})),
   durations:[...result.durations,...durations.map(d=>({...d,label:d.key==='preparation'?'파일 준비 (동일 시도)':'저장 요청 → 실제 저장 (동일 시도)'}))],
 };
}

/** Pre-job activity has its own event-time denominator; never divide these by job count. */
export const JOURNEY_INPUT_SQL = `SELECT e.event_name AS key,count(*)::int AS events,
 count(DISTINCT e.installation_id)::int AS installations
 FROM quality_review_analytics_events e
 WHERE e.occurred_at >= $1 AND e.occurred_at <= $2
 AND e.event_name IN ('input_started','input_cancelled','input_failed')
 AND e.properties_json::jsonb->>'telemetryVersion'='2'
 AND e.properties_json::jsonb->>'sessionId' ~ '^[a-zA-Z0-9_-]{1,128}$'
 AND ($3='all' OR ($3='internal')=EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=e.installation_id))
 GROUP BY e.event_name`;

/** Match a terminal event to its own job/session/attempt, never another retry. */
export const JOURNEY_DURATION_SQL = `WITH terminals AS (
 SELECT e.job_id,e.installation_id,e.event_name,
 e.properties_json::jsonb->>'sessionId' AS session_id,
 e.properties_json::jsonb->>'attemptId' AS attempt_id,
 min(e.occurred_at::timestamptz) AS finished
 FROM quality_review_analytics_events e JOIN quality_review_jobs j ON j.id=e.job_id
 WHERE j.created_at >= $1 AND j.created_at <= $2
 AND e.installation_id=j.installation_id AND e.occurred_at >= j.created_at AND e.occurred_at <= $2
 AND e.properties_json::jsonb->>'telemetryVersion'='2'
 AND e.properties_json::jsonb->>'sessionId' ~ '^[a-zA-Z0-9_-]{1,128}$'
 AND e.properties_json::jsonb->>'attemptId' ~ '^[a-zA-Z0-9_-]{1,128}$'
 AND (e.event_name='preparation_ready' OR (e.event_name='export_completed' AND e.properties_json::jsonb->>'nativeDiskWrite'='true'))
 AND ($3='all' OR ($3='internal')=EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=e.installation_id))
 GROUP BY 1,2,3,4,5
), durations AS (
 SELECT CASE WHEN t.event_name='preparation_ready' THEN 'preparation' ELSE 'nativeSave' END AS key,
 extract(epoch FROM (t.finished-s.started))*1000 AS elapsed
 FROM terminals t JOIN LATERAL (
 SELECT min(e.occurred_at::timestamptz) AS started FROM quality_review_analytics_events e
 WHERE e.job_id=t.job_id AND e.installation_id=t.installation_id
 AND e.properties_json::jsonb->>'sessionId'=t.session_id
 AND e.properties_json::jsonb->>'attemptId'=t.attempt_id
 AND e.properties_json::jsonb->>'telemetryVersion'='2'
 AND e.event_name=CASE WHEN t.event_name='preparation_ready' THEN 'preparation_started' ELSE 'export_requested' END
 AND e.occurred_at::timestamptz <= t.finished AND e.occurred_at >= $1
 ) s ON s.started IS NOT NULL
)
SELECT key,count(*)::int AS samples,
 percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed)::float8 AS "medianMs",
 percentile_cont(0.9) WITHIN GROUP (ORDER BY elapsed)::float8 AS "p90Ms"
 FROM durations GROUP BY key`;
