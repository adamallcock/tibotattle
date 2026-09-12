-- OPTIONAL fresh replacement ingestion role only, after baseline0060, the typed
-- admission adapters and source bridge. Never apply this to the retained source.
-- The original source remains available; all omitted analytics is repeatable.
-- Public reads require the independent authority AND policy fences. This role
-- remains prepared until the complete runtime/copy/publication qualification.
CREATE TABLE ingestion_analytics_separation (
 id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL CHECK(phase='prepared'),
 policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision>=1),
 empty_source_check INTEGER NOT NULL CHECK(empty_source_check=1)
) STRICT;
INSERT INTO ingestion_analytics_separation(id,phase,empty_source_check)
SELECT 1,'prepared',CASE WHEN EXISTS(SELECT 1 FROM telemetry_v1_records LIMIT 1) OR
 EXISTS(SELECT 1 FROM telemetry_v11_records LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_analysis_work LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_analysis_work_parts LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_analysis_work_stage LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_allowance_fit_cache LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_composition_cache LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_composition_days LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_prepared_source_days LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_prepared_usage_rows LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_prepared_usage_bins LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_prepared_fit_rows LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_prepared_plan_rows LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_daily_aggregates LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_weekly_snapshots LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_history_results LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_history_work LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_history_work_parts LIMIT 1) OR
 EXISTS(SELECT 1 FROM community_model_history_work_stage LIMIT 1) THEN 0 ELSE 1 END;
CREATE TRIGGER ingestion_analytics_separation_retained BEFORE DELETE ON ingestion_analytics_separation
BEGIN SELECT RAISE(ABORT,'ingestion_role_identity_retained'); END;
CREATE TRIGGER ingestion_analytics_separation_identity BEFORE UPDATE ON ingestion_analytics_separation
WHEN NEW.id IS NOT OLD.id OR NEW.phase IS NOT OLD.phase OR NEW.empty_source_check IS NOT OLD.empty_source_check
 OR NEW.policy_revision!=OLD.policy_revision+1
BEGIN SELECT RAISE(ABORT,'ingestion_role_identity_conflict'); END;

-- Keep all authority/admission and source revision triggers. The source bridge
-- captures withdrawal/erasure in the same transaction, before identity disappears.

DROP TRIGGER community_current_analysis_participant_state;
DROP TRIGGER community_current_analysis_revision_insert;
DROP TRIGGER community_current_analysis_revision_update;
DROP TRIGGER community_daily_aggregate_participant_withdrawal;
DROP TRIGGER community_model_composition_day_withdrawal;
DROP TRIGGER community_model_history_dependency_legacy_delete;
DROP TRIGGER community_model_history_dependency_legacy_insert;
DROP TRIGGER community_model_history_dependency_legacy_update;
DROP TRIGGER community_model_history_dependency_participant_state;
DROP TRIGGER community_model_history_dependency_successor_delete;
DROP TRIGGER community_model_history_dependency_successor_insert;
DROP TRIGGER community_model_history_dependency_successor_update;
DROP TRIGGER community_model_history_legacy_delete;
DROP TRIGGER community_model_history_legacy_insert;
DROP TRIGGER community_model_history_legacy_update;
DROP TRIGGER community_model_history_participant_delete;
DROP TRIGGER community_model_history_participant_state;
DROP TRIGGER community_model_history_successor_delete;
DROP TRIGGER community_model_history_successor_insert;
DROP TRIGGER community_model_history_successor_update;
DROP TRIGGER community_model_history_v1_delete;
DROP TRIGGER community_model_history_v1_insert;
DROP TRIGGER community_model_history_v1_update;
DROP TRIGGER community_public_source_device_withdraw_delete;
DROP TRIGGER community_public_source_device_withdraw_update;
DROP TRIGGER community_public_source_grant_withdraw_delete;
DROP TRIGGER community_public_source_grant_withdraw_update;
DROP TRIGGER community_public_source_head_withdraw_delete;
DROP TRIGGER community_public_source_ledger_withdraw_delete;
DROP TRIGGER community_public_source_ledger_withdraw_update;
DROP TRIGGER community_public_source_owner_withdraw_delete;
DROP TRIGGER community_public_source_owner_withdraw_update;
DROP TRIGGER community_public_source_participant_withdraw_delete;
DROP TRIGGER community_public_source_participant_withdraw_update;
DROP TRIGGER community_snapshot_participant_withdrawal;
DROP TRIGGER telemetry_v1_chunks_enqueue_daily_rebuild;

-- Consume the predecessor and advance source/CAS authority synchronously.
DROP TRIGGER telemetry_v11_head_insert_publish;
CREATE TRIGGER telemetry_v11_head_insert_publish AFTER INSERT ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM community_public_source_owners p
      WHERE p.participant_id = NEW.participant_id
   );
END;

-- Consume the predecessor and advance source/CAS authority synchronously.
DROP TRIGGER telemetry_v11_head_update_publish;
CREATE TRIGGER telemetry_v11_head_update_publish AFTER UPDATE ON telemetry_v11_domain_heads
BEGIN
  UPDATE telemetry_v11_domain_predecessors SET consumed_at = NEW.updated_at
    WHERE token_hash = (SELECT predecessor_token_hash FROM telemetry_v11_domains WHERE id = NEW.generation_id);
  UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = NEW.participant_id;
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1 AND EXISTS (
     SELECT 1 FROM community_public_source_owners p
      WHERE p.participant_id = NEW.participant_id
   );
END;

-- Preserve append/correction versus hard-mutation metadata without a cache write.
DROP TRIGGER community_allowance_input_mutated;
CREATE TRIGGER community_allowance_input_mutated
AFTER UPDATE OF mutation_epoch ON community_snapshot_mutation_control
FOR EACH ROW WHEN OLD.mutation_epoch IS NOT NEW.mutation_epoch
BEGIN
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
END;

-- Policy remains source-local. The separate revision invalidates publication
-- without touching every owner or falsely treating a weekly exclusion as opt-out.
DROP TRIGGER community_snapshot_policy_changed;
CREATE TRIGGER community_snapshot_policy_changed
AFTER UPDATE ON community_snapshot_policy
FOR EACH ROW
WHEN OLD.maturity_days IS NOT NEW.maturity_days
  OR OLD.minimum_accepted_collection_days IS NOT NEW.minimum_accepted_collection_days
  OR OLD.account_usage_events_cap IS NOT NEW.account_usage_events_cap
  OR OLD.account_token_components_cap IS NOT NEW.account_token_components_cap
  OR OLD.account_tool_units_cap IS NOT NEW.account_tool_units_cap
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  UPDATE ingestion_analytics_separation SET policy_revision=policy_revision+1 WHERE id=1;
END;

-- Policy remains source-local. The separate revision invalidates publication
-- without touching every owner or falsely treating a weekly exclusion as opt-out.
DROP TRIGGER community_aggregate_exclusion_changed;
CREATE TRIGGER community_aggregate_exclusion_changed
AFTER UPDATE ON community_aggregate_exclusions
FOR EACH ROW
WHEN (
  OLD.participant_id IS NOT NEW.participant_id
  OR OLD.scope IS NOT NEW.scope
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.state IS NOT NEW.state
  OR OLD.effective_at IS NOT NEW.effective_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.revoked_at IS NOT NEW.revoked_at
  OR OLD.revoked_by_digest IS NOT NEW.revoked_by_digest
) AND EXISTS (
  SELECT 1 FROM community_public_source_owners p
   WHERE p.participant_id = NEW.participant_id
)
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  UPDATE ingestion_analytics_separation SET policy_revision=policy_revision+1 WHERE id=1;
END;

-- Policy remains source-local. The separate revision invalidates publication
-- without touching every owner or falsely treating a weekly exclusion as opt-out.
DROP TRIGGER community_aggregate_exclusion_inserted;
CREATE TRIGGER community_aggregate_exclusion_inserted
AFTER INSERT ON community_aggregate_exclusions
FOR EACH ROW
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM community_public_source_owners p
   WHERE p.participant_id = NEW.participant_id
)
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  UPDATE ingestion_analytics_separation SET policy_revision=policy_revision+1 WHERE id=1;
END;

-- An accidental old scheduler or admin path cannot refill derived payloads in
-- ingestion. All such writes belong to the independently bound analytics role.
CREATE TRIGGER ingestion_analytics_payload_refusal_00 BEFORE INSERT ON community_analysis_work
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_01 BEFORE INSERT ON community_analysis_work_parts
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_02 BEFORE INSERT ON community_analysis_work_stage
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_03 BEFORE INSERT ON community_allowance_fit_cache
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_04 BEFORE INSERT ON community_model_composition_cache
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_05 BEFORE INSERT ON community_model_composition_days
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_06 BEFORE INSERT ON community_prepared_source_days
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_07 BEFORE INSERT ON community_prepared_usage_rows
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_08 BEFORE INSERT ON community_prepared_usage_bins
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_09 BEFORE INSERT ON community_prepared_fit_rows
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_10 BEFORE INSERT ON community_prepared_plan_rows
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_11 BEFORE INSERT ON community_daily_aggregates
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_12 BEFORE INSERT ON community_weekly_snapshots
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_13 BEFORE INSERT ON community_model_history_results
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_14 BEFORE INSERT ON community_model_history_work
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_15 BEFORE INSERT ON community_model_history_work_parts
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
CREATE TRIGGER ingestion_analytics_payload_refusal_16 BEFORE INSERT ON community_model_history_work_stage
BEGIN SELECT RAISE(ABORT,'analytics_write_requires_separate_database'); END;
