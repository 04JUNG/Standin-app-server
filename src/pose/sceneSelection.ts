import { query } from "../db.js";
import type { SceneRef } from "./sceneTypes.js";
import { SceneError } from "./sceneContract.js";
export type SceneSelectionRevisions = { personIndex: number; candidateId: string; confirmedAt: string }[];
/** The persisted confirmed_at is the existing selection revision, independent of job.updatedAt. */
export async function loadSceneSelectionRevisions(owner: string, jobId: string, refs: SceneRef[]): Promise<SceneSelectionRevisions> {
  const rows = await query<{ person_index: number; candidate_id: string; confirmed_at: string }>(
    `SELECT s.person_index, s.candidate_id, s.confirmed_at FROM confirmed_selections s JOIN jobs j ON j.id=s.job_id
     WHERE s.job_id=$1 AND s.person_index=ANY($2::int[]) AND s.installation_id=$3 AND j.installation_id=$3
       AND j.status='completed' AND j.created_at::timestamptz > now() - interval '90 days'`,
    [jobId, refs.map(r => r.personIndex), owner]);
  return refs.map(ref => {
    const row = rows.find(r => r.person_index === ref.personIndex && r.candidate_id === ref.candidateId);
    if (!row || typeof row.confirmed_at !== "string" || !row.confirmed_at)
      throw new SceneError("SCENE_SOURCE_CHANGED", "confirmed selection revision unavailable", false, "source_validation");
    return { personIndex: ref.personIndex, candidateId: ref.candidateId, confirmedAt: row.confirmed_at };
  });
}
