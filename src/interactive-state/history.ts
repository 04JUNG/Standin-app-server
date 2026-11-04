import { query } from "../db.js";
import type { JobHistoryItem } from "../jobs/history.js";
import type { Operation } from "./model.js";
export interface RepresentativeFrame {
  url: string;
  revision: number;
  stateHash: string;
  sha256: string;
  provenance: "server-verified-fbx";
  rendererVersion: string;
}
/** Metadata lookup only: never runs conversion/render or waits for a capture. */
export async function historyFrames(
  installationId: string,
  items: JobHistoryItem[],
) {
  if (!items.length) return new Map<string, RepresentativeFrame>();
  const rows = await query<{ job_id: string; value: Operation }>(
    `
    SELECT DISTINCT ON (h.job_id) h.job_id,o.value FROM interactive_heads h
    JOIN interactive_history_frames f ON f.job_id=h.job_id AND f.person_index=h.person_index
    JOIN LATERAL (SELECT f.value) o ON o.value->>'operationId'=h.operation_id
    JOIN jobs j ON j.id=h.job_id AND j.installation_id=h.installation_id
    JOIN confirmed_selections cs ON cs.job_id=h.job_id AND cs.person_index=h.person_index
      AND cs.candidate_id=o.value->>'candidateId'
    WHERE h.installation_id=$1 AND h.job_id=ANY($2::text[]) AND o.value->>'previewState'='authoritative'
      AND o.value->>'exportState'='ready' AND o.value->'poster'!='null'::jsonb
      AND h.person_index=(SELECT s.person_index FROM confirmed_selections s WHERE s.job_id=h.job_id ORDER BY s.person_index LIMIT 1)
    ORDER BY h.job_id,h.person_index`,
    [installationId, items.map((i) => i.jobId)],
  );
  return new Map(
    rows.flatMap(({ job_id, value: o }) =>
      o.stateHash && o.poster
        ? [
            [
              job_id,
              {
                url: `/v1/analysis/jobs/${encodeURIComponent(job_id)}/people/${o.personIndex}/interactive-frame`,
                revision: o.revision,
                stateHash: o.stateHash,
                sha256: o.poster.sha256,
                rendererVersion: o.poster.renderer,
                provenance: "server-verified-fbx" as const,
              },
            ],
          ]
        : [],
    ),
  );
}
