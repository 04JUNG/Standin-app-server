// 러프·결과 모아 보기 SQL. 동의 철회·삭제 요청 설치를 빼고, 원본이 남아 있는 90일 안만 본다.
import { query } from "../db.js";
import { GALLERY_DAYS, GALLERY_PAGE, type GalleryGroup, type GalleryQuery } from "./gallery.js";

const OUTCOME_CASE = `CASE
    WHEN j.status = 'failed' THEN 'failed'
    WHEN j.status <> 'completed' THEN 'in_progress'
    WHEN coalesce(p.n, 0) = 0 THEN 'zero_people'
    WHEN coalesce(s.n, 0) > 0 THEN 'selected'
    ELSE 'no_selection' END`;

const KST_DATE = `to_char((j.created_at::timestamptz AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD')`;

/** 폴더 키를 만드는 식. 묶음마다 다르다. */
function keyExpr(group: GalleryGroup): string {
  if (group === "date") return KST_DATE;
  if (group === "installation") return "j.installation_id";
  return OUTCOME_CASE;
}

const BASE = `
  FROM jobs j
  JOIN installations i ON i.id = j.installation_id
  LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM analysis_people ap WHERE ap.job_id = j.id) p ON TRUE
  LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM confirmed_selections cs WHERE cs.job_id = j.id) s ON TRUE
  WHERE j.created_at >= $1
    AND i.revoked_at IS NULL
    AND i.deletion_requested_at IS NULL`;

function since(): string {
  return new Date(Date.now() - GALLERY_DAYS * 86_400_000).toISOString();
}

export interface FolderRow {
  key: string;
  count: number;
  with_image: number;
  last_at: string;
}

export async function galleryFolders(group: GalleryGroup): Promise<FolderRow[]> {
  const order = group === "status" ? "key" : "last_at DESC";
  return query<FolderRow>(
    `SELECT ${keyExpr(group)} AS key,
            count(*)::int AS count,
            count(*) FILTER (WHERE j.input_s3_key IS NOT NULL)::int AS with_image,
            max(j.created_at) AS last_at
     ${BASE}
     GROUP BY 1
     ORDER BY ${order}
     LIMIT 200`,
    [since()],
  );
}

export interface GalleryRow {
  id: string;
  installation_id: string;
  status: string;
  created_at: string;
  error_code: string | null;
  input_s3_key: string | null;
  person_count: number;
  selection_count: number;
  outcome: string;
  exported: boolean;
  refined: boolean;
}

export async function galleryItems(params: GalleryQuery): Promise<GalleryRow[]> {
  return query<GalleryRow>(
    `SELECT j.id, j.installation_id, j.status, j.created_at, j.error_code, j.input_s3_key,
            coalesce(p.n, 0)::int AS person_count,
            coalesce(s.n, 0)::int AS selection_count,
            ${OUTCOME_CASE} AS outcome,
            EXISTS (SELECT 1 FROM export_events e WHERE e.job_id = j.id AND e.status = 'completed') AS exported,
            EXISTS (SELECT 1 FROM refined_artifacts r WHERE r.job_id = j.id AND r.refined) AS refined
     ${BASE}
       AND ${keyExpr(params.group)} = $2
       AND ($3::text IS NULL OR (j.created_at, j.id) < ($3, $4))
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT $5`,
    [since(), params.key, params.cursor?.createdAt ?? null, params.cursor?.id ?? null, GALLERY_PAGE + 1],
  );
}
