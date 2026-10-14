PRAGMA foreign_keys = ON;

-- The installation key is durable, while its upload authority remains a
-- finite lease.  Keep the original issued_at and secret immutable; these two
-- fields describe only the latest authorized lease and are advanced together
-- with the same owner/device/v1.1 authorization graph below.
ALTER TABLE accountless_enrollment_ledger
  ADD COLUMN renewal_generation INTEGER NOT NULL DEFAULT 0
    CHECK (renewal_generation BETWEEN 0 AND 2147483647);
ALTER TABLE accountless_enrollment_ledger
  ADD COLUMN renewed_at TEXT
    CONSTRAINT accountless_enrollment_lease_shape CHECK (
      COALESCE((
        issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)
        AND (
          (
            renewal_generation = 0
            AND renewed_at IS NULL
            AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+30 days')
          )
          OR
          (
            renewal_generation BETWEEN 1 AND 2147483647
            AND renewed_at IS NOT NULL
            AND renewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', renewed_at)
            AND renewed_at >= issued_at
            AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', renewed_at, '+30 days')
          )
        )
      ), 0)
    );

-- 0047 intentionally made the owner graph immutable. Renewal needs exactly
-- one controlled exception: an active graph may advance its common expiry in
-- a D1 batch after the ledger has recorded the next generation. The named
-- ledger CHECK rejects a standalone expiry change; Worker-side compare-and-
-- swap and exact graph readback authorize the sole coordinated transition.
-- Every other identity, secret, policy, consent and revocation invariant
-- remains frozen.
DROP TRIGGER accountless_device_credential_nonrenewable;
DROP TRIGGER accountless_upload_owner_immutable;
DROP TRIGGER accountless_v11_authorization_immutable;

CREATE TRIGGER accountless_device_credential_nonrenewable
BEFORE UPDATE OF secret_hash, expires_at, issued_at, credential_generation,
  authority_kind, paired_via_pairing_id, accountless_enrollment_device_id
ON device_credentials
WHEN OLD.authority_kind = 'accountless'
 AND NOT (
   NEW.id IS OLD.id
   AND NEW.participant_id IS OLD.participant_id
   AND NEW.authority_kind = 'accountless'
   AND NEW.paired_via_pairing_id IS NULL
   AND NEW.accountless_enrollment_device_id IS OLD.accountless_enrollment_device_id
   AND NEW.secret_hash IS OLD.secret_hash
   AND NEW.state = 'active'
   AND NEW.issued_at IS OLD.issued_at
   AND NEW.expires_at > OLD.expires_at
   AND NEW.last_used_at IS OLD.last_used_at
   AND NEW.revoked_at IS OLD.revoked_at
   AND NEW.social_verified_at IS NULL
   AND NEW.credential_generation IS OLD.credential_generation
   AND EXISTS (
     SELECT 1
       FROM accountless_enrollment_ledger ledger
       JOIN accountless_upload_owners owner
         ON owner.enrollment_device_id = ledger.device_id
       JOIN accountless_v11_device_authorizations grant_row
         ON grant_row.enrollment_device_id = ledger.device_id
      WHERE ledger.device_id = OLD.accountless_enrollment_device_id
        AND ledger.state = 'active'
        AND ledger.expires_at = NEW.expires_at
        AND ledger.renewal_generation BETWEEN 1 AND 2147483647
        AND ledger.renewed_at IS NOT NULL
        AND owner.participant_id = OLD.participant_id
        AND owner.device_credential_id = OLD.id
        AND owner.state = 'active' AND owner.expires_at = OLD.expires_at
        AND grant_row.participant_id = OLD.participant_id
        AND grant_row.device_credential_id = OLD.id
        AND grant_row.state = 'active' AND grant_row.expires_at = OLD.expires_at
   )
 )
BEGIN SELECT RAISE(ABORT, 'accountless device credential immutable'); END;

CREATE TRIGGER accountless_upload_owner_immutable
BEFORE UPDATE ON accountless_upload_owners
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.authorization_basis IS NOT OLD.authorization_basis
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
  OR (NEW.expires_at IS NOT OLD.expires_at AND NOT (
    NEW.state = 'active'
    AND NEW.revoked_at IS NULL AND NEW.revocation_reason IS NULL
    AND NEW.expires_at > OLD.expires_at
    AND EXISTS (
      SELECT 1
        FROM accountless_enrollment_ledger ledger
        JOIN device_credentials device ON device.id = OLD.device_credential_id
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = OLD.enrollment_device_id
         AND grant_row.participant_id = OLD.participant_id
         AND grant_row.device_credential_id = OLD.device_credential_id
       WHERE ledger.device_id = OLD.enrollment_device_id
         AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
         AND ledger.renewal_generation BETWEEN 1 AND 2147483647
         AND ledger.renewed_at IS NOT NULL
         AND device.participant_id = OLD.participant_id
         AND device.authority_kind = 'accountless' AND device.state = 'active'
         AND device.expires_at = ledger.expires_at
         AND grant_row.state = 'active' AND grant_row.expires_at = OLD.expires_at
    )
  ))
BEGIN SELECT RAISE(ABORT, 'accountless owner immutable'); END;

CREATE TRIGGER accountless_v11_authorization_immutable
BEFORE UPDATE ON accountless_v11_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
  OR (NEW.expires_at IS NOT OLD.expires_at AND NOT (
    NEW.state = 'active'
    AND NEW.revoked_at IS NULL AND NEW.revocation_reason IS NULL
    AND NEW.expires_at > OLD.expires_at
    AND EXISTS (
      SELECT 1
        FROM accountless_enrollment_ledger ledger
        JOIN device_credentials device ON device.id = OLD.device_credential_id
        JOIN accountless_upload_owners owner
          ON owner.enrollment_device_id = OLD.enrollment_device_id
         AND owner.participant_id = OLD.participant_id
         AND owner.device_credential_id = OLD.device_credential_id
       WHERE ledger.device_id = OLD.enrollment_device_id
         AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
         AND ledger.renewal_generation BETWEEN 1 AND 2147483647
         AND ledger.renewed_at IS NOT NULL
         AND device.participant_id = OLD.participant_id
         AND device.authority_kind = 'accountless' AND device.state = 'active'
         AND device.expires_at = ledger.expires_at
         AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
    )
  ))
BEGIN SELECT RAISE(ABORT, 'accountless authorization immutable'); END;


-- Rehydrate the exact 0046–0056 trigger inventory after the root-table rebuild.
DROP TRIGGER IF EXISTS community_allowance_input_mutated;
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

DROP TRIGGER IF EXISTS community_analysis_work_parts_immutable;
CREATE TRIGGER community_analysis_work_parts_immutable
BEFORE UPDATE ON community_analysis_work_parts
BEGIN
  SELECT RAISE(ABORT, 'community analysis part immutable');
END;

DROP TRIGGER IF EXISTS community_analytical_input_legacy_update;
CREATE TRIGGER community_analytical_input_legacy_update
AFTER UPDATE ON telemetry_contributions FOR EACH ROW WHEN (OLD.status = 'accepted' OR NEW.status = 'accepted') AND (
  OLD.id IS NOT NEW.id
  OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.plaintext_digest IS NOT NEW.plaintext_digest
  OR OLD.status IS NOT NEW.status
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.range_start IS NOT NEW.range_start
  OR OLD.range_end IS NOT NEW.range_end
  OR OLD.client_platform IS NOT NEW.client_platform
  OR OLD.provider_policy_epoch IS NOT NEW.provider_policy_epoch
  OR OLD.estimated_api_cost_usd IS NOT NEW.estimated_api_cost_usd
  OR OLD.priced_event_coverage_percent IS NOT NEW.priced_event_coverage_percent
  OR OLD.unknown_model_event_count IS NOT NEW.unknown_model_event_count
  OR OLD.unknown_billable_units IS NOT NEW.unknown_billable_units
  OR OLD.price_basis IS NOT NEW.price_basis
  OR OLD.declared_record_count IS NOT NEW.declared_record_count
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.upload_authorization_id IS NOT NEW.upload_authorization_id
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd
  OR OLD.server_priced_event_count IS NOT NEW.server_priced_event_count
  OR OLD.server_partially_priced_event_count IS NOT NEW.server_partially_priced_event_count
  OR OLD.server_unpriced_event_count IS NOT NEW.server_unpriced_event_count
  OR OLD.server_pricing_method_version IS NOT NEW.server_pricing_method_version
  OR OLD.server_price_registry_version IS NOT NEW.server_price_registry_version
  OR OLD.server_price_registry_sha256 IS NOT NEW.server_price_registry_sha256
  OR OLD.transport_schema_version IS NOT NEW.transport_schema_version
  OR OLD.dataset_id IS NOT NEW.dataset_id
  OR OLD.dataset_part_index IS NOT NEW.dataset_part_index
  OR OLD.dataset_part_count IS NOT NEW.dataset_part_count
  OR OLD.dataset_completeness IS NOT NEW.dataset_completeness
  OR OLD.dataset_range_start IS NOT NEW.dataset_range_start
  OR OLD.dataset_range_end IS NOT NEW.dataset_range_end
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.server_price_basis IS NOT NEW.server_price_basis
  OR OLD.server_price_epoch_basis IS NOT NEW.server_price_epoch_basis
  OR OLD.server_price_event_time_start IS NOT NEW.server_price_event_time_start
  OR OLD.server_price_event_time_end IS NOT NEW.server_price_event_time_end
)
BEGIN
  INSERT INTO community_analytical_input_versions (participant_id,revision)
    SELECT id,1 FROM participants WHERE id=OLD.participant_id OR id=NEW.participant_id
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1 AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_analytical_input_v1_insert;
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
    WHERE singleton_id = 1 AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
  DELETE FROM community_graph_update_scope WHERE new_chunk_id = NEW.id;
END;

DROP TRIGGER IF EXISTS community_analytical_input_v1_update;
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
    WHERE singleton_id = 1 AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
  UPDATE community_graph_update_scope SET expected_epoch = expected_epoch + 1, phase = 'insert'
    WHERE old_chunk_id = OLD.id AND phase = 'supersede'
      AND expected_epoch + 1 = (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1)
      AND expected_epoch + 1 = (SELECT graph_append_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1)
      AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_current_analysis_fit_delete;
CREATE TRIGGER community_current_analysis_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_fit_insert;
CREATE TRIGGER community_current_analysis_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_fit_update;
CREATE TRIGGER community_current_analysis_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id IN (OLD.participant_id,NEW.participant_id) AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_identity_immutable;
CREATE TRIGGER community_current_analysis_identity_immutable
BEFORE UPDATE OF id, participant_id ON community_current_analysis_queue
WHEN OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id
BEGIN
  SELECT RAISE(ABORT, 'current analysis membership identity is immutable');
END;

DROP TRIGGER IF EXISTS community_current_analysis_model_delete;
CREATE TRIGGER community_current_analysis_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=OLD.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_model_insert;
CREATE TRIGGER community_current_analysis_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_model_update;
CREATE TRIGGER community_current_analysis_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id IN (OLD.participant_id,NEW.participant_id) AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
END;

DROP TRIGGER IF EXISTS community_current_analysis_participant_state;
CREATE TRIGGER community_current_analysis_participant_state AFTER UPDATE OF state ON participants
WHEN NEW.state != 'active'
BEGIN
  DELETE FROM community_current_analysis_queue WHERE participant_id=NEW.id;
END;

DROP TRIGGER IF EXISTS community_current_analysis_revision_insert;
CREATE TRIGGER community_current_analysis_revision_insert AFTER INSERT ON community_analytical_input_versions
WHEN NEW.revision > 0
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_current_analysis_revision_update;
CREATE TRIGGER community_current_analysis_revision_update AFTER UPDATE OF revision ON community_analytical_input_versions
WHEN OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO community_current_analysis_queue
    (participant_id,dirty_generation,window_generation,pending,last_served_sequence)
    SELECT p.id,1,s.window_generation,1,0 FROM participants p,community_current_analysis_queue_state s
    WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social' AND s.singleton_id=1
    ON CONFLICT(participant_id) DO UPDATE SET dirty_generation=dirty_generation+1,pending=1;
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='input_changed'
    WHERE lane='current' AND state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_legacy_delete;
CREATE TRIGGER community_model_history_dependency_legacy_delete
AFTER DELETE ON telemetry_contributions FOR EACH ROW WHEN OLD.status = 'accepted'
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_legacy_insert;
CREATE TRIGGER community_model_history_dependency_legacy_insert
AFTER INSERT ON telemetry_contributions FOR EACH ROW WHEN NEW.status = 'accepted'
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = NEW.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_legacy_update;
CREATE TRIGGER community_model_history_dependency_legacy_update
AFTER UPDATE ON telemetry_contributions FOR EACH ROW WHEN (OLD.status = 'accepted' OR NEW.status = 'accepted') AND (
  OLD.id IS NOT NEW.id
  OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.plaintext_digest IS NOT NEW.plaintext_digest
  OR OLD.status IS NOT NEW.status
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.range_start IS NOT NEW.range_start
  OR OLD.range_end IS NOT NEW.range_end
  OR OLD.client_platform IS NOT NEW.client_platform
  OR OLD.provider_policy_epoch IS NOT NEW.provider_policy_epoch
  OR OLD.estimated_api_cost_usd IS NOT NEW.estimated_api_cost_usd
  OR OLD.priced_event_coverage_percent IS NOT NEW.priced_event_coverage_percent
  OR OLD.unknown_model_event_count IS NOT NEW.unknown_model_event_count
  OR OLD.unknown_billable_units IS NOT NEW.unknown_billable_units
  OR OLD.price_basis IS NOT NEW.price_basis
  OR OLD.declared_record_count IS NOT NEW.declared_record_count
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.upload_authorization_id IS NOT NEW.upload_authorization_id
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd
  OR OLD.server_priced_event_count IS NOT NEW.server_priced_event_count
  OR OLD.server_partially_priced_event_count IS NOT NEW.server_partially_priced_event_count
  OR OLD.server_unpriced_event_count IS NOT NEW.server_unpriced_event_count
  OR OLD.server_pricing_method_version IS NOT NEW.server_pricing_method_version
  OR OLD.server_price_registry_version IS NOT NEW.server_price_registry_version
  OR OLD.server_price_registry_sha256 IS NOT NEW.server_price_registry_sha256
  OR OLD.transport_schema_version IS NOT NEW.transport_schema_version
  OR OLD.dataset_id IS NOT NEW.dataset_id
  OR OLD.dataset_part_index IS NOT NEW.dataset_part_index
  OR OLD.dataset_part_count IS NOT NEW.dataset_part_count
  OR OLD.dataset_completeness IS NOT NEW.dataset_completeness
  OR OLD.dataset_range_start IS NOT NEW.dataset_range_start
  OR OLD.dataset_range_end IS NOT NEW.dataset_range_end
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.server_price_basis IS NOT NEW.server_price_basis
  OR OLD.server_price_epoch_basis IS NOT NEW.server_price_epoch_basis
  OR OLD.server_price_event_time_start IS NOT NEW.server_price_event_time_start
  OR OLD.server_price_event_time_end IS NOT NEW.server_price_event_time_end
)
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id OR participant_id = NEW.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_participant_state;
CREATE TRIGGER community_model_history_dependency_participant_state
AFTER UPDATE OF state ON participants FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = NEW.id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_successor_delete;
CREATE TRIGGER community_model_history_dependency_successor_delete
AFTER DELETE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = OLD.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_successor_insert;
CREATE TRIGGER community_model_history_dependency_successor_insert
AFTER INSERT ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = NEW.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_dependency_successor_update;
CREATE TRIGGER community_model_history_dependency_successor_update
AFTER UPDATE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = OLD.participant_id OR participant_id = NEW.participant_id;
END;

DROP TRIGGER IF EXISTS community_model_history_legacy_delete;
CREATE TRIGGER community_model_history_legacy_delete
AFTER DELETE ON telemetry_contributions FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_legacy_insert;
CREATE TRIGGER community_model_history_legacy_insert
AFTER INSERT ON telemetry_contributions FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_legacy_update;
CREATE TRIGGER community_model_history_legacy_update
AFTER UPDATE ON telemetry_contributions FOR EACH ROW WHEN (OLD.status = 'accepted' OR NEW.status = 'accepted') AND (
  OLD.id IS NOT NEW.id
  OR OLD.participant_id IS NOT NEW.participant_id
  OR OLD.plaintext_digest IS NOT NEW.plaintext_digest
  OR OLD.status IS NOT NEW.status
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.range_start IS NOT NEW.range_start
  OR OLD.range_end IS NOT NEW.range_end
  OR OLD.client_platform IS NOT NEW.client_platform
  OR OLD.provider_policy_epoch IS NOT NEW.provider_policy_epoch
  OR OLD.estimated_api_cost_usd IS NOT NEW.estimated_api_cost_usd
  OR OLD.priced_event_coverage_percent IS NOT NEW.priced_event_coverage_percent
  OR OLD.unknown_model_event_count IS NOT NEW.unknown_model_event_count
  OR OLD.unknown_billable_units IS NOT NEW.unknown_billable_units
  OR OLD.price_basis IS NOT NEW.price_basis
  OR OLD.declared_record_count IS NOT NEW.declared_record_count
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.upload_authorization_id IS NOT NEW.upload_authorization_id
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd
  OR OLD.server_priced_event_count IS NOT NEW.server_priced_event_count
  OR OLD.server_partially_priced_event_count IS NOT NEW.server_partially_priced_event_count
  OR OLD.server_unpriced_event_count IS NOT NEW.server_unpriced_event_count
  OR OLD.server_pricing_method_version IS NOT NEW.server_pricing_method_version
  OR OLD.server_price_registry_version IS NOT NEW.server_price_registry_version
  OR OLD.server_price_registry_sha256 IS NOT NEW.server_price_registry_sha256
  OR OLD.transport_schema_version IS NOT NEW.transport_schema_version
  OR OLD.dataset_id IS NOT NEW.dataset_id
  OR OLD.dataset_part_index IS NOT NEW.dataset_part_index
  OR OLD.dataset_part_count IS NOT NEW.dataset_part_count
  OR OLD.dataset_completeness IS NOT NEW.dataset_completeness
  OR OLD.dataset_range_start IS NOT NEW.dataset_range_start
  OR OLD.dataset_range_end IS NOT NEW.dataset_range_end
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count
  OR OLD.server_price_basis IS NOT NEW.server_price_basis
  OR OLD.server_price_epoch_basis IS NOT NEW.server_price_epoch_basis
  OR OLD.server_price_event_time_start IS NOT NEW.server_price_event_time_start
  OR OLD.server_price_event_time_end IS NOT NEW.server_price_event_time_end
)
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_participant_delete;
CREATE TRIGGER community_model_history_participant_delete
BEFORE DELETE ON participants FOR EACH ROW WHEN OLD.owner_kind='social'
BEGIN
  -- A foreign-key cascade removes the parent before child DELETE triggers can
  -- consult participants.owner_kind. Delete social heads while that evidence
  -- is still present so the existing exact counter trigger observes the same
  -- removal it observes for direct social-head deletion.
  DELETE FROM community_prepared_source_days WHERE participant_id=OLD.id;
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL;
  DELETE FROM admin_community_allowance_preview_cache;
  -- Child telemetry cascades are intentionally social-gated and run after
  -- this root is no longer queryable. A social owner erasure is nevertheless
  -- a hard graph invalidation, exactly once at the root boundary.
  UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1
    WHERE singleton_id=1;
END;

DROP TRIGGER IF EXISTS community_model_history_participant_state;
CREATE TRIGGER community_model_history_participant_state
AFTER UPDATE OF state ON participants FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  DELETE FROM community_model_history_work WHERE participant_id = NEW.id;
  DELETE FROM community_model_history_results WHERE participant_id = NEW.id;
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND NEW.owner_kind='social';
END;

DROP TRIGGER IF EXISTS community_model_history_successor_delete;
CREATE TRIGGER community_model_history_successor_delete
AFTER DELETE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_successor_insert;
CREATE TRIGGER community_model_history_successor_insert
AFTER INSERT ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_successor_update;
CREATE TRIGGER community_model_history_successor_update
AFTER UPDATE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_model_history_v1_delete;
CREATE TRIGGER community_model_history_v1_delete
AFTER DELETE ON telemetry_v1_chunks FOR EACH ROW WHEN OLD.superseded_at IS NULL
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id AND day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days');
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social')
    AND day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days');
END;

DROP TRIGGER IF EXISTS community_model_history_v1_insert;
CREATE TRIGGER community_model_history_v1_insert
AFTER INSERT ON telemetry_v1_chunks FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = NEW.participant_id AND day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days');
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social')
    AND day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days');
END;

DROP TRIGGER IF EXISTS community_model_history_v1_update;
CREATE TRIGGER community_model_history_v1_update
AFTER UPDATE ON telemetry_v1_chunks FOR EACH ROW
WHEN (OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL) AND (
  OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_id IS NOT NEW.device_id
  OR OLD.stream IS NOT NEW.stream OR OLD.chunk_day IS NOT NEW.chunk_day OR OLD.chunk_seq IS NOT NEW.chunk_seq
  OR OLD.revision IS NOT NEW.revision OR OLD.chunk_digest IS NOT NEW.chunk_digest
  OR OLD.parser_version IS NOT NEW.parser_version OR OLD.record_count IS NOT NEW.record_count
  OR OLD.accepted_record_count IS NOT NEW.accepted_record_count OR OLD.created_at IS NOT NEW.created_at
  OR OLD.superseded_at IS NOT NEW.superseded_at
  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id
)
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE (participant_id = OLD.participant_id AND day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days'))
      OR (participant_id = NEW.participant_id AND day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days'));
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social')
    AND (day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days')
      OR day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days'));
END;

DROP TRIGGER IF EXISTS community_model_history_work_parts_immutable;
CREATE TRIGGER community_model_history_work_parts_immutable
BEFORE UPDATE ON community_model_history_work_parts
BEGIN
  SELECT RAISE(ABORT, 'community analysis part immutable');
END;

DROP TRIGGER IF EXISTS community_preparation_progress_delete;
CREATE TRIGGER community_preparation_progress_delete AFTER DELETE ON community_prepared_source_days
WHEN EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social')
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

DROP TRIGGER IF EXISTS community_preparation_progress_insert;
CREATE TRIGGER community_preparation_progress_insert AFTER INSERT ON community_prepared_source_days
WHEN EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social')
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

DROP TRIGGER IF EXISTS community_preparation_progress_update;
CREATE TRIGGER community_preparation_progress_update AFTER UPDATE ON community_prepared_source_days
WHEN (OLD.phase IS NOT NEW.phase OR OLD.progress_revision IS NOT NEW.progress_revision
  OR OLD.quota_count IS NOT NEW.quota_count OR OLD.usage_count IS NOT NEW.usage_count
) AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social')
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

DROP TRIGGER IF EXISTS community_prepared_source_record_delete;
CREATE TRIGGER community_prepared_source_record_delete AFTER DELETE ON telemetry_v1_records
BEGIN
  UPDATE community_prepared_source_days SET phase='discarding', progress_revision=progress_revision+1
  WHERE participant_id=OLD.participant_id AND source_day=OLD.observed_day AND phase!='discarding';
END;

DROP TRIGGER IF EXISTS community_prepared_source_record_update;
CREATE TRIGGER community_prepared_source_record_update AFTER UPDATE ON telemetry_v1_records
BEGIN
  UPDATE community_prepared_source_days SET phase='discarding', progress_revision=progress_revision+1
  WHERE ((participant_id=OLD.participant_id AND source_day=OLD.observed_day)
    OR (participant_id=NEW.participant_id AND source_day=NEW.observed_day)) AND phase!='discarding';
END;

DROP TRIGGER IF EXISTS community_publication_fit_delete;
CREATE TRIGGER community_publication_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_publication_fit_insert;
CREATE TRIGGER community_publication_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_publication_fit_update;
CREATE TRIGGER community_publication_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_publication_generation_published;
CREATE TRIGGER community_publication_generation_published AFTER UPDATE OF published ON community_publication_generation
WHEN OLD.published = 0 AND NEW.published = 1
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE lane='daily' AND state='complete';
END;

DROP TRIGGER IF EXISTS community_publication_model_delete;
CREATE TRIGGER community_publication_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_publication_model_insert;
CREATE TRIGGER community_publication_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_publication_model_update;
CREATE TRIGGER community_publication_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN UPDATE community_publication_changes SET revision = revision + 1 WHERE singleton = 1 AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social'); END;

DROP TRIGGER IF EXISTS community_refresh_fit_delete;
CREATE TRIGGER community_refresh_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_refresh_fit_insert;
CREATE TRIGGER community_refresh_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_refresh_fit_update;
CREATE TRIGGER community_refresh_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_refresh_model_delete;
CREATE TRIGGER community_refresh_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=OLD.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_refresh_model_insert;
CREATE TRIGGER community_refresh_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE p.id=NEW.participant_id AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS community_refresh_model_update;
CREATE TRIGGER community_refresh_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete' AND EXISTS (SELECT 1 FROM participants p WHERE (p.id=OLD.participant_id OR p.id=NEW.participant_id) AND p.owner_kind='social');
END;

DROP TRIGGER IF EXISTS telemetry_v1_quota_fit_rows_delete;
CREATE TRIGGER telemetry_v1_quota_fit_rows_delete
AFTER DELETE ON telemetry_v1_records
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
END;

DROP TRIGGER IF EXISTS telemetry_v1_quota_fit_rows_insert;
CREATE TRIGGER telemetry_v1_quota_fit_rows_insert
AFTER INSERT ON telemetry_v1_records
WHEN NEW.stream = 'quota' AND NEW.limit_id = 'codex'
  AND NEW.window_duration_minutes = 10080
  AND NEW.provider IS NOT NULL AND NEW.plan_type IS NOT NULL
  AND NEW.plan_variant IS NOT NULL AND NEW.resets_at IS NOT NULL
  AND NEW.slot IS NOT NULL AND NEW.used_percent IS NOT NULL
BEGIN
  INSERT INTO telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  VALUES (NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at);
END;

DROP TRIGGER IF EXISTS telemetry_v1_quota_fit_rows_update;
CREATE TRIGGER telemetry_v1_quota_fit_rows_update
AFTER UPDATE OF id, participant_id, stream, limit_id, window_duration_minutes,
  provider, plan_type, plan_variant, resets_at, slot, used_percent, observed_at
ON telemetry_v1_records
BEGIN
  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;
  INSERT INTO telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  SELECT NEW.id, NEW.participant_id, NEW.resets_at, NEW.observed_at
  WHERE NEW.stream = 'quota' AND NEW.limit_id = 'codex'
    AND NEW.window_duration_minutes = 10080
    AND NEW.provider IS NOT NULL AND NEW.plan_type IS NOT NULL
    AND NEW.plan_variant IS NOT NULL AND NEW.resets_at IS NOT NULL
    AND NEW.slot IS NOT NULL AND NEW.used_percent IS NOT NULL;
END;
