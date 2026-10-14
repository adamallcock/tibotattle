PRAGMA foreign_keys = ON;

-- Scheduling metadata only: exact calculator identities and privacy fences
-- remain authoritative. Numeric membership IDs never depend on wall-clock or
-- participant-ID ordering, and are never recycled after erasure.
CREATE TABLE community_current_analysis_queue_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  utc_day TEXT NOT NULL,
  method_version TEXT NOT NULL,
  window_generation INTEGER NOT NULL CHECK (window_generation >= 0 AND window_generation < 9007199254740991),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0 AND last_sequence < 9007199254740991)
) STRICT;
INSERT INTO community_current_analysis_queue_state VALUES (1, '', '', 0, 0);

CREATE TABLE community_current_analysis_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  dirty_generation INTEGER NOT NULL CHECK (dirty_generation > 0 AND dirty_generation < 9007199254740991),
  window_generation INTEGER NOT NULL CHECK (window_generation >= 0 AND window_generation < 9007199254740991),
  pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
  last_served_sequence INTEGER NOT NULL CHECK (last_served_sequence >= 0 AND last_served_sequence < 9007199254740991),
  completed_day TEXT,
  completed_method TEXT
) STRICT;
CREATE INDEX community_current_analysis_queue_ready
  ON community_current_analysis_queue(window_generation, last_served_sequence, id) WHERE pending = 1;
CREATE INDEX community_current_analysis_queue_window
  ON community_current_analysis_queue(window_generation, id);
CREATE TRIGGER community_current_analysis_identity_immutable
BEFORE UPDATE OF id, participant_id ON community_current_analysis_queue
WHEN OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id
BEGIN
  SELECT RAISE(ABORT, 'current analysis membership identity is immutable');
END;

-- Seed only contributing active accounts. Existing telemetry, calculator
-- checkpoints, cache payloads and publication snapshots are left untouched.
INSERT INTO community_current_analysis_queue
  (participant_id, dirty_generation, window_generation, pending, last_served_sequence)
SELECT p.id, 1, 0, 1, 0 FROM participants p WHERE p.state = 'active' AND (
  EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id=p.id AND c.superseded_at IS NULL)
  OR EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id)
  OR EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id
    AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2'));
UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry' WHERE lane='current';

-- The existing analytical journal covers inserts, corrections, retention,
-- source cutover and participant-state changes. Duplicate/storage-only input
-- writes which do not change that journal do not manufacture new work.
CREATE TRIGGER community_current_analysis_revision_insert AFTER INSERT ON community_analytical_input_versions
WHEN NEW.revision > 0
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete';
END;
CREATE TRIGGER community_current_analysis_revision_update AFTER UPDATE OF revision ON community_analytical_input_versions
WHEN OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete';
END;
CREATE TRIGGER community_current_analysis_participant_state AFTER UPDATE OF state ON participants
WHEN NEW.state != 'active'
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=NEW.id;
END;

-- Cache damage must enqueue even an in-flight job. A publisher acknowledges
-- its own cache writes in the same guarded transaction; concurrent repairs or
-- input mutations therefore cannot be swallowed by an older acknowledgement.
CREATE TRIGGER community_current_analysis_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
CREATE TRIGGER community_current_analysis_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=OLD.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
CREATE TRIGGER community_current_analysis_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id IN (OLD.participant_id,NEW.participant_id) AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
CREATE TRIGGER community_current_analysis_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
CREATE TRIGGER community_current_analysis_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=OLD.participant_id AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
CREATE TRIGGER community_current_analysis_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id IN (OLD.participant_id,NEW.participant_id) AND p.state='active' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;
