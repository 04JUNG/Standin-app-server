/** Durable operation identity and queue; deletion uses the existing owned-job lifecycle. */
export const INTERACTIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS interactive_heads (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  person_index INTEGER NOT NULL CHECK (person_index >= 0),
  operation_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  PRIMARY KEY(job_id, person_index)
);
CREATE TABLE IF NOT EXISTS interactive_operations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  person_index INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  value JSONB NOT NULL,
  lease_id TEXT,
  lease_stage TEXT,
  lease_until TIMESTAMPTZ,
  UNIQUE(job_id, person_index, mutation_id)
);
CREATE TABLE IF NOT EXISTS interactive_history_frames (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  person_index INTEGER NOT NULL,
  revision BIGINT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY(job_id,person_index)
);
CREATE INDEX IF NOT EXISTS interactive_operations_expiry ON interactive_operations ((value->>'expiresAt'));
`;
