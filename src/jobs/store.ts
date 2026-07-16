// Job 저장소.
// ⚠ Phase 0: 인메모리(프로세스 재시작 시 소실). 데모·개발용으로 충분.
//    Phase 1+: SQLite(node:sqlite / better-sqlite3) 또는 Postgres로 교체.
//    이 파일 인터페이스(createJob/getJob/updateJob)만 유지하면 됨.
import { randomUUID } from "node:crypto";
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

const jobs = new Map<string, Job>();

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
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}
