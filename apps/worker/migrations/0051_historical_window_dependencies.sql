PRAGMA foreign_keys = ON;

-- A lazy, bounded watch per account/closed calculation window. Upload revisions
-- still fence transactions; unrelated days no longer invalidate this window's
-- completed result or its resumable acquisition. No source records are scanned.
CREATE TABLE community_model_history_dependencies (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  from_day TEXT NOT NULL CHECK (from_day = date(day, '-100 days')),
  dependency_revision INTEGER NOT NULL DEFAULT 0
    CHECK (dependency_revision >= 0 AND dependency_revision < 9007199254740991),
  input_fingerprint TEXT CHECK (input_fingerprint IS NULL OR
    (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*')),
  verified_input_revision INTEGER CHECK (verified_input_revision IS NULL OR
    (verified_input_revision >= 0 AND verified_input_revision < 9007199254740991)),
  PRIMARY KEY (participant_id, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX community_model_history_dependencies_day
  ON community_model_history_dependencies(day, participant_id);

-- NULL is an old publication: it must pass its original participant revision
-- check, or the exact-vector legacy digest bridge, before dependency reuse.
ALTER TABLE community_model_history_results ADD COLUMN dependency_revision INTEGER
  CHECK (dependency_revision IS NULL OR (dependency_revision >= 0 AND dependency_revision < 9007199254740991));

DROP TRIGGER community_model_history_v1_insert;
CREATE TRIGGER community_model_history_v1_insert
AFTER INSERT ON telemetry_v1_chunks FOR EACH ROW WHEN NEW.superseded_at IS NULL
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = NEW.participant_id AND day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days');
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL
    AND day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days');
END;

DROP TRIGGER community_model_history_v1_update;
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
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL
    AND (day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days')
      OR day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days'));
END;

DROP TRIGGER community_model_history_v1_delete;
CREATE TRIGGER community_model_history_v1_delete
AFTER DELETE ON telemetry_v1_chunks FOR EACH ROW WHEN OLD.superseded_at IS NULL
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id AND day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days');
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL
    AND day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days');
END;

-- Legacy authority and a complete successor generation can change the evidence
-- admitted to every window. Never reuse an old window across those transitions.
-- Storage-envelope rotation and quarantine receipts are not analytical edits.
DROP TRIGGER community_analytical_input_legacy_update;
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
  UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1;
END;
DROP TRIGGER community_model_history_legacy_update;
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
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL;
END;
CREATE TRIGGER community_model_history_dependency_legacy_insert
AFTER INSERT ON telemetry_contributions FOR EACH ROW WHEN NEW.status = 'accepted'
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = NEW.participant_id;
END;
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
CREATE TRIGGER community_model_history_dependency_legacy_delete
AFTER DELETE ON telemetry_contributions FOR EACH ROW WHEN OLD.status = 'accepted'
BEGIN
  UPDATE community_model_history_dependencies
     SET dependency_revision = dependency_revision + 1, input_fingerprint = NULL, verified_input_revision = NULL
   WHERE participant_id = OLD.participant_id;
END;
CREATE TRIGGER community_model_history_dependency_successor_insert
AFTER INSERT ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = NEW.participant_id;
END;
CREATE TRIGGER community_model_history_dependency_successor_update
AFTER UPDATE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = OLD.participant_id OR participant_id = NEW.participant_id;
END;
CREATE TRIGGER community_model_history_dependency_successor_delete
AFTER DELETE ON telemetry_v11_domain_heads FOR EACH ROW
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = OLD.participant_id;
END;
CREATE TRIGGER community_model_history_dependency_participant_state
AFTER UPDATE OF state ON participants FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  DELETE FROM community_model_history_dependencies WHERE participant_id = NEW.id;
END;
