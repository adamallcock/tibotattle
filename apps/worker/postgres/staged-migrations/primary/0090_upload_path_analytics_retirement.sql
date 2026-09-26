-- PostgreSQL primary migration 0090 (staged, provisional number): retire the
-- JSON-era analytics side effects of 0010 from the upload path.
--
-- This is the PostgreSQL counterpart of D1 ingestion-isolation 0001. On D1
-- the ingestion role drops the queue, cache and model-history triggers,
-- keeps the source revision and mutation-epoch authority, preserves the
-- append/correction versus hard-change metadata without a cache write, and
-- refuses derived writes. Here analytics shares the database, so no table is
-- dropped: the erasure inventories (OWNER_DIGEST_TABLES,
-- KNOWN_PARTICIPANT_TABLES, ACCOUNTLESS_PARTICIPANT_TABLES) and the retained
-- residue sweeps still name every 0010 table.
--
-- Retired (an upload, head change, activation or contribution no longer
-- touches them):
--   * the publication_state flip and the global preview_cache wipe inside
--     publication_mutated;
--   * the current_queue and refresh_lanes writes (analysis_queued_* on
--     input_versions) and the participant queue removal;
--   * the per-chunk daily_rebuilds queue (zz_daily_rebuild_queued);
--   * the v1 model-history dependency invalidation and composition-day
--     deletes (community_model_history_v1_*);
--   * the prepared-source discard and progress counters
--     (prepared_source_discard, preparation_progress_changed);
--   * the global composition-day and preview_cache deletes in the participant
--     state and delete triggers.
--
-- Kept unchanged: aa_analytical_* and begin_graph_scope (the mutation_epoch
-- and graph_append_epoch bumps that community publication authority pins),
-- the graph_last_change_* and graph_invalidation_epoch metadata, the
-- input_versions and input_source_digests revision chain and its journal
-- emitter, participant_input_created, participant_withdrawal, the quota-fit
-- index triggers, the v1 transport-floor guard and the reconciliation guard.
--
-- publication_state is set to 'ready' once and from then on is only the
-- policy row carrying policy_revision; nothing on the upload path writes it.
--
-- Every RAISE carries a constant message and ERRCODE; no value is
-- interpolated. The migration drops triggers and functions only; no row of
-- any table is deleted or rewritten except the single policy row.

-- (1) The mutation-control metadata update, without the publication flag or
-- the cache wipe. An accepted append or correction preserves the invalidation
-- epoch; any other change of mutation_epoch advances it, exactly as before.
CREATE OR REPLACE FUNCTION publication_mutated() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE preserves boolean;
BEGIN
  preserves := NEW.mutation_epoch=OLD.mutation_epoch+1 AND NEW.graph_append_epoch=NEW.mutation_epoch
    AND NEW.graph_append_epoch IS DISTINCT FROM OLD.graph_append_epoch;
  UPDATE mutation_control SET graph_last_change_at=clock_timestamp(),
    graph_last_change_reason=CASE WHEN preserves THEN coalesce(NEW.graph_append_reason,'accepted-append') ELSE 'authority-or-unrecognized-change' END,
    graph_invalidation_epoch=CASE WHEN preserves THEN graph_invalidation_epoch ELSE NEW.mutation_epoch END,
    graph_last_invalidated_at=CASE WHEN preserves THEN graph_last_invalidated_at ELSE clock_timestamp() END WHERE singleton_id=1;
  RETURN NEW;
END;
$$;

-- (2) Participant lifecycle keeps its owner-scoped effects (revision bump,
-- the owner's own dependency and prepared-source rows, the social withdrawal
-- epoch) and loses the deletes of every owner's composition days and of the
-- shared preview cache.
CREATE OR REPLACE FUNCTION participant_input_state() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE input_versions SET revision=revision+1 WHERE participant_id=NEW.id;
  DELETE FROM community_model_history_dependencies WHERE participant_id=NEW.id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION participant_projection_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.owner_kind='social' THEN
    DELETE FROM prepared_source_days WHERE participant_id=OLD.id;
    UPDATE mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1;
  END IF;
  DELETE FROM input_versions WHERE participant_id=OLD.id;
  RETURN OLD;
END;
$$;

-- (3) Drop the queue, rebuild, model-history and preparation triggers, then
-- their functions. Plain DROP fails the migration on any drift from 0010.
DROP TRIGGER analysis_queued_insert ON input_versions;
DROP TRIGGER analysis_queued_update ON input_versions;
DROP TRIGGER participant_queue_removed ON participants;
DROP TRIGGER zz_daily_rebuild_queued ON telemetry_v1_chunks;
DROP TRIGGER community_model_history_v1_insert ON telemetry_v1_chunks;
DROP TRIGGER community_model_history_v1_update ON telemetry_v1_chunks;
DROP TRIGGER community_model_history_v1_delete ON telemetry_v1_chunks;
DROP TRIGGER prepared_source_discard ON telemetry_v1_records;
DROP TRIGGER preparation_progress_changed ON prepared_source_days;

DROP FUNCTION analysis_queued();
DROP FUNCTION participant_queue_removed();
DROP FUNCTION daily_rebuild_queued();
DROP FUNCTION invalidate_model_history_v1_insert();
DROP FUNCTION invalidate_model_history_v1_update();
DROP FUNCTION invalidate_model_history_v1_delete();
DROP FUNCTION prepared_source_discard();
DROP FUNCTION preparation_progress_changed();

-- (4) Nothing may refill the retired queues or the unmaintained prepared-
-- source progress rows. Existing rows are kept for the erasure inventories
-- and cascade with their participant. The seeded singletons
-- (current_queue_state, preparation_counters) are already unique.
-- preview_cache and community_model_composition_days are not refused here:
-- the owner-retirement residue sweep and its PostgreSQL specs still own
-- them, and no upload-path writer remains (the grep check covers readers).
CREATE FUNCTION refuse_retired_analytics_write() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'retired_analytics_write_refused' USING ERRCODE = 'P1005';
END;
$$;

CREATE TRIGGER retired_analytics_refusal BEFORE INSERT ON current_queue
FOR EACH ROW EXECUTE FUNCTION refuse_retired_analytics_write();
CREATE TRIGGER retired_analytics_refusal BEFORE INSERT ON refresh_lanes
FOR EACH ROW EXECUTE FUNCTION refuse_retired_analytics_write();
CREATE TRIGGER retired_analytics_refusal BEFORE INSERT ON daily_rebuilds
FOR EACH ROW EXECUTE FUNCTION refuse_retired_analytics_write();
CREATE TRIGGER retired_analytics_refusal BEFORE INSERT ON prepared_source_days
FOR EACH ROW EXECUTE FUNCTION refuse_retired_analytics_write();

-- (5) publication_state becomes the policy row. Set it to 'ready' once; from
-- here on the flag stays 'ready', the row stays the singleton and
-- policy_revision never decreases. A missing row fails the migration.
DO $$
BEGIN
  IF (SELECT count(*) FROM publication_state WHERE singleton = 1) <> 1 THEN
    RAISE EXCEPTION 'publication_policy_row_missing' USING ERRCODE = 'P1005';
  END IF;
END;
$$;

UPDATE publication_state
   SET publication_state = 'ready', changed_at = clock_timestamp()
 WHERE singleton = 1 AND publication_state <> 'ready';

CREATE FUNCTION publication_policy_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP <> 'UPDATE'
      OR NEW.singleton IS DISTINCT FROM OLD.singleton
      OR NEW.publication_state IS DISTINCT FROM 'ready'
      OR NEW.policy_revision < OLD.policy_revision THEN
    RAISE EXCEPTION 'publication_policy_row_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_policy_row_guard
BEFORE INSERT OR UPDATE OR DELETE ON publication_state
FOR EACH ROW EXECUTE FUNCTION publication_policy_row_guard();
