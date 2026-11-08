export const JOURNEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS journey_visitors (
  id UUID PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  consent_version TEXT NOT NULL, revoked_at TIMESTAMPTZ,
  event_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS journey_web_events (
  event_id UUID PRIMARY KEY, visitor_id UUID NOT NULL REFERENCES journey_visitors(id) ON DELETE CASCADE,
  page_id UUID NOT NULL, sequence INTEGER NOT NULL, event_name TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  path TEXT NOT NULL, section TEXT NOT NULL, target TEXT NOT NULL,
  creative TEXT NOT NULL, source TEXT NOT NULL, device TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL, depth INTEGER NOT NULL,
  UNIQUE(visitor_id,page_id,sequence)
);
CREATE INDEX IF NOT EXISTS journey_web_visitor ON journey_web_events(visitor_id,occurred_at);
CREATE INDEX IF NOT EXISTS journey_web_received ON journey_web_events(received_at);
CREATE INDEX IF NOT EXISTS journey_web_occurred ON journey_web_events(occurred_at);
CREATE INDEX IF NOT EXISTS journey_visitor_expiry ON journey_visitors(expires_at);
CREATE TABLE IF NOT EXISTS journey_handoffs (
  token_hash TEXT PRIMARY KEY, visitor_id UUID NOT NULL REFERENCES journey_visitors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS journey_links (
  id UUID PRIMARY KEY, visitor_id UUID REFERENCES journey_visitors(id) ON DELETE SET NULL,
  installation_id TEXT UNIQUE NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  consent_version TEXT NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS journey_app_events (
  event_id UUID PRIMARY KEY, link_id UUID NOT NULL REFERENCES journey_links(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journey_app_link ON journey_app_events(link_id,occurred_at);
CREATE INDEX IF NOT EXISTS journey_link_visitor ON journey_links(visitor_id);
CREATE INDEX IF NOT EXISTS journey_handoff_visitor ON journey_handoffs(visitor_id);
`;
