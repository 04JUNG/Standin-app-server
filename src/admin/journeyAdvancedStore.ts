import { query } from "../db.js";
import {
  buildAdvanced,
  type UsageEvent,
  type UsageJob,
} from "./journeyAdvanced.js";
import type { JourneyRow, JourneyWindow } from "./journey.js";
export const ADVANCED_EVENT_LIMIT = 50000;
// The existing broad review mode may include nonconsenting server jobs. This extension's
// event/retention cohort is deliberately stricter: only current valid consent is eligible.
export const ADVANCED_EVENTS_SQL = `SELECT e.event_id,e.installation_id,i.created_at AS installation_created_at,
 e.job_id,e.event_name,e.occurred_at,e.sequence_number,j.source,
 jsonb_build_object(
 'telemetryVersion',e.properties_json::jsonb->'telemetryVersion','sessionId',e.properties_json::jsonb->'sessionId',
 'attemptId',e.properties_json::jsonb->'attemptId','feature',e.properties_json::jsonb->'feature',
 'action',e.properties_json::jsonb->'action','surface',e.properties_json::jsonb->'surface',
 'osName',e.properties_json::jsonb->'osName','appVersion',e.properties_json::jsonb->'appVersion',
 'source',e.properties_json::jsonb->'source','nativeDiskWrite',e.properties_json::jsonb->'nativeDiskWrite',
 'httpStatus',e.properties_json::jsonb->'httpStatus','errorCategory',e.properties_json::jsonb->'errorCategory','code',e.properties_json::jsonb->'code',
 'phase',e.properties_json::jsonb->'phase','reason',e.properties_json::jsonb->'reason',
 'writingElapsedMs',e.properties_json::jsonb->'writingElapsedMs',
 'resultCount',e.properties_json::jsonb->'resultCount','searchOrdinal',e.properties_json::jsonb->'searchOrdinal',
 'candidateCount',e.properties_json::jsonb->'candidateCount','peopleCount',e.properties_json::jsonb->'peopleCount',
 'zeroCandidatePeople',e.properties_json::jsonb->'zeroCandidatePeople','peopleWithCandidates',e.properties_json::jsonb->'peopleWithCandidates',
 'usedHandLibrary',e.properties_json::jsonb->'usedHandLibrary','usedBodySelection',e.properties_json::jsonb->'usedBodySelection',
 'usedBodyCustom',e.properties_json::jsonb->'usedBodyCustom','fromHistory',e.properties_json::jsonb->'fromHistory','fromSemanticSearch',e.properties_json::jsonb->'fromSemanticSearch',
 'candidateChanged',coalesce(e.properties_json::jsonb->>'previousCandidateId' <> e.properties_json::jsonb->>'candidateId',false)
 ) AS properties
 FROM quality_review_analytics_events e JOIN quality_review_installations i ON i.id=e.installation_id
 LEFT JOIN quality_review_jobs j ON j.id=e.job_id AND j.installation_id=e.installation_id
 WHERE e.occurred_at >= $1 AND e.occurred_at <= $2
 AND i.quality_personal_data AND i.quality_content_license AND i.quality_consent_id IS NOT NULL
 AND e.quality_consent_id=i.quality_consent_id
 AND (e.job_id IS NULL OR j.quality_consent_id=i.quality_consent_id)
 AND e.properties_json::jsonb->>'telemetryVersion'='2'
 AND e.properties_json::jsonb->>'sessionId' ~ '^[a-zA-Z0-9_-]{1,128}$'
 AND ($3='all' OR ($3='internal')=EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=e.installation_id))
 ORDER BY e.occurred_at,e.sequence_number,e.event_id LIMIT 50001`;
export const ADVANCED_JOBS_SQL = `SELECT j.id,j.installation_id,j.created_at,j.completed_at,j.status,j.source,j.error_code
 FROM quality_review_jobs j JOIN quality_review_installations i ON i.id=j.installation_id
 WHERE j.created_at >= $1 AND j.created_at <= $2
 AND i.quality_personal_data AND i.quality_content_license AND i.quality_consent_id IS NOT NULL
 AND j.quality_consent_id=i.quality_consent_id
 AND ($3='all' OR ($3='internal')=EXISTS(SELECT 1 FROM internal_installations x WHERE x.id=j.installation_id))
 ORDER BY j.created_at,j.id LIMIT 50001`;
export async function advancedMetrics(
  rows: JourneyRow[],
  window: JourneyWindow,
) {
  const historyFrom = window.from;
  const [events, jobs] = await Promise.all([
    query<UsageEvent>(ADVANCED_EVENTS_SQL, [
      historyFrom,
      window.to,
      window.audience,
    ]),
    query<UsageJob>(ADVANCED_JOBS_SQL, [
      historyFrom,
      window.to,
      window.audience,
    ]),
  ]);
  if (
    events.length > ADVANCED_EVENT_LIMIT ||
    jobs.length > ADVANCED_EVENT_LIMIT
  )
    throw new Error("JOURNEY_HISTORY_TOO_LARGE");
  return buildAdvanced(events, jobs, rows, window, historyFrom);
}
