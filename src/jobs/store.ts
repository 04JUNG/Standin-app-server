// Job 저장소(PostgreSQL). result는 JSON 문자열로 저장.
// 인터페이스(createJob/getJob/updateJob)는 유지하되 Promise를 돌려준다.
import { randomUUID } from "node:crypto";
import { execute, queryOne } from "../db.js";
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
  };
}

export async function createJob(
  userId: string | null,
  rerunOf: string | null = null,
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
  };
  await execute(
    `INSERT INTO jobs (id, user_id, status, created_at, updated_at, result_json, error_code, rerun_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [job.id, userId, job.status, now, now, null, null, rerunOf],
  );
  return job;
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
