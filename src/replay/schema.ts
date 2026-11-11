/** Kept separate so local PGlite integration tests execute the same PostgreSQL schema. */
export const REPLAY_SCHEMA = `
ALTER TABLE installations ADD COLUMN IF NOT EXISTS replay_withdrawn_at TEXT;
CREATE TABLE IF NOT EXISTS replay_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  app_session_id TEXT NOT NULL, authorization_mode TEXT NOT NULL, consent_id TEXT,
  policy_version TEXT NOT NULL, environment TEXT NOT NULL, app_version TEXT NOT NULL, os TEXT NOT NULL,
  started_at BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'recording', total_bytes BIGINT NOT NULL DEFAULT 0,
  finish_json JSONB, UNIQUE(installation_id, app_session_id)
);
ALTER TABLE admin_access_audit ADD COLUMN IF NOT EXISTS replay_id TEXT REFERENCES replay_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS replay_sessions_period ON replay_sessions(created_at DESC, id);
CREATE INDEX IF NOT EXISTS replay_sessions_installation ON replay_sessions(installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS replay_sessions_filters ON replay_sessions(environment, os, app_version, created_at DESC);
CREATE INDEX IF NOT EXISTS replay_sessions_expiry ON replay_sessions(expires_at);
CREATE TABLE IF NOT EXISTS replay_daily_usage (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  day DATE NOT NULL, bytes BIGINT NOT NULL DEFAULT 0, sessions INT NOT NULL DEFAULT 0,
  PRIMARY KEY(installation_id,day)
);
CREATE TABLE IF NOT EXISTS replay_streams (
  replay_id TEXT NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  window_id TEXT NOT NULL, surface TEXT NOT NULL, PRIMARY KEY(replay_id, window_id)
);
CREATE TABLE IF NOT EXISTS replay_chunks (
  replay_id TEXT NOT NULL, window_id TEXT NOT NULL, sequence INT NOT NULL CHECK(sequence BETWEEN 0 AND 4095),
  content_hash TEXT NOT NULL, object_key TEXT NOT NULL, bytes INT NOT NULL,
  start_ms INT NOT NULL, end_ms INT NOT NULL, metadata JSONB NOT NULL,
  PRIMARY KEY(replay_id, window_id, sequence),
  FOREIGN KEY(replay_id, window_id) REFERENCES replay_streams(replay_id, window_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS replay_chunks_filters ON replay_chunks USING gin(metadata);
CREATE TABLE IF NOT EXISTS replay_assets (
  replay_id TEXT NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  asset_hash TEXT NOT NULL, object_key TEXT NOT NULL, bytes INT NOT NULL, mime TEXT NOT NULL,
  metadata JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(replay_id, asset_hash)
);
CREATE TABLE IF NOT EXISTS replay_job_links (
  replay_id TEXT NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, PRIMARY KEY(replay_id, job_id)
);
CREATE INDEX IF NOT EXISTS replay_links_job ON replay_job_links(job_id);
CREATE TABLE IF NOT EXISTS replay_artifact_receipts (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  artifact_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,artifact_hash)
);
CREATE TABLE IF NOT EXISTS replay_tombstones (
  id TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL
);
-- Prefix deletion survives process restarts. Contains no original content or installation identity.
CREATE TABLE IF NOT EXISTS replay_object_deletions (
  prefix TEXT PRIMARY KEY, queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION queue_replay_object_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO replay_tombstones(id,expires_at) VALUES (OLD.id,GREATEST(OLD.expires_at,now()+interval '1 day')) ON CONFLICT DO NOTHING;
 INSERT INTO replay_object_deletions(prefix) VALUES ('replays/' || OLD.id || '/') ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS replay_delete_objects ON replay_sessions;
CREATE TRIGGER replay_delete_objects BEFORE DELETE ON replay_sessions
 FOR EACH ROW EXECUTE FUNCTION queue_replay_object_deletion();
`;
