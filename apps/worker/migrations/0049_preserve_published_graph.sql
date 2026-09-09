PRAGMA foreign_keys = ON;

-- Preserve a published graph only across explicitly identified append-only
-- inputs. Every unrecognized mutation remains hard-invalidating by default.
-- These are singleton metadata changes, not telemetry rewrites or new indexes.
ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_append_epoch INTEGER NOT NULL DEFAULT -1;
ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_invalidation_epoch INTEGER NOT NULL DEFAULT 0;
UPDATE community_snapshot_mutation_control SET graph_invalidation_epoch = mutation_epoch WHERE singleton_id = 1;

DROP TRIGGER community_allowance_input_mutated;
CREATE TRIGGER community_allowance_input_mutated
AFTER UPDATE OF mutation_epoch ON community_snapshot_mutation_control
FOR EACH ROW WHEN OLD.mutation_epoch IS NOT NEW.mutation_epoch
BEGIN
  UPDATE community_allowance_publication_state
     SET publication_state = 'updating', changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE singleton = 1;
  UPDATE community_snapshot_mutation_control SET graph_invalidation_epoch = NEW.mutation_epoch
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

DROP TRIGGER community_analytical_input_v1_insert;
-- A second device can replace the entire elected day even at revision 1.
-- Seek each device/day using the existing participant/device/day index.
CREATE TRIGGER community_analytical_input_v1_insert
AFTER INSERT ON telemetry_v1_chunks
FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id, revision)
    SELECT id, 1 FROM participants WHERE id = NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision = revision + 1;
  UPDATE community_snapshot_mutation_control SET
    mutation_epoch = mutation_epoch + 1,
    graph_append_epoch = (CASE WHEN
      NEW.revision = 1
      AND EXISTS (SELECT 1 FROM participants WHERE id = NEW.participant_id AND state = 'active')
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id = NEW.participant_id)
      AND NOT EXISTS (SELECT 1 FROM telemetry_contributions
        WHERE participant_id = NEW.participant_id AND status = 'accepted')
      AND NOT EXISTS (SELECT 1 FROM telemetry_v1_chunks c
        WHERE c.participant_id = NEW.participant_id AND c.device_id = NEW.device_id
          AND c.stream = NEW.stream AND c.chunk_day = NEW.chunk_day AND c.chunk_seq = NEW.chunk_seq
          AND c.id <> NEW.id)
      AND NOT EXISTS (SELECT 1 FROM device_credentials d
        WHERE d.participant_id = NEW.participant_id AND d.id <> NEW.device_id
          AND EXISTS (SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_device_day
            WHERE c.participant_id = NEW.participant_id AND c.device_id = d.id
              AND c.chunk_day = NEW.chunk_day AND c.superseded_at IS NULL AND c.accepted_record_count > 0))
    THEN mutation_epoch + 1 ELSE -1 END)
  WHERE singleton_id = 1;
END;
