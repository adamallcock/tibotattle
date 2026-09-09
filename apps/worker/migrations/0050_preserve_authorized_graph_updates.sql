PRAGMA foreign_keys = ON;

-- A one-use, transaction-local capability for the validated v1 repository
-- path. It is installed and removed within the SAME upload batch; unknown
-- direct mutations still invalidate publication. Nothing restores an old floor.
CREATE TABLE community_graph_update_scope (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  chunk_day TEXT NOT NULL,
  chunk_seq INTEGER NOT NULL,
  old_chunk_id TEXT,
  new_chunk_id TEXT NOT NULL,
  new_revision INTEGER NOT NULL,
  chunk_digest TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  authorization_id TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('supersede', 'insert'))
) STRICT;
CREATE INDEX community_graph_update_scope_participant ON community_graph_update_scope(participant_id);

ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_append_reason TEXT;
ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_last_change_reason TEXT;
ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_last_change_at TEXT;
ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_last_invalidated_at TEXT;

DROP TRIGGER community_allowance_input_mutated;
CREATE TRIGGER community_allowance_input_mutated
AFTER UPDATE OF mutation_epoch ON community_snapshot_mutation_control
FOR EACH ROW WHEN OLD.mutation_epoch IS NOT NEW.mutation_epoch
BEGIN
  UPDATE community_allowance_publication_state
    SET publication_state = 'updating', changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE singleton = 1;
  UPDATE community_snapshot_mutation_control SET
    graph_last_change_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    graph_last_change_reason = (CASE WHEN
      NEW.mutation_epoch = OLD.mutation_epoch + 1
      AND NEW.graph_append_epoch = NEW.mutation_epoch
      AND NEW.graph_append_epoch IS NOT OLD.graph_append_epoch
      THEN COALESCE(NEW.graph_append_reason, 'accepted-append')
      ELSE 'authority-or-unrecognized-change' END)
    WHERE singleton_id = 1;
  UPDATE community_snapshot_mutation_control SET
    graph_invalidation_epoch = NEW.mutation_epoch,
    graph_last_invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE singleton_id = 1 AND NOT (
      NEW.mutation_epoch = OLD.mutation_epoch + 1
      AND NEW.graph_append_epoch = NEW.mutation_epoch
      AND NEW.graph_append_epoch IS NOT OLD.graph_append_epoch
    );
  DELETE FROM admin_community_allowance_preview_cache WHERE NOT (
    NEW.mutation_epoch = OLD.mutation_epoch + 1
    AND NEW.graph_append_epoch = NEW.mutation_epoch
    AND NEW.graph_append_epoch IS NOT OLD.graph_append_epoch
  );
END;

DROP TRIGGER community_analytical_input_v1_update;
CREATE TRIGGER community_analytical_input_v1_update
AFTER UPDATE ON telemetry_v1_chunks
FOR EACH ROW WHEN (OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL) AND (
  OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.device_id IS NOT NEW.device_id OR OLD.stream IS NOT NEW.stream
  OR OLD.chunk_day IS NOT NEW.chunk_day OR OLD.chunk_seq IS NOT NEW.chunk_seq
  OR OLD.revision IS NOT NEW.revision OR OLD.chunk_digest IS NOT NEW.chunk_digest
  OR OLD.parser_version IS NOT NEW.parser_version OR OLD.record_count IS NOT NEW.record_count
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.created_at IS NOT NEW.created_at OR OLD.superseded_at IS NOT NEW.superseded_at
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
)
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = OLD.participant_id OR id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control SET
    mutation_epoch = mutation_epoch + 1,
    graph_append_reason = 'accepted-correction',
    graph_append_epoch = (CASE WHEN EXISTS (
      SELECT 1 FROM community_graph_update_scope u
      WHERE u.singleton = 1 AND u.phase = 'supersede' AND u.expected_epoch = mutation_epoch
        AND u.old_chunk_id = OLD.id AND u.participant_id = OLD.participant_id
        AND u.device_id = OLD.device_id AND u.stream = OLD.stream
        AND u.chunk_day = OLD.chunk_day AND u.chunk_seq = OLD.chunk_seq
        AND u.new_revision = OLD.revision + 1
        AND OLD.superseded_at IS NULL AND NEW.superseded_at = u.created_at
        AND NEW.id = OLD.id AND NEW.participant_id = OLD.participant_id
        AND NEW.device_id = OLD.device_id AND NEW.stream = OLD.stream
        AND NEW.chunk_day = OLD.chunk_day AND NEW.chunk_seq = OLD.chunk_seq
        AND NEW.revision = OLD.revision AND NEW.chunk_digest = OLD.chunk_digest
        AND NEW.parser_version = OLD.parser_version AND NEW.record_count = OLD.record_count
        AND NEW.accepted_record_count = OLD.accepted_record_count AND NEW.created_at = OLD.created_at
        AND NEW.device_upload_authorization_id = OLD.device_upload_authorization_id
    ) THEN mutation_epoch + 1 ELSE -1 END)
    WHERE singleton_id = 1;
  UPDATE community_graph_update_scope SET expected_epoch = expected_epoch + 1, phase = 'insert'
    WHERE old_chunk_id = OLD.id AND phase = 'supersede'
      AND expected_epoch + 1 = (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1)
      AND expected_epoch + 1 = (SELECT graph_append_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1);
END;

DROP TRIGGER community_analytical_input_v1_insert;
-- The second branch retains deployed safe append behavior for old writers.
CREATE TRIGGER community_analytical_input_v1_insert
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control SET
    mutation_epoch = mutation_epoch + 1,
    graph_append_reason = (CASE WHEN EXISTS (SELECT 1 FROM community_graph_update_scope
      WHERE new_chunk_id = NEW.id AND old_chunk_id IS NOT NULL) THEN 'accepted-correction' ELSE 'accepted-append' END),
    graph_append_epoch = (CASE WHEN EXISTS (
      SELECT 1 FROM community_graph_update_scope u
      WHERE u.singleton = 1 AND u.phase = 'insert' AND u.expected_epoch = mutation_epoch
        AND u.new_chunk_id = NEW.id AND u.participant_id = NEW.participant_id
        AND u.device_id = NEW.device_id AND u.stream = NEW.stream
        AND u.chunk_day = NEW.chunk_day AND u.chunk_seq = NEW.chunk_seq
        AND u.new_revision = NEW.revision AND u.chunk_digest = NEW.chunk_digest
        AND u.parser_version = NEW.parser_version AND u.record_count = NEW.record_count
        AND u.record_count = NEW.accepted_record_count AND u.created_at = NEW.created_at
        AND u.authorization_id = NEW.device_upload_authorization_id AND u.envelope_digest = NEW.envelope_digest
    ) OR (
      NEW.revision = 1
      AND EXISTS (SELECT 1 FROM participants WHERE id = NEW.participant_id AND state = 'active')
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id = NEW.participant_id)
      AND NOT EXISTS (SELECT 1 FROM telemetry_contributions WHERE participant_id = NEW.participant_id AND status = 'accepted')
      AND NOT EXISTS (SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id = NEW.participant_id
        AND c.device_id = NEW.device_id AND c.stream = NEW.stream AND c.chunk_day = NEW.chunk_day
        AND c.chunk_seq = NEW.chunk_seq AND c.id <> NEW.id)
      AND NOT EXISTS (SELECT 1 FROM device_credentials d WHERE d.participant_id = NEW.participant_id
        AND d.id <> NEW.device_id AND EXISTS (SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_device_day
          WHERE c.participant_id = NEW.participant_id AND c.device_id = d.id AND c.chunk_day = NEW.chunk_day
            AND c.superseded_at IS NULL AND c.accepted_record_count > 0))
    ) THEN mutation_epoch + 1 ELSE -1 END)
    WHERE singleton_id = 1;
  DELETE FROM community_graph_update_scope WHERE new_chunk_id = NEW.id;
END;
