// Job 저장소(PostgreSQL). result는 JSON 문자열로 저장.
// 인터페이스(createJob/getJob/updateJob)는 유지하되 Promise를 돌려준다.
import { randomUUID } from "node:crypto";
import { execute, queryOne, transaction } from "../db.js";
import type { AnalysisResult } from "../types.js";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  userId: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result: AnalysisResult | null;
  errorCode: string | null;
  rerunOf: string | null;
  installationId: string | null;
  inputS3Key: string | null;
}

interface JobRow {
  id: string;
  user_id: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  result_json: string | null;
  error_code: string | null;
  rerun_of: string | null;
  installation_id: string | null;
  input_s3_key: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    result: r.result_json ? (JSON.parse(r.result_json) as AnalysisResult) : null,
    errorCode: r.error_code,
    rerunOf: r.rerun_of,
    installationId: r.installation_id,
    inputS3Key: r.input_s3_key,
  };
}

export async function createJob(
  userId: string | null,
  rerunOf: string | null = null,
  input?: {
    installationId: string;
    source: "capture" | "file" | "clipboard";
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
  },
): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: `job_${randomUUID()}`,
    userId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    result: null,
    errorCode: null,
    rerunOf,
    installationId: input?.installationId ?? null,
    inputS3Key: null,
  };
  await execute(
    `INSERT INTO jobs
      (id, user_id, status, created_at, updated_at, result_json, error_code, rerun_of,
       installation_id, source, input_mime, input_size, input_width, input_height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      job.id,
      userId,
      job.status,
      now,
      now,
      null,
      null,
      rerunOf,
      input?.installationId ?? null,
      input?.source ?? null,
      input?.mime ?? null,
      input?.size ?? null,
      input?.width ?? null,
      input?.height ?? null,
    ],
  );
  return job;
}

export async function getOwnedJob(id: string, installationId: string): Promise<Job | undefined> {
  const row = await queryOne<JobRow>(
    "SELECT * FROM jobs WHERE id = $1 AND installation_id = $2",
    [id, installationId],
  );
  return row ? toJob(row) : undefined;
}

export async function setJobInput(
  id: string,
  input: { s3Key: string | null; sha256: string },
): Promise<void> {
  await execute(
    `UPDATE jobs SET input_s3_key = $2, input_sha256 = $3,
       input_stored_at = $4, updated_at = $4 WHERE id = $1`,
    [id, input.s3Key, input.sha256, new Date().toISOString()],
  );
}

export async function getJob(id: string): Promise<Job | undefined> {
  const row = await queryOne<JobRow>("SELECT * FROM jobs WHERE id = $1", [id]);
  return row ? toJob(row) : undefined;
}

/**
 * 지정한 필드만 갱신한다.
 *
 * 이전 구현은 "읽어서 병합 후 통째로 쓰기"였는데, 태스크가 여러 개면 두 갱신이
 * 서로를 덮어쓸 수 있다. 넘어온 필드만 COALESCE 없이 직접 지정해 그 창을 없앤다.
 */
export async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const sets: string[] = ["updated_at = $2"];
  const params: unknown[] = [id, new Date().toISOString()];

  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    if (patch.status === "running") {
      params.push(new Date().toISOString());
      sets.push(`started_at = $${params.length}`);
    }
    if (patch.status === "completed" || patch.status === "failed") {
      params.push(new Date().toISOString());
      sets.push(`completed_at = $${params.length}`);
    }
  }
  if (patch.result !== undefined) {
    params.push(patch.result ? JSON.stringify(patch.result) : null);
    sets.push(`result_json = $${params.length}`);
  }
  if (patch.errorCode !== undefined) {
    params.push(patch.errorCode);
    sets.push(`error_code = $${params.length}`);
  }

  await execute(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function persistAnalysisRecords(jobId: string, result: AnalysisResult): Promise<void> {
  await transaction(async (client) => {
    await client.query("DELETE FROM analysis_candidates WHERE job_id = $1", [jobId]);
    await client.query("DELETE FROM analysis_people WHERE job_id = $1", [jobId]);
    for (const person of result.candidatesByPerson) {
      await client.query(
        `INSERT INTO analysis_people
          (job_id, person_index, bbox_json, tags_json, skeleton_json, confidence,
           candidate_count, candidate_shortfall_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          jobId,
          person.personIndex,
          person.box ? JSON.stringify(person.box) : null,
          JSON.stringify(person.tags),
          person.skeleton ? JSON.stringify(person.skeleton) : null,
          person.confidence ?? null,
          person.candidateCount,
          person.candidateShortfallReason,
        ],
      );
      for (const candidate of person.candidates) {
        await client.query(
          `INSERT INTO analysis_candidates
            (job_id, person_index, candidate_id, pose_id, rank, view, distance,
             rerank_score, match_level, tags_json, pose_library_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            jobId,
            person.personIndex,
            candidate.id,
            candidate.poseId,
            candidate.rank,
            candidate.view,
            candidate.distance ?? null,
            candidate.rerankScore ?? null,
            candidate.matchLevel,
            JSON.stringify(candidate.tags),
            result.inferenceMetadata.poseLibraryVersion,
          ],
        );
      }
    }
    await client.query(
      `UPDATE jobs
       SET inference_metadata_json = $2, input_width = COALESCE(input_width, $3),
           input_height = COALESCE(input_height, $4)
       WHERE id = $1`,
      [
        jobId,
        JSON.stringify(result.inferenceMetadata),
        result.image.width,
        result.image.height,
      ],
    );
  });
}
