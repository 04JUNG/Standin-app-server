// Job 저장소(SQLite). result는 JSON 문자열로 저장.
// 인터페이스(createJob/getJob/updateJob)는 인메모리 시절과 동일 → 러너·라우트 무변경.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
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

const insert = db.prepare(
  `INSERT INTO jobs (id, user_id, status, created_at, updated_at, result_json, error_code, rerun_of)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selById = db.prepare("SELECT * FROM jobs WHERE id = ?");
const update = db.prepare(
  "UPDATE jobs SET status = ?, updated_at = ?, result_json = ?, error_code = ? WHERE id = ?",
);

export function createJob(userId: string | null, rerunOf: string | null = null): Job {
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
  insert.run(job.id, userId, job.status, now, now, null, null, rerunOf);
  return job;
}

export function getJob(id: string): Job | undefined {
  const row = selById.get(id) as JobRow | undefined;
  return row ? toJob(row) : undefined;
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = getJob(id);
  if (!job) return;
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  update.run(
    next.status,
    next.updatedAt,
    next.result ? JSON.stringify(next.result) : null,
    next.errorCode,
    id,
  );
}
