PRAGMA foreign_keys = ON;

-- This is derived publication evidence, not a second telemetry store. A member
-- freezes only the already-validated fit/model cache selected for this build.
-- Deletion of a participant cascades immediately; the existing hard graph
-- invalidation epoch remains the serving and promotion authority.
CREATE TABLE community_publication_changes (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991)
) STRICT;
INSERT INTO community_publication_changes VALUES (1, 0);
ALTER TABLE admin_community_allowance_preview_cache ADD COLUMN publication_generation TEXT;

CREATE TABLE community_publication_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL UNIQUE CHECK (length(generation) = 36),
  utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  method_version TEXT NOT NULL,
  source_epoch INTEGER NOT NULL CHECK (source_epoch >= 0),
  hard_epoch INTEGER NOT NULL CHECK (hard_epoch >= 0 AND hard_epoch <= source_epoch),
  cache_revision INTEGER NOT NULL CHECK (cache_revision >= 0),
  membership_watermark INTEGER NOT NULL CHECK (membership_watermark >= 0),
  capture_cursor INTEGER NOT NULL CHECK (capture_cursor >= 0),
  load_cursor INTEGER NOT NULL CHECK (load_cursor >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('capturing', 'loading', 'ready', 'retiring')),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  member_count INTEGER NOT NULL CHECK (member_count >= 0),
  prepared_count INTEGER NOT NULL CHECK (prepared_count >= 0 AND prepared_count <= member_count),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0 AND payload_bytes <= 16777216),
  progress_revision INTEGER NOT NULL CHECK (progress_revision >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE community_publication_members (
  generation TEXT NOT NULL REFERENCES community_publication_generation(generation) ON DELETE CASCADE,
  member_id INTEGER NOT NULL CHECK (member_id > 0),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  minimum_revision INTEGER NOT NULL CHECK (minimum_revision >= 0),
  source TEXT NOT NULL CHECK (source IN ('v0.2', 'v1', 'mixed', 'v1.1')),
  composition_supported INTEGER NOT NULL CHECK (composition_supported IN (0, 1)),
  selected_revision INTEGER,
  fit_fingerprint TEXT,
  composition_fingerprint TEXT,
  fits_json TEXT,
  composition_json TEXT,
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0 AND payload_bytes <= 16777216),
  PRIMARY KEY (generation, member_id),
  UNIQUE (generation, participant_id),
  CHECK ((selected_revision IS NULL AND fits_json IS NULL AND fit_fingerprint IS NULL AND payload_bytes = 0)
    OR (selected_revision >= minimum_revision AND fits_json IS NOT NULL AND length(fit_fingerprint) = 64 AND payload_bytes > 0)),
  CHECK (composition_supported = 1 OR (composition_json IS NULL AND composition_fingerprint IS NULL))
) STRICT;
CREATE INDEX community_publication_members_pending
  ON community_publication_members(generation, member_id) WHERE selected_revision IS NULL;
CREATE INDEX community_publication_members_participant ON community_publication_members(participant_id);

CREATE TRIGGER community_publication_generation_published AFTER UPDATE OF published ON community_publication_generation
WHEN OLD.published = 0 AND NEW.published = 1
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE lane='daily' AND state='complete';
END;

CREATE TRIGGER community_publication_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER community_publication_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER community_publication_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER community_publication_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER community_publication_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER community_publication_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1; END;
