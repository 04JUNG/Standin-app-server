import { randomUUID } from "node:crypto";
import { queryOne, execute } from "../db.js";
import { sanitizeProgress, type AnalysisProgress } from "./progress.js";

export interface ProgressFence { workerId: string; attempt: number }
export interface ProgressRun { id: string; runId: string }

/** Claim/reset is tied to the worker lease, never to process-local memory. */
export async function beginProgress(id: string, fence?: ProgressFence): Promise<ProgressRun | undefined> {
  const runId = randomUUID();
  const row = await queryOne<{ id: string }>(
    `UPDATE jobs SET progress_run_id=$2, progress_json=NULL, progress_source_sequence=0
     WHERE id=$1 AND status='running' AND progress_run_id IS NULL
       AND (($3::text IS NULL AND lease_owner IS NULL) OR
            (lease_owner=$3 AND attempt_count=$4 AND lease_expires_at > $5))
     RETURNING id`,
    [id, runId, fence?.workerId ?? null, fence?.attempt ?? null, new Date().toISOString()],
  );
  return row ? { id, runId } : undefined;
}

export async function writeProgress(run: ProgressRun, raw: unknown): Promise<boolean> {
  const p = sanitizeProgress(raw);
  if (!p) return false;
  return (await execute(
    `UPDATE jobs SET progress_sequence=progress_sequence+1, progress_source_sequence=$3,
       progress_json=jsonb_set($4::jsonb, '{sequence}', to_jsonb(progress_sequence+1))
     WHERE id=$1 AND progress_run_id=$2 AND status='running'
       AND progress_source_sequence < $3
       AND (lease_owner IS NULL OR lease_expires_at > $5)`,
    [run.id, run.runId, p.sequence, JSON.stringify(p), new Date().toISOString()],
  )) === 1;
}

/** Called only AFTER owner lookup; status and payload are read in one jobs row. */
export function publicProgress(status: string, value: unknown): AnalysisProgress | undefined {
  if (status !== "running" || !value || typeof value !== "object") return;
  // Explicit field projection also protects reads from malformed/corrupt old rows.
  const p = value as AnalysisProgress;
  if (p.version !== "pose-analysis-progress.v1" || !Number.isSafeInteger(p.sequence) || !Array.isArray(p.people)) return;
  try {
  const internal = { ...p, people: p.people.map(person => ({ ...person,
    observations: Object.fromEntries((person.observations ?? []).flatMap(o => {
      if (!o || typeof o.id !== "string") return [];
      const [key, val] = o.id.split(":"); return key && val ? [[key,val]] : [];
    })),
    candidates: person.candidates?.flatMap(c => {
      if (!c || typeof c.thumbnailUrl !== "string") return [];
      const match = /^\/v1\/pose-candidates\/([^/?]+)\/thumbnail\?view=(front|back|side|three_quarter)(?:&revision=[^&]*)?$/.exec(c.thumbnailUrl);
      return match ? [{...c,thumbnailUrl:`/pose/${match[1]}/thumbnail?view=${match[2]}`}] : [];
    }),
  })) };
    const result = sanitizeProgress(internal);
    if (!result || typeof p.updatedAt !== "string" || !Number.isFinite(Date.parse(p.updatedAt))) return;
    result.updatedAt = p.updatedAt;
    return result;
  } catch { return; }
}
