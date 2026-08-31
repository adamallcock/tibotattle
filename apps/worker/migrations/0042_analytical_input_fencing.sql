PRAGMA foreign_keys = ON;

ALTER TABLE community_allowance_publication_state ADD COLUMN attribution_method_version TEXT;
ALTER TABLE admin_community_allowance_preview_cache ADD COLUMN attribution_method_version TEXT;
ALTER TABLE admin_community_allowance_preview_cache ADD COLUMN source_mutation_epoch INTEGER;

-- Exact analytical invalidation, independent of consent or transport cutover.
-- A monotonically increasing participant revision cannot alias different
-- chunk vectors as COUNT/MAX/SUM can. Pin readers retain the exact vector hash;
-- caches validate this revision in one indexed SELECT, without raw row scans.
CREATE TABLE community_analytical_input_versions (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991)
) STRICT;
INSERT INTO community_analytical_input_versions (participant_id, revision)
  SELECT id, 1 FROM participants;

CREATE TRIGGER community_analytical_input_participant_created
AFTER INSERT ON participants
FOR EACH ROW
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    VALUES (NEW.id, 0);
END;

CREATE TRIGGER community_analytical_input_participant_state
AFTER UPDATE OF state ON participants
FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  UPDATE community_analytical_input_versions SET revision = revision + 1
    WHERE participant_id = NEW.id;
END;

CREATE TRIGGER community_analytical_input_v1_insert
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER community_analytical_input_v1_update
AFTER UPDATE ON telemetry_v1_chunks
FOR EACH ROW WHEN OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER community_analytical_input_v1_delete
AFTER DELETE ON telemetry_v1_chunks
FOR EACH ROW WHEN OLD.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = OLD.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

-- Dormant v0.2 is still covered: changing its deployment variable must not
-- create an unfenced analytical path. Older telemetry shares this journal.
CREATE TRIGGER community_analytical_input_legacy_insert
AFTER INSERT ON telemetry_contributions
FOR EACH ROW WHEN NEW.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER community_analytical_input_legacy_update
AFTER UPDATE ON telemetry_contributions
FOR EACH ROW WHEN OLD.status = 'accepted' OR NEW.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER community_analytical_input_legacy_delete
AFTER DELETE ON telemetry_contributions
FOR EACH ROW WHEN OLD.status = 'accepted'
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = OLD.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
END;

-- An ingest, withdrawal, policy change or successor activation invalidates
-- the existing publication singleton in the SAME transaction as the input.
-- Only reconciliation against that exact epoch may set it ready again.
CREATE TRIGGER community_allowance_input_mutated
AFTER UPDATE OF mutation_epoch ON community_snapshot_mutation_control
FOR EACH ROW WHEN OLD.mutation_epoch IS NOT NEW.mutation_epoch
BEGIN
  UPDATE community_allowance_publication_state
     SET publication_state = 'updating',
         changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE singleton = 1;
  DELETE FROM admin_community_allowance_preview_cache;
END;

-- Preserve fingerprints beside the existing caches, not a second cache.
ALTER TABLE community_allowance_fit_cache ADD COLUMN input_fingerprint TEXT;
ALTER TABLE community_allowance_fit_cache ADD COLUMN source_method_version TEXT;
ALTER TABLE community_model_composition_cache ADD COLUMN input_fingerprint TEXT;
ALTER TABLE community_model_composition_cache ADD COLUMN source_method_version TEXT;

-- Cached old-method fits cannot qualify as attribution-correct evidence.
DELETE FROM community_allowance_fit_cache;
DELETE FROM community_model_composition_cache;
DELETE FROM admin_community_allowance_preview_cache;
-- Historical model snapshots have no attribution provenance and cannot be
-- corrected from their aggregate payload alone. Keep them privately for
-- diagnosis; current-method readers require the new column below.
ALTER TABLE community_model_composition_days ADD COLUMN attribution_method_version TEXT;
ALTER TABLE community_model_composition_days ADD COLUMN source_mutation_epoch INTEGER;

UPDATE community_snapshot_mutation_control
   SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;

-- True usage keyset pagination, including very large equal-time runs. D1's
-- planner does not seek an implicit rowid tuple suffix on the older 0036
-- index; an explicit non-null occurrence key provides the complete seek.
CREATE INDEX telemetry_v1_records_time_cursor
  ON telemetry_v1_records(participant_id, stream, observed_at, occurrence_id);
