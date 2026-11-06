/** Additive, idempotent migration. Legacy artifacts never become target-context authority. */
export const CANDIDATE_PREPARATION_SCHEMA = `
ALTER TABLE analysis_candidates ADD COLUMN IF NOT EXISTS preparation_camera_json JSONB;
CREATE TABLE IF NOT EXISTS candidate_preparation_batches (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  context_hash TEXT NOT NULL,
  value JSONB NOT NULL,
  lease_id TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_preparation_heads (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES candidate_preparation_batches(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_preparation_mutations (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES candidate_preparation_batches(id) ON DELETE CASCADE,
  PRIMARY KEY(job_id, mutation_id)
);
CREATE INDEX IF NOT EXISTS candidate_preparation_queue ON candidate_preparation_batches(created_at)
  WHERE value->>'status' IN ('queued','running');
CREATE INDEX IF NOT EXISTS candidate_preparation_owner_queue ON candidate_preparation_batches(installation_id)
  WHERE value->>'status' IN ('queued','running');
CREATE INDEX IF NOT EXISTS candidate_preparation_active_leases ON candidate_preparation_batches(lease_until)
  WHERE lease_until IS NOT NULL;
`;
