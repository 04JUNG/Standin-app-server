import { query, queryOne } from "../db.js";
import type { CustomBodyQuery, CustomBodyRow } from "./customBodies.js";

// Current stored cards, not analytics events. Existing review/internal visibility is retained;
// card content additionally requires current quality consent even under broad review mode.
export const CUSTOM_BODY_SCOPE = `FROM body_preferences p JOIN quality_review_installations i ON i.id=p.installation_id
 WHERE i.quality_personal_data AND i.quality_content_license AND i.quality_consent_id IS NOT NULL
 AND i.revoked_at IS NULL AND i.deletion_requested_at IS NULL`;
const SELECT = `SELECT i.id AS installation_id,i.last_seen_at,i.app_version,i.os_name,p.value `;
export const CUSTOM_BODIES_SQL = `${SELECT}${CUSTOM_BODY_SCOPE}
 AND ($1::text IS NULL OR i.id=$1)
 AND ($2::text IS NULL OR (i.last_seen_at,i.id)<($2::text,$3::text))
 AND ((jsonb_typeof(p.value->'cards')='array' AND p.value->'cards' <> '[]'::jsonb)
 OR p.value->'shapeDefault' IS NOT NULL AND p.value->'shapeDefault' <> 'null'::jsonb)
 ORDER BY i.last_seen_at DESC,i.id DESC LIMIT $4`;
export async function listCustomBodyRows(q: CustomBodyQuery) {
  return query<CustomBodyRow>(CUSTOM_BODIES_SQL, [
    q.installationId,
    q.cursor?.at ?? null,
    q.cursor?.id ?? null,
    q.limit + 1,
  ]);
}
export const CUSTOM_BODY_ROW_SQL = `${SELECT}${CUSTOM_BODY_SCOPE} AND i.id=$1`;
export async function findCustomBodyRow(installationId: string) {
  return queryOne<CustomBodyRow>(CUSTOM_BODY_ROW_SQL, [installationId]);
}
