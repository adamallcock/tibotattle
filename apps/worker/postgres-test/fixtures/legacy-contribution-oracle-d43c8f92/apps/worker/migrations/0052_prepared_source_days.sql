PRAGMA foreign_keys = ON;

-- Forward-only physical-reader selection. Existing heads and their unfinished
-- one-page replay journals keep the exact deployed raw-page protocol.
ALTER TABLE community_analysis_work ADD COLUMN reader_policy TEXT NOT NULL DEFAULT 'raw-source-pages-1'
  CHECK (reader_policy IN ('raw-source-pages-1', 'prepared-source-days-1'));
ALTER TABLE community_model_history_work ADD COLUMN reader_policy TEXT NOT NULL DEFAULT 'raw-source-pages-1'
  CHECK (reader_policy IN ('raw-source-pages-1', 'prepared-source-days-1'));

-- One elected generation per source day. Replacement drains child projections
-- in bounded pages before replacing this head. No telemetry or consent changes.
CREATE TABLE community_prepared_source_days (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  source_day TEXT NOT NULL,
  generation TEXT NOT NULL CHECK (length(generation) = 64 AND generation NOT GLOB '*[^0-9a-f]*'),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  method_version TEXT NOT NULL CHECK (length(method_version) BETWEEN 1 AND 256),
  device_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('quota', 'usage', 'complete', 'discarding')),
  progress_revision INTEGER NOT NULL CHECK (progress_revision >= 0 AND progress_revision < 9007199254740991),
  cursor_time TEXT NOT NULL,
  cursor_id INTEGER NOT NULL CHECK (cursor_id >= 0 AND cursor_id < 9007199254740991),
  quota_count INTEGER NOT NULL CHECK (quota_count >= 0 AND quota_count < 9007199254740991),
  usage_count INTEGER NOT NULL CHECK (usage_count >= 0 AND usage_count < 9007199254740991),
  plan_count INTEGER NOT NULL CHECK (plan_count >= 0 AND plan_count < 9007199254740991),
  fit_count INTEGER NOT NULL CHECK (fit_count >= 0 AND fit_count < 9007199254740991),
  fragment_count INTEGER NOT NULL CHECK (fragment_count >= 0 AND fragment_count < 9007199254740991),
  control_json TEXT NOT NULL CHECK (json_valid(control_json) AND length(CAST(control_json AS BLOB)) <= 16384),
  control_sha256 TEXT NOT NULL CHECK (length(control_sha256) = 64 AND control_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (participant_id, source_day),
  UNIQUE (participant_id, source_day, generation)
) STRICT, WITHOUT ROWID;
CREATE INDEX community_prepared_retirement_cursor ON community_prepared_source_days(phase, participant_id, source_day);

CREATE TABLE community_prepared_plan_rows (
  participant_id TEXT NOT NULL,
  source_day TEXT NOT NULL,
  generation TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0),
  observed_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  provider TEXT,
  limit_id TEXT,
  plan_type TEXT,
  plan_variant TEXT,
  PRIMARY KEY (participant_id, source_day, generation, id),
  FOREIGN KEY (participant_id, source_day, generation)
    REFERENCES community_prepared_source_days(participant_id, source_day, generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX community_prepared_plan_cursor ON community_prepared_plan_rows(participant_id, source_day, generation, observed_at, id);

CREATE TABLE community_prepared_fit_rows (
  participant_id TEXT NOT NULL,
  source_day TEXT NOT NULL,
  generation TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0),
  observed_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  plan_variant TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  used_percent REAL NOT NULL,
  window_duration_minutes INTEGER NOT NULL CHECK (window_duration_minutes = 10080),
  resets_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, source_day, generation, id),
  FOREIGN KEY (participant_id, source_day, generation)
    REFERENCES community_prepared_source_days(participant_id, source_day, generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX community_prepared_fit_cursor ON community_prepared_fit_rows(participant_id, source_day, generation, resets_at, observed_at, id);

CREATE TABLE community_prepared_usage_rows (
  participant_id TEXT NOT NULL,
  source_day TEXT NOT NULL,
  generation TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0),
  observed_at TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_uuid TEXT,
  cost_nanousd INTEGER CHECK (cost_nanousd >= 0 AND cost_nanousd <= 9007199254740991),
  pricing_status TEXT CHECK (pricing_status IN ('fully_priced', 'partially_priced', 'unpriced')),
  model_id TEXT,
  CHECK ((cost_nanousd IS NULL) = (pricing_status IS NULL)),
  PRIMARY KEY (participant_id, source_day, generation, id),
  FOREIGN KEY (participant_id, source_day, generation)
    REFERENCES community_prepared_source_days(participant_id, source_day, generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX community_prepared_usage_cursor ON community_prepared_usage_rows(participant_id, source_day, generation, observed_at, id);

-- Allowlisted integer-cost fragments only. Each payload comes from one bounded
-- preparation page; no tokens, raw JSON, prompts or responses are duplicated.
CREATE TABLE community_prepared_usage_bins (
  participant_id TEXT NOT NULL,
  source_day TEXT NOT NULL,
  generation TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 131072),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (participant_id, source_day, generation, id),
  FOREIGN KEY (participant_id, source_day, generation)
    REFERENCES community_prepared_source_days(participant_id, source_day, generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX community_prepared_bins_cursor ON community_prepared_usage_bins(participant_id, source_day, generation, observed_at, id);

-- Retention, correction and owner-erasure source removal immediately revoke
-- derived-day readability. Physical derived cleanup is bounded by maintenance.
CREATE TRIGGER community_prepared_source_record_delete AFTER DELETE ON telemetry_v1_records
BEGIN
  UPDATE community_prepared_source_days SET phase='discarding', progress_revision=progress_revision+1
  WHERE participant_id=OLD.participant_id AND source_day=OLD.observed_day AND phase!='discarding';
END;
CREATE TRIGGER community_prepared_source_record_update AFTER UPDATE ON telemetry_v1_records
BEGIN
  UPDATE community_prepared_source_days SET phase='discarding', progress_revision=progress_revision+1
  WHERE ((participant_id=OLD.participant_id AND source_day=OLD.observed_day)
    OR (participant_id=NEW.participant_id AND source_day=NEW.observed_day)) AND phase!='discarding';
END;
