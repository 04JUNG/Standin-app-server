export const ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS supporter_access_codes (
  id UUID PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  installation_id TEXT REFERENCES installations(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ,
  CHECK ((installation_id IS NULL) = (redeemed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS supporter_access_installation ON supporter_access_codes(installation_id);
CREATE TABLE IF NOT EXISTS supporter_access_attempts (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL
);
`;
