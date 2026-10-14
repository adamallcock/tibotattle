PRAGMA foreign_keys = ON;

-- Retained public evidence is authorized by a durable source, not by its
-- renewable upload lease. No consent or verified-person identity is invented.
-- A source needs an exact current v1.1 head on its sole enrollment device.
CREATE VIEW community_public_source_owners(participant_id, owner_kind, device_id) AS
SELECT p.id, p.owner_kind, NULL
FROM participants p WHERE p.owner_kind = 'social' AND p.state = 'active'
UNION ALL
SELECT p.id, p.owner_kind, device.id
FROM accountless_upload_owners owner
JOIN participants p ON p.id = owner.participant_id
JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
JOIN device_credentials device ON device.id = owner.device_credential_id
JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = owner.enrollment_device_id
 AND grant_row.participant_id = owner.participant_id
 AND grant_row.device_credential_id = owner.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
  AND device.state = 'active' AND device.revoked_at IS NULL
  AND grant_row.state = 'active' AND grant_row.revoked_at IS NULL AND grant_row.revocation_reason IS NULL
  AND device.participant_id = p.id AND device.authority_kind = 'accountless'
  AND device.id = ledger.device_id AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
  AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
  AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND grant_row.expires_at = ledger.expires_at
  AND EXISTS (SELECT 1 FROM telemetry_v11_domain_heads head
    JOIN telemetry_v11_domains domain ON domain.id = head.generation_id
    WHERE head.participant_id = p.id AND domain.participant_id = p.id
      AND domain.device_id = device.id);

-- Extend only current v1.1 and shared derived-data lanes. Legacy transport
-- admission/publication remains social-only; 0057--0059 stay byte-for-byte.

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
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

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
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

DROP TRIGGER community_current_analysis_fit_delete;
CREATE TRIGGER community_current_analysis_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=OLD.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_fit_insert;
CREATE TRIGGER community_current_analysis_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=NEW.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_fit_update;
CREATE TRIGGER community_current_analysis_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id IN (OLD.participant_id,NEW.participant_id) AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_model_delete;
CREATE TRIGGER community_current_analysis_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=OLD.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_model_insert;
CREATE TRIGGER community_current_analysis_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=NEW.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_model_update;
CREATE TRIGGER community_current_analysis_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id IN (OLD.participant_id,NEW.participant_id) AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER community_current_analysis_revision_insert;
CREATE TRIGGER community_current_analysis_revision_insert AFTER INSERT ON community_analytical_input_versions
WHEN NEW.revision > 0
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=NEW.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER community_current_analysis_revision_update;
CREATE TRIGGER community_current_analysis_revision_update AFTER UPDATE OF revision ON community_analytical_input_versions
WHEN OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.participant_id,1,s.window_generation,1,0 FROM community_public_source_owners p,community_current_analysis_queue_state s
    WHERE p.participant_id=NEW.participant_id AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER community_model_history_successor_delete;
CREATE TRIGGER community_model_history_successor_delete
AFTER DELETE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id);
END;

DROP TRIGGER community_model_history_successor_insert;
CREATE TRIGGER community_model_history_successor_insert
AFTER INSERT ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER community_model_history_successor_update;
CREATE TRIGGER community_model_history_successor_update
AFTER UPDATE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id));
END;

DROP TRIGGER community_preparation_progress_delete;
CREATE TRIGGER community_preparation_progress_delete AFTER DELETE ON community_prepared_source_days
WHEN EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id)
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=0
    OR complete_days<(OLD.phase='complete') OR building_days<(OLD.phase IN ('quota','usage'))
    OR retiring_days<(OLD.phase='discarding') OR checkpoint_steps<OLD.progress_revision
    OR quota_observations<OLD.quota_count OR usage_events<OLD.usage_count);
  UPDATE community_preparation_progress_counters SET tracked_days=tracked_days-1,
    complete_days=complete_days-(OLD.phase='complete'),
    building_days=building_days-(OLD.phase IN ('quota','usage')),
    retiring_days=retiring_days-(OLD.phase='discarding'),
    checkpoint_steps=checkpoint_steps-OLD.progress_revision,
    quota_observations=quota_observations-OLD.quota_count,usage_events=usage_events-OLD.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;

DROP TRIGGER community_preparation_progress_insert;
CREATE TRIGGER community_preparation_progress_insert AFTER INSERT ON community_prepared_source_days
WHEN EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id)
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=9007199254740991
    OR checkpoint_steps>9007199254740991-NEW.progress_revision
    OR quota_observations>9007199254740991-NEW.quota_count
    OR usage_events>9007199254740991-NEW.usage_count);
  UPDATE community_preparation_progress_counters SET tracked_days=tracked_days+1,
    complete_days=complete_days+(NEW.phase='complete'),
    building_days=building_days+(NEW.phase IN ('quota','usage')),
    retiring_days=retiring_days+(NEW.phase='discarding'),
    checkpoint_steps=checkpoint_steps+NEW.progress_revision,
    quota_observations=quota_observations+NEW.quota_count,usage_events=usage_events+NEW.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;

DROP TRIGGER community_preparation_progress_update;
CREATE TRIGGER community_preparation_progress_update AFTER UPDATE ON community_prepared_source_days
WHEN (OLD.phase IS NOT NEW.phase OR OLD.progress_revision IS NOT NEW.progress_revision
  OR OLD.quota_count IS NOT NEW.quota_count OR OLD.usage_count IS NOT NEW.usage_count
) AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id))
BEGIN
  UPDATE community_preparation_progress_counters SET is_exact=0
  WHERE singleton_id=1 AND is_exact=1 AND (tracked_days=0
    OR complete_days<(OLD.phase='complete') OR building_days<(OLD.phase IN ('quota','usage'))
    OR retiring_days<(OLD.phase='discarding') OR checkpoint_steps<OLD.progress_revision
    OR quota_observations<OLD.quota_count OR usage_events<OLD.usage_count
    OR checkpoint_steps-OLD.progress_revision>9007199254740991-NEW.progress_revision
    OR quota_observations-OLD.quota_count>9007199254740991-NEW.quota_count
    OR usage_events-OLD.usage_count>9007199254740991-NEW.usage_count);
  UPDATE community_preparation_progress_counters SET
    complete_days=complete_days-(OLD.phase='complete')+(NEW.phase='complete'),
    building_days=building_days-(OLD.phase IN ('quota','usage'))+(NEW.phase IN ('quota','usage')),
    retiring_days=retiring_days-(OLD.phase='discarding')+(NEW.phase='discarding'),
    checkpoint_steps=checkpoint_steps-OLD.progress_revision+NEW.progress_revision,
    quota_observations=quota_observations-OLD.quota_count+NEW.quota_count,
    usage_events=usage_events-OLD.usage_count+NEW.usage_count
  WHERE singleton_id=1 AND is_exact=1;
END;

DROP TRIGGER community_publication_fit_delete;
CREATE TRIGGER community_publication_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id); END;

DROP TRIGGER community_publication_fit_insert;
CREATE TRIGGER community_publication_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id); END;

DROP TRIGGER community_publication_fit_update;
CREATE TRIGGER community_publication_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id)); END;

DROP TRIGGER community_publication_model_delete;
CREATE TRIGGER community_publication_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id); END;

DROP TRIGGER community_publication_model_insert;
CREATE TRIGGER community_publication_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id); END;

DROP TRIGGER community_publication_model_update;
CREATE TRIGGER community_publication_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id)); END;

DROP TRIGGER community_refresh_fit_delete;
CREATE TRIGGER community_refresh_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id);
END;

DROP TRIGGER community_refresh_fit_insert;
CREATE TRIGGER community_refresh_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER community_refresh_fit_update;
CREATE TRIGGER community_refresh_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id));
END;

DROP TRIGGER community_refresh_model_delete;
CREATE TRIGGER community_refresh_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=OLD.participant_id);
END;

DROP TRIGGER community_refresh_model_insert;
CREATE TRIGGER community_refresh_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id=NEW.participant_id);
END;

DROP TRIGGER community_refresh_model_update;
CREATE TRIGGER community_refresh_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE (p.participant_id=OLD.participant_id OR p.participant_id=NEW.participant_id));
END;

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
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
      AND EXISTS (
        SELECT 1 FROM community_public_source_owners p
         WHERE p.participant_id = NEW.participant_id
      )
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;

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
  INSERT INTO community_daily_aggregate_rebuilds (day, requested_epoch, requested_at)
    SELECT observed_day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1), NEW.updated_at
    FROM telemetry_v11_domain_days WHERE generation_id = NEW.generation_id
      AND EXISTS (
        SELECT 1 FROM community_public_source_owners p
         WHERE p.participant_id = NEW.participant_id
      )
    ON CONFLICT(day) DO UPDATE SET requested_epoch = excluded.requested_epoch, requested_at = excluded.requested_at;
END;

-- Authority withdrawal uses OLD membership, before deletion/cascade.
-- Renewable expiry/last-used changes do not withdraw durable retained data.

CREATE TRIGGER community_public_source_ledger_withdraw_update BEFORE UPDATE OF state, revoked_at, revocation_reason, schema_version, policy_version, authorization_basis, device_secret_hash, device_id ON accountless_enrollment_ledger
WHEN ((EXISTS (SELECT 1 FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id)) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis OR OLD.device_secret_hash IS NOT NEW.device_secret_hash OR OLD.device_id IS NOT NEW.device_id)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id));
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id)));
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=(SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id)
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_ledger_withdraw_delete BEFORE DELETE ON accountless_enrollment_ledger
WHEN (EXISTS (SELECT 1 FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id));
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id)));
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=(SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id)
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_owner_withdraw_update BEFORE UPDATE OF state, revoked_at, revocation_reason, enrollment_device_id, participant_id, device_credential_id, policy_version, authorization_basis ON accountless_upload_owners
WHEN ((1) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_owner_withdraw_delete BEFORE DELETE ON accountless_upload_owners
WHEN (1) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_device_withdraw_update BEFORE UPDATE OF state, revoked_at, authority_kind, participant_id, id, accountless_enrollment_device_id, secret_hash, social_verified_at, paired_via_pairing_id ON device_credentials
WHEN ((OLD.authority_kind='accountless') AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.authority_kind IS NOT NEW.authority_kind OR OLD.participant_id IS NOT NEW.participant_id OR OLD.id IS NOT NEW.id OR OLD.accountless_enrollment_device_id IS NOT NEW.accountless_enrollment_device_id OR OLD.secret_hash IS NOT NEW.secret_hash OR OLD.social_verified_at IS NOT NEW.social_verified_at OR OLD.paired_via_pairing_id IS NOT NEW.paired_via_pairing_id)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_device_withdraw_delete BEFORE DELETE ON device_credentials
WHEN (OLD.authority_kind='accountless') AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_grant_withdraw_update BEFORE UPDATE OF state, revoked_at, revocation_reason, enrollment_device_id, participant_id, device_credential_id, telemetry_schema_version, field_dictionary_version, privacy_contract_version ON accountless_v11_device_authorizations
WHEN ((1) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id OR OLD.telemetry_schema_version IS NOT NEW.telemetry_schema_version OR OLD.field_dictionary_version IS NOT NEW.field_dictionary_version OR OLD.privacy_contract_version IS NOT NEW.privacy_contract_version)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_grant_withdraw_delete BEFORE DELETE ON accountless_v11_device_authorizations
WHEN (1) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_participant_withdraw_update BEFORE UPDATE OF state, owner_kind, id ON participants
WHEN ((OLD.owner_kind='accountless') AND (OLD.state IS NOT NEW.state OR OLD.owner_kind IS NOT NEW.owner_kind OR OLD.id IS NOT NEW.id)) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_participant_withdraw_delete BEFORE DELETE ON participants
WHEN (OLD.owner_kind='accountless') AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;

CREATE TRIGGER community_public_source_head_withdraw_delete BEFORE DELETE ON telemetry_v11_domain_heads
WHEN (EXISTS (SELECT 1 FROM participants WHERE id=OLD.participant_id AND owner_kind='accountless')) AND (EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=OLD.participant_id) OR EXISTS (SELECT 1 FROM community_publication_members WHERE participant_id=OLD.participant_id))
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=OLD.participant_id;
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
  -- Count only this OLD source's indexed prepared heads while authority is
  -- still valid. Later ledger/owner/device/grant withdrawals see no eligible
  -- source and cannot subtract it again. No telemetry or JSON is read.
  UPDATE community_preparation_progress_counters
    SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
      SELECT CASE WHEN can_subtract THEN 1 ELSE 0 END,
      CASE WHEN can_subtract THEN tracked_days-old_tracked_days ELSE tracked_days END,
      CASE WHEN can_subtract THEN complete_days-old_complete_days ELSE complete_days END,
      CASE WHEN can_subtract THEN building_days-old_building_days ELSE building_days END,
      CASE WHEN can_subtract THEN retiring_days-old_retiring_days ELSE retiring_days END,
      CASE WHEN can_subtract THEN checkpoint_steps-old_checkpoint_steps ELSE checkpoint_steps END,
      CASE WHEN can_subtract THEN quota_observations-old_quota_observations ELSE quota_observations END,
      CASE WHEN can_subtract THEN usage_events-old_usage_events ELSE usage_events END
      FROM (SELECT totals.*, tracked_days>=old_tracked_days AND complete_days>=old_complete_days AND building_days>=old_building_days AND retiring_days>=old_retiring_days AND checkpoint_steps>=old_checkpoint_steps AND quota_observations>=old_quota_observations AND usage_events>=old_usage_events AS can_subtract
        FROM (SELECT COUNT(*) AS old_tracked_days,
        TOTAL(phase='complete') AS old_complete_days,
        TOTAL(phase IN ('quota','usage')) AS old_building_days,
        TOTAL(phase='discarding') AS old_retiring_days,
        TOTAL(progress_revision) AS old_checkpoint_steps,
        TOTAL(quota_count) AS old_quota_observations,
        TOTAL(usage_count) AS old_usage_events
        FROM community_prepared_source_days WHERE participant_id=OLD.participant_id) AS totals)
    )
    WHERE singleton_id=1 AND is_exact=1
      AND EXISTS (SELECT 1 FROM community_public_source_owners WHERE participant_id=OLD.participant_id);
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');
  INSERT INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT days.observed_day,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM telemetry_v11_domain_heads head JOIN telemetry_v11_domain_days days ON days.generation_id=head.generation_id
    WHERE head.participant_id=OLD.participant_id
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;

END;


-- One-time policy invalidation is metadata-only; retained source rows stay unchanged.
  UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
  UPDATE community_publication_generation SET published = 0, phase = 'retiring' WHERE singleton = 1;
  UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1;
-- Recount only retained preparation-head metadata under the new source
-- policy. TOTAL cannot overflow SQLite's integer accumulator; an impossible
-- total disables this optional view without changing any source rows.
UPDATE community_preparation_progress_counters
  SET (is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events) = (
    SELECT CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN 1 ELSE 0 END,
      CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_tracked_days ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_complete_days ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_building_days ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_retiring_days ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_checkpoint_steps ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_quota_observations ELSE 0 END, CASE WHEN total_tracked_days<=9007199254740991 AND total_complete_days<=9007199254740991 AND total_building_days<=9007199254740991 AND total_retiring_days<=9007199254740991 AND total_checkpoint_steps<=9007199254740991 AND total_quota_observations<=9007199254740991 AND total_usage_events<=9007199254740991 THEN total_usage_events ELSE 0 END
    FROM (SELECT COUNT(*) AS total_tracked_days, TOTAL(phase='complete') AS total_complete_days, TOTAL(phase IN ('quota','usage')) AS total_building_days, TOTAL(phase='discarding') AS total_retiring_days, TOTAL(progress_revision) AS total_checkpoint_steps, TOTAL(quota_count) AS total_quota_observations, TOTAL(usage_count) AS total_usage_events
      FROM community_prepared_source_days prepared
      WHERE EXISTS (SELECT 1 FROM community_public_source_owners source
        WHERE source.participant_id=prepared.participant_id))
  ) WHERE singleton_id=1;
  UPDATE community_refresh_lanes SET state = 'queued', completed_at = NULL, restart_reason = 'input_changed';
  DELETE FROM community_snapshot_builders;
  DELETE FROM community_model_composition_days;
  INSERT INTO community_daily_aggregate_rebuilds(day, requested_epoch, requested_at)
    SELECT day, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_daily_aggregates WHERE release_state = 'published'
    ON CONFLICT(day) DO UPDATE SET requested_epoch=excluded.requested_epoch, requested_at=excluded.requested_at;
  UPDATE community_daily_aggregates SET release_state='withdrawn', withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_state='published';
  INSERT INTO community_weekly_snapshot_rebuilds(week_start,week_end,ingestion_cutoff_at,requested_epoch,requested_at)
    SELECT week_start,week_end,ingestion_cutoff_at,(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM community_weekly_snapshots WHERE release_state IN ('published','suppressed')
    ON CONFLICT(week_start) DO UPDATE SET requested_epoch=excluded.requested_epoch,requested_at=excluded.requested_at;
  UPDATE community_weekly_snapshots SET release_state='withdrawn',withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    withdrawal_epoch=(SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1)
    WHERE release_state IN ('published','suppressed');

-- The daily lane drains this finite retained-input bootstrap in atomic,
-- budgeted pages. Publication stays fenced until completed=1. No calendar
-- horizon or capped owner seed silently omits older retained days.
CREATE TABLE community_public_source_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  policy_version TEXT NOT NULL CHECK (policy_version='community-public-sources-v1'),
  participant_cursor TEXT NOT NULL DEFAULT '',
  source_day_cursor TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1))
) STRICT;
INSERT INTO community_public_source_bootstrap
SELECT 1,'community-public-sources-v1','','',
  NOT EXISTS (SELECT 1 FROM community_public_source_owners WHERE owner_kind='accountless');
