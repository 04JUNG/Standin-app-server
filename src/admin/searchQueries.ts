// 텍스트 검색 Job의 검색어. 이런 Job은 이미지가 없어 대시보드가 "원본 만료"로 보이던 것을
// 검색어로 대신 보여 준다. 앱이 쓰는 작업 기록 API(jobs/history.ts)는 건드리지 않는다.
import { query } from "../db.js";

export const SEMANTIC_SOURCE = "semantic";

/**
 * jobId → 검색어. 텍스트 검색 Job만 돌아온다.
 *
 * 검색어는 `result_json.semantic.query`에만 있다. result_json은 건당 수십~수백 KB라
 * 목록 SQL에 넣지 않고, 화면에 올라간 검색 Job만 따로 꺼낸다.
 */
export async function searchQueries(jobIds: string[]): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await query<{ id: string; q: string | null }>(
    `SELECT id, result_json::jsonb #>> '{semantic,query}' AS q
       FROM quality_review_jobs
      WHERE id = ANY($1) AND source = '${SEMANTIC_SOURCE}' AND result_json IS NOT NULL`,
    [jobIds],
  );
  return new Map(rows.flatMap((row) => (row.q ? [[row.id, row.q] as [string, string]] : [])));
}

/** 상세 화면처럼 result_json을 이미 읽은 경우. */
export function searchQueryOf(source: string | null, resultJson: string | null): string | null {
  if (source !== SEMANTIC_SOURCE || !resultJson) return null;
  try {
    const query = (JSON.parse(resultJson) as { semantic?: { query?: unknown } }).semantic?.query;
    return typeof query === "string" && query ? query : null;
  } catch {
    return null;
  }
}
