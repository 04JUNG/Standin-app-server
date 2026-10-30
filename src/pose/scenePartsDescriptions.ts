import { queryOne } from "../db.js";
import { SceneError } from "./sceneContract.js";
export type SceneDescriptions = { personIndex: number; description: string | null }[];
/** Read only the existing consent/retention-bound source; never trust client VLM text. */
export async function loadSceneDescriptions(owner: string, jobId: string, personIndices: number[]): Promise<SceneDescriptions> {
  const out: SceneDescriptions = [];
  for (const personIndex of personIndices) {
    const row = await queryOne<{ person_tags_json: string | null }>(
      `SELECT ap.person_tags_json FROM analysis_people ap JOIN jobs j ON j.id=ap.job_id
       JOIN installations i ON i.id=j.installation_id
       WHERE j.id=$1 AND j.installation_id=$2 AND ap.person_index=$3
         AND j.quality_consent_id=i.quality_consent_id AND i.quality_personal_data=true
         AND i.quality_content_license=true AND i.revoked_at IS NULL AND i.deletion_requested_at IS NULL`,
      [jobId, owner, personIndex]);
    out.push({ personIndex, description: storedSceneDescription(row?.person_tags_json ?? null) });
  }
  return out;
}
export function storedSceneDescription(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error();
    const pose = (stored as { poseDescription?: unknown }).poseDescription;
    if (pose === undefined || pose === null) return null;
    if (typeof pose !== "object" || Array.isArray(pose)) throw new Error();
    // Preserve both stored texts exactly and label their original fields. No
    // title substitution, screen/anatomical side inference, trimming or synthesis.
    const { bodyDetails, searchText } = pose as Record<string, unknown>;
    if ([bodyDetails, searchText].some(v => v !== undefined && v !== null && typeof v !== "string")) throw new Error();
    if (!bodyDetails && !searchText) return null;
    const description = JSON.stringify({ bodyDetails: bodyDetails ?? null, searchText: searchText ?? null });
    if (description.length > 4096) throw new Error();
    return description;
  } catch {
    throw new SceneError("PARTS_INVALID_INPUT", "stored description cannot be represented without loss", false, "source_validation");
  }
}
