-- Optional typed HTTP admission contract. This does not select a deployment
-- mode or initialize retained data. The local initializer writes version 1 only
-- after the complete migration chain and its required authority objects exist.
-- Exact ordered SQL hashes remain the deployment/rehearsal owner's receipt.
ALTER TABLE typed_v11_admission_state ADD COLUMN runtime_contract_version INTEGER NOT NULL DEFAULT 0
  CHECK (runtime_contract_version IN (0,1));
CREATE TRIGGER typed_v11_runtime_initial_version BEFORE INSERT ON typed_v11_admission_state
WHEN NEW.runtime_contract_version != 0
BEGIN SELECT RAISE(ABORT,'typed_v11_runtime_contract_unqualified'); END;
CREATE TRIGGER typed_v11_runtime_contract_qualify BEFORE UPDATE OF runtime_contract_version ON typed_v11_admission_state
WHEN OLD.runtime_contract_version IS NOT NEW.runtime_contract_version
BEGIN
  SELECT CASE WHEN OLD.runtime_contract_version != 0 OR NEW.runtime_contract_version != 1
    OR NOT EXISTS (SELECT 1 FROM typed_telemetry_schema WHERE id=1 AND version=1)
    OR NOT EXISTS (SELECT 1 FROM storage_source_state WHERE singleton=1)
    OR EXISTS (SELECT 1 FROM telemetry_v11_records LIMIT 1)
    OR (SELECT count(*) FROM d1_migrations WHERE name IN (
      '0001_typed_telemetry.sql','0002_delivery_journal.sql','0004_read_compatibility.sql',
      '0001_v11_delivery_bridge.sql','0001_typed_chunk_admission.sql','0002_legacy_preservation_proofs.sql',
      '0003_typed_domain_closure.sql','0004_runtime_storage_contract.sql','0005_typed_active_reader.sql')) != 9
    OR (SELECT count(*) FROM sqlite_schema WHERE (type,name) IN (
      ('table','storage_v11_event_sources'),('table','storage_v11_owner_links'),
      ('table','typed_v11_record_admissions'),('table','typed_v1_preservation_proofs'),
      ('view','typed_telemetry_compatibility_records'),
      ('trigger','storage_v11_head_insert'),('trigger','storage_v11_head_update'),
      ('trigger','storage_v11_participant_erasure'),('trigger','storage_v11_chunks_retained'),
      ('trigger','telemetry_v11_domain_complete_before_insert'),('trigger','telemetry_v11_manifest_ready'),
      ('trigger','typed_v11_record_membership'),('trigger','typed_v11_allocation_guard'),
      ('trigger','typed_v11_active_proof_delete_guard'),('trigger','typed_v11_retained_proof_delete_guard'),
      ('trigger','typed_v11_usage_delete_guard'),('trigger','typed_v11_quota_delete_guard'),
      ('trigger','typed_v11_session_tools_delete_guard'),('trigger','typed_v11_session_tools_insert_guard'),
      ('trigger','typed_v11_record_time_guard'),('view','typed_v11_active_records'),('index','typed_v11_manifest_observed')
    )) != 22
    THEN RAISE(ABORT,'typed_v11_runtime_contract_unqualified') END;
END;
