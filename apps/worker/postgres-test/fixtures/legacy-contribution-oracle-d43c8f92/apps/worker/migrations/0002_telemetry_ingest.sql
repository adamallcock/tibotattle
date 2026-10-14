PRAGMA foreign_keys = ON;

CREATE TABLE telemetry_contributions (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  plaintext_digest TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'deleting')),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'telemetry-contribution-v0.1'),
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  client_platform TEXT NOT NULL,
  provider_policy_epoch TEXT NOT NULL,
  estimated_api_cost_usd TEXT,
  priced_event_coverage_percent REAL NOT NULL,
  unknown_model_event_count INTEGER NOT NULL,
  unknown_billable_units INTEGER NOT NULL,
  price_basis TEXT NOT NULL,
  declared_record_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (participant_id, plaintext_digest),
  UNIQUE (participant_id, envelope_digest)
) STRICT;

CREATE INDEX telemetry_contributions_participant_created
  ON telemetry_contributions(participant_id, created_at, id);

CREATE TABLE telemetry_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_contribution_id TEXT,
  participant_id TEXT NOT NULL,
  record_kind TEXT NOT NULL
    CHECK (record_kind IN ('usage', 'quota', 'activity')),
  occurrence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  model_fingerprint TEXT,
  speed_mode TEXT,
  api_service_tier TEXT,
  surface TEXT,
  plan_type TEXT,
  plan_variant TEXT,
  limit_id TEXT,
  slot TEXT,
  used_percent REAL,
  window_duration_minutes INTEGER,
  resets_at TEXT,
  input_uncached_tokens INTEGER,
  input_cache_read_tokens INTEGER,
  input_cache_write_tokens INTEGER,
  output_text_tokens INTEGER,
  output_reasoning_tokens INTEGER,
  output_combined_tokens INTEGER,
  tool_units INTEGER,
  estimated_api_cost_usd TEXT,
  pricing_coverage_percent REAL,
  unknown_billable_units INTEGER,
  record_json TEXT NOT NULL,
  FOREIGN KEY (origin_contribution_id) REFERENCES telemetry_contributions(id) ON DELETE SET NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (participant_id, record_kind, occurrence_id)
) STRICT;

CREATE INDEX telemetry_records_participant_time
  ON telemetry_records(participant_id, observed_at, id);

CREATE INDEX telemetry_records_aggregate_time
  ON telemetry_records(record_kind, observed_at, provider, model_id);

CREATE TABLE telemetry_contribution_occurrences (
  contribution_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  PRIMARY KEY (contribution_id, record_kind, occurrence_id),
  FOREIGN KEY (contribution_id) REFERENCES telemetry_contributions(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id, record_kind, occurrence_id)
    REFERENCES telemetry_records(participant_id, record_kind, occurrence_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX telemetry_contribution_occurrences_record
  ON telemetry_contribution_occurrences(participant_id, record_kind, occurrence_id);

CREATE TRIGGER telemetry_contributions_require_active_participant
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;

CREATE TRIGGER telemetry_contributions_enforce_participant_limit
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM telemetry_contributions
      WHERE participant_id = NEW.participant_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'contribution limit reached');
END;
