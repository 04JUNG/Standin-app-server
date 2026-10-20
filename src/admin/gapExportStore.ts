import { query } from "../db.js";
import type { ExportState, GapObservationRow } from "./gapExport.js";

/**
 * gap_observations_v1에서 한 페이지를 읽는다.
 *
 * 범위는 export를 시작한 시각에 고정한다(`until`). 그 뒤에 끝난 분석은 다음 export에서 받는다.
 * 정렬 키 (created_at, job_id, person_index)로 이어 읽으므로 페이지 사이에 행이 지워져도
 * 다른 행을 건너뛰지 않는다. created_at은 모두 toISOString() 형식이라 문자열 비교가 시간 순서다.
 */
export async function listGapObservations(input: {
  since: string;
  until: string;
  after: ExportState["after"];
  excludeInstallations: string[];
  limit: number;
}): Promise<GapObservationRow[]> {
  return query<GapObservationRow>(
    `SELECT * FROM gap_observations_v1
     WHERE created_at >= $1 AND created_at <= $2
       AND NOT (installation_id = ANY($3::text[]))
       AND ($4::text IS NULL OR (created_at, job_id, person_index) > ($4::text, $5::text, $6::int))
     ORDER BY created_at, job_id, person_index
     LIMIT $7`,
    [
      input.since,
      input.until,
      input.excludeInstallations,
      input.after?.createdAt ?? null,
      input.after?.jobId ?? null,
      input.after?.personIndex ?? null,
      input.limit,
    ],
  );
}
