PRAGMA foreign_keys = ON;

CREATE TABLE participants (
  id TEXT PRIMARY KEY NOT NULL,
  access_token_id TEXT NOT NULL UNIQUE,
  access_token_hash BLOB NOT NULL,
  recovery_token_id TEXT NOT NULL UNIQUE,
  recovery_token_hash BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleting')),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE contributions (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  envelope_schema_version TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('accepted_synthetic', 'deleting')),
  fixture_id TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  quota_window_minutes INTEGER NOT NULL,
  quota_used_percent_before REAL NOT NULL,
  quota_used_percent_after REAL NOT NULL,
  quota_display_precision INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  subscription_speed TEXT NOT NULL,
  api_tier_assumption TEXT NOT NULL,
  input_uncached_tokens INTEGER NOT NULL,
  input_cached_tokens INTEGER NOT NULL,
  output_text_tokens INTEGER NOT NULL,
  output_reasoning_tokens INTEGER NOT NULL,
  web_search_calls INTEGER NOT NULL,
  unknown_tool_units INTEGER NOT NULL,
  estimated_api_cost_usd TEXT NOT NULL,
  priced_event_coverage_percent REAL NOT NULL,
  unknown_billable_units INTEGER NOT NULL,
  price_basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (participant_id),
  UNIQUE (participant_id, envelope_digest)
) STRICT;

CREATE INDEX contributions_participant_created
  ON contributions(participant_id, created_at, id);

CREATE TRIGGER contributions_require_active_participant
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;
