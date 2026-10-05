import { config } from "../config.js";
import { query } from "../db.js";
import { GAP_THRESHOLDS, type LibraryWeekRow, type VlmPromptRow } from "./library.js";

function since(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 개발 단말(쿼터 면제 설치)의 시험 분석은 사용자 공백이 아니므로 뺀다. */
function exempt(): string[] {
  return [...config.quotaExemptInstallations];
}

/** 주(월요일 시작, UTC) × 라이브러리 버전 × coverage별 공백 집계. */
export async function libraryWeekly(days: number): Promise<LibraryWeekRow[]> {
  return query<LibraryWeekRow>(
    `SELECT
       to_char(date_trunc('week', created_at::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
       pose_library_version,
       coverage_class,
       count(*)::int AS people,
       count(*) FILTER (WHERE eligible)::int AS eligible,
       count(*) FILTER (WHERE eligible AND top1_distance > $3 AND top1_distance <= $4)::int AS weak_gap,
       count(*) FILTER (WHERE eligible AND top1_distance > $4 AND top1_distance <= $5)::int AS strong_gap,
       count(*) FILTER (WHERE eligible AND top1_distance > $5)::int AS extraction_suspect,
       count(*) FILTER (WHERE eligible AND selected)::int AS selected,
       count(*) FILTER (WHERE eligible AND irrelevant_feedback)::int AS irrelevant,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY top1_distance)
         FILTER (WHERE eligible) AS top1_median
     FROM library_observations_v1
     WHERE created_at >= $1 AND NOT (installation_id = ANY($2::text[]))
     GROUP BY 1, 2, 3
     ORDER BY 1 DESC, 2, 3`,
    [since(days), exempt(), GAP_THRESHOLDS.weak, GAP_THRESHOLDS.strong, GAP_THRESHOLDS.extractionCap],
  );
}

/** VLM 프롬프트 버전별 route 분포·인원수 일치·인물 태그 채움. */
export async function vlmPrompts(days: number): Promise<VlmPromptRow[]> {
  return query<VlmPromptRow>(
    `WITH scoped AS (
       SELECT j.id,
              COALESCE(j.inference_metadata_json::jsonb ->> 'vlmPromptVersion', 'unrecorded')
                AS prompt_version,
              j.cut_summary_json::jsonb AS summary
       FROM jobs j
       WHERE j.created_at >= $1 AND j.status = 'completed' AND j.installation_id IS NOT NULL
         AND NOT (j.installation_id = ANY($2::text[]))
     ),
     people AS (
       SELECT s.prompt_version,
              count(*)::int AS people,
              count(*) FILTER (WHERE ap.person_tags_json::jsonb ->> 'action' IS NOT NULL
                                  OR ap.person_tags_json::jsonb ->> 'view' IS NOT NULL)::int AS tagged,
              count(*) FILTER (WHERE ap.person_tags_json::jsonb ->> 'source' = 'vlm_person')::int
                AS vlm_person,
              count(*) FILTER (WHERE ap.person_tags_json::jsonb ->> 'source' = 'legacy_cut')::int
                AS legacy_cut
       FROM scoped s
       JOIN analysis_people ap ON ap.job_id = s.id
       GROUP BY 1
     )
     SELECT s.prompt_version,
            count(*)::int AS jobs,
            count(*) FILTER (WHERE s.summary ->> 'route' = 'core')::int AS core,
            count(*) FILTER (WHERE s.summary ->> 'route' = 'bust')::int AS bust,
            count(*) FILTER (WHERE s.summary ->> 'route' = 'skip')::int AS skip,
            count(*) FILTER (WHERE s.summary ->> 'route' IS NULL)::int AS unrecorded_route,
            count(*) FILTER (WHERE s.summary ->> 'countConfidence' = 'high')::int AS count_high,
            count(*) FILTER (WHERE s.summary ->> 'countConfidence' IS NOT NULL)::int AS count_known,
            COALESCE(p.people, 0) AS people,
            COALESCE(p.tagged, 0) AS tagged,
            COALESCE(p.vlm_person, 0) AS vlm_person,
            COALESCE(p.legacy_cut, 0) AS legacy_cut
     FROM scoped s
     LEFT JOIN people p USING (prompt_version)
     GROUP BY s.prompt_version, p.people, p.tagged, p.vlm_person, p.legacy_cut
     ORDER BY jobs DESC`,
    [since(days), exempt()],
  );
}
