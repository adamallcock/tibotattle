-- OPTIONAL fresh v1 target, after baseline0060 + typed0001--0004 + bridge0001.
-- Original headers/admission triggers remain. Their legacy analytics side effects
-- are NOT removed by this adapter; final role isolation is a separate gate.
CREATE TABLE typed_v1_admission_state (
 id INTEGER PRIMARY KEY CHECK(id=1), source_namespace TEXT NOT NULL UNIQUE,
 namespace_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_namespaces(id),
 runtime_contract_version INTEGER NOT NULL DEFAULT 0 CHECK(runtime_contract_version IN (0,1)),
 next_source_row_id INTEGER NOT NULL CHECK(next_source_row_id BETWEEN 1 AND 9007199254740991)
) STRICT;
-- Same-transaction request pin separates legacy envelope replay identity from
-- the SHA256 of actual HTTP bytes consumed by the upload capability.
CREATE TABLE typed_v1_authority_requests (
 chunk_id TEXT PRIMARY KEY,participant_id TEXT NOT NULL,device_id TEXT NOT NULL,
 authorization_id TEXT NOT NULL,authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64),
 envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64)
) STRICT;
CREATE TRIGGER typed_v1_request_immutable BEFORE UPDATE ON typed_v1_authority_requests
BEGIN SELECT RAISE(ABORT,'typed_v1_immutable'); END;
CREATE TABLE typed_v1_chunk_allocations (
 chunk_id TEXT PRIMARY KEY REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
 namespace_id INTEGER NOT NULL REFERENCES typed_telemetry_namespaces(id), chunk_original BLOB NOT NULL,
 first_source_row_id INTEGER NOT NULL CHECK(first_source_row_id>=1),
 record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 200),
 CHECK(first_source_row_id+record_count<=9007199254740991), UNIQUE(namespace_id,first_source_row_id), UNIQUE(namespace_id,chunk_original)
) STRICT;
CREATE TABLE typed_v1_owner_memberships (
 participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
 typed_owner_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_owners(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE typed_v1_record_admissions (
 typed_record_id INTEGER PRIMARY KEY REFERENCES typed_telemetry_records(id) ON DELETE CASCADE,
 chunk_id TEXT NOT NULL REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX typed_v1_admissions_chunk ON typed_v1_record_admissions(chunk_id,typed_record_id);
CREATE TABLE typed_v1_event_sources (
 event_digest TEXT PRIMARY KEY CHECK(length(event_digest)=64),
 owner_digest TEXT NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 chunk_id TEXT NOT NULL UNIQUE REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
 source_namespace TEXT NOT NULL
) STRICT;
CREATE INDEX typed_v1_events_owner ON typed_v1_event_sources(participant_id,chunk_id);
CREATE TRIGGER typed_v1_initialize_empty BEFORE INSERT ON typed_v1_admission_state
WHEN NOT EXISTS(SELECT 1 FROM typed_v1_admission_state)
BEGIN
 SELECT CASE WHEN NEW.runtime_contract_version!=0 OR NEW.next_source_row_id!=1 OR EXISTS(SELECT 1 FROM telemetry_v1_chunks)
 OR EXISTS(SELECT 1 FROM telemetry_v1_records) OR EXISTS(SELECT 1 FROM typed_telemetry_records WHERE format=10)
 THEN RAISE(ABORT,'typed_v1_unqualified_history') END;
END;
CREATE TRIGGER typed_v1_state_guard BEFORE UPDATE ON typed_v1_admission_state
WHEN NEW.id IS NOT OLD.id OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.namespace_id IS NOT OLD.namespace_id
 OR (NEW.runtime_contract_version IS NOT OLD.runtime_contract_version AND NOT(OLD.runtime_contract_version=0 AND NEW.runtime_contract_version=1
 AND EXISTS(SELECT 1 FROM storage_source_state WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM typed_telemetry_schema WHERE id=1 AND version=1)
 AND 4=(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN
 ('typed_v1_header_authority','typed_v1_event_publish','typed_v1_supersession_guard','typed_v1_v11_transition_unqualified'))))
 OR (NEW.next_source_row_id IS NOT OLD.next_source_row_id AND (NEW.next_source_row_id<=OLD.next_source_row_id OR NOT EXISTS(
 SELECT 1 FROM typed_v1_chunk_allocations WHERE namespace_id=OLD.namespace_id AND first_source_row_id=OLD.next_source_row_id
 AND first_source_row_id+record_count=NEW.next_source_row_id)))
BEGIN SELECT RAISE(ABORT,'typed_v1_allocator_conflict'); END;
CREATE TRIGGER typed_v1_state_retained BEFORE DELETE ON typed_v1_admission_state
BEGIN SELECT RAISE(ABORT,'typed_v1_state_retained'); END;
CREATE TRIGGER typed_v1_allocation_guard BEFORE INSERT ON typed_v1_chunk_allocations
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_v1_admission_state s JOIN telemetry_v1_chunks c ON c.id=NEW.chunk_id
 WHERE s.namespace_id=NEW.namespace_id AND s.next_source_row_id=NEW.first_source_row_id AND c.record_count=NEW.record_count
 AND c.superseded_at IS NULL) THEN RAISE(ABORT,'typed_v1_allocator_conflict') END; END;
CREATE TRIGGER typed_v1_allocation_advance AFTER INSERT ON typed_v1_chunk_allocations
BEGIN UPDATE typed_v1_admission_state SET next_source_row_id=NEW.first_source_row_id+NEW.record_count
 WHERE id=1 AND namespace_id=NEW.namespace_id AND next_source_row_id=NEW.first_source_row_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'typed_v1_allocator_conflict') END; END;
CREATE TRIGGER typed_v1_allocation_immutable BEFORE UPDATE ON typed_v1_chunk_allocations
BEGIN SELECT RAISE(ABORT,'typed_v1_immutable'); END;
CREATE TRIGGER typed_v1_no_json BEFORE INSERT ON telemetry_v1_records
WHEN EXISTS(SELECT 1 FROM typed_v1_admission_state)
BEGIN SELECT RAISE(ABORT,'typed_v1_json_write_disabled'); END;
CREATE TRIGGER typed_v1_allocated_row BEFORE INSERT ON typed_telemetry_records
WHEN NEW.format=10 AND EXISTS(SELECT 1 FROM typed_v1_admission_state)
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_v1_chunk_allocations a JOIN typed_telemetry_chunks c ON c.id=NEW.chunk_id
 WHERE a.namespace_id=NEW.namespace_id AND c.namespace_id=a.namespace_id AND c.original_id=a.chunk_original
 AND NEW.source_row_id>=a.first_source_row_id AND NEW.source_row_id<a.first_source_row_id+a.record_count)
 THEN RAISE(ABORT,'typed_v1_unallocated_record') END; END;
CREATE TRIGGER typed_v1_record_membership BEFORE INSERT ON typed_v1_record_admissions
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_telemetry_compatibility_records r
 JOIN typed_v1_chunk_allocations a ON a.chunk_id=NEW.chunk_id AND a.namespace_id=r.namespace_id
 JOIN typed_v1_admission_state s ON s.namespace_id=r.namespace_id AND s.source_namespace=r.source_namespace
 JOIN telemetry_v1_chunks c ON c.id=a.chunk_id
 WHERE r.storage_row_id=NEW.typed_record_id AND r.format_code=10 AND r.chunk_row_id=c.id
 AND r.participant_id=c.participant_id AND r.device_id=c.device_id AND r.stream=c.stream
 AND r.observed_day=c.chunk_day AND r.chunk_day=c.chunk_day AND substr(r.observed_at,1,10)=c.chunk_day
 AND r.source_row_id>=a.first_source_row_id AND r.source_row_id<a.first_source_row_id+a.record_count
 AND c.superseded_at IS NULL AND (SELECT count(*) FROM typed_v1_record_admissions WHERE chunk_id=c.id)<c.record_count)
 THEN RAISE(ABORT,'typed_v1_record_membership_conflict') END; END;
CREATE TRIGGER typed_v1_record_immutable BEFORE UPDATE ON typed_v1_record_admissions
BEGIN SELECT RAISE(ABORT,'typed_v1_immutable'); END;
CREATE TRIGGER typed_v1_current_record_retained BEFORE DELETE ON typed_v1_record_admissions
WHEN EXISTS(SELECT 1 FROM telemetry_v1_chunks c JOIN participants p ON p.id=c.participant_id
 WHERE c.id=OLD.chunk_id AND c.superseded_at IS NULL AND p.state='active')
BEGIN SELECT RAISE(ABORT,'typed_v1_current_record_retained'); END;
CREATE TRIGGER typed_v1_chunk_delete BEFORE DELETE ON telemetry_v1_chunks
BEGIN DELETE FROM typed_telemetry_chunks WHERE format=10 AND namespace_id=(SELECT namespace_id FROM typed_v1_admission_state)
 AND original_id=(SELECT chunk_original FROM typed_v1_chunk_allocations WHERE chunk_id=OLD.id); END;
CREATE TRIGGER typed_v1_owner_membership_guard BEFORE INSERT ON typed_v1_owner_memberships
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_telemetry_compatibility_records r JOIN typed_v1_admission_state s ON s.namespace_id=r.namespace_id
 WHERE r.owner_id=NEW.typed_owner_id AND r.participant_id=NEW.participant_id AND r.format_code=10)
 THEN RAISE(ABORT,'typed_v1_owner_mismatch') END; END;
CREATE TRIGGER typed_v1_owner_membership_immutable BEFORE UPDATE ON typed_v1_owner_memberships
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.typed_owner_id IS NOT NEW.typed_owner_id
BEGIN SELECT RAISE(ABORT,'typed_v1_owner_mismatch'); END;
CREATE TRIGGER typed_v1_owner_membership_retained BEFORE DELETE ON typed_v1_owner_memberships
WHEN EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id)
BEGIN SELECT RAISE(ABORT,'typed_v1_owner_retained'); END;
CREATE TRIGGER typed_v1_owner_delete AFTER DELETE ON typed_v1_owner_memberships
BEGIN DELETE FROM typed_telemetry_owners WHERE id=OLD.typed_owner_id; END;
CREATE TRIGGER typed_v1_event_guard BEFORE INSERT ON typed_v1_event_sources
BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks c
 JOIN typed_v1_admission_state s ON s.source_namespace=NEW.source_namespace
 JOIN storage_v11_owner_links l ON l.participant_id=c.participant_id AND l.owner_digest=NEW.owner_digest AND l.state!='erased'
 WHERE c.id=NEW.chunk_id AND c.participant_id=NEW.participant_id AND c.superseded_at IS NULL
 AND c.accepted_record_count=c.record_count AND c.record_count=(SELECT count(*) FROM typed_v1_record_admissions WHERE chunk_id=c.id))
 THEN RAISE(ABORT,'typed_v1_source_incomplete') END; END;
CREATE TRIGGER typed_v1_event_publish AFTER INSERT ON typed_v1_event_sources
BEGIN
 INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms)
 VALUES(NEW.event_digest,NEW.owner_digest,COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
 'owner-active',NEW.event_digest,(SELECT chunk_digest FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),
 COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
 (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+1,CAST(strftime('%s','now') AS INTEGER)*1000);
 UPDATE storage_v11_owner_links SET state='active',object_digest=NEW.event_digest,
 manifest_digest=(SELECT chunk_digest FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) WHERE participant_id=NEW.participant_id;
END;
CREATE TRIGGER typed_v1_event_immutable BEFORE UPDATE ON typed_v1_event_sources
BEGIN SELECT RAISE(ABORT,'typed_v1_immutable'); END;
CREATE TRIGGER typed_v1_event_retained BEFORE DELETE ON typed_v1_event_sources
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'typed_v1_source_retained'); END;
-- The existing v11 predecessor/closure only understands raw v1. Do not silently
-- hide typed v1 history until that exact cross-layout preservation is qualified.
CREATE TRIGGER typed_v1_v11_transition_unqualified BEFORE INSERT ON telemetry_v11_domains
WHEN EXISTS(SELECT 1 FROM typed_v1_event_sources WHERE participant_id=NEW.participant_id)
BEGIN SELECT RAISE(ABORT,'telemetry_domain_compatibility_unproven'); END;
CREATE TRIGGER typed_v1_usage_delete_guard BEFORE DELETE ON typed_telemetry_usage
WHEN EXISTS(SELECT 1 FROM typed_telemetry_records r JOIN typed_v1_record_admissions p ON p.typed_record_id=r.id WHERE r.id=OLD.record_id)
BEGIN SELECT RAISE(ABORT,'typed_v1_current_record_retained'); END;
CREATE TRIGGER typed_v1_quota_delete_guard BEFORE DELETE ON typed_telemetry_quota
WHEN EXISTS(SELECT 1 FROM typed_telemetry_records r JOIN typed_v1_record_admissions p ON p.typed_record_id=r.id WHERE r.id=OLD.record_id)
BEGIN SELECT RAISE(ABORT,'typed_v1_current_record_retained'); END;
CREATE TRIGGER typed_v1_session_tools_delete_guard BEFORE DELETE ON typed_telemetry_session_tools
WHEN EXISTS(SELECT 1 FROM typed_telemetry_records r JOIN typed_v1_record_admissions p ON p.typed_record_id=r.id WHERE r.id=OLD.record_id)
BEGIN SELECT RAISE(ABORT,'typed_v1_current_record_retained'); END;
CREATE TRIGGER typed_v1_tools_sealed BEFORE INSERT ON typed_telemetry_session_tools
WHEN EXISTS(SELECT 1 FROM typed_v1_record_admissions WHERE typed_record_id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM typed_telemetry_session_tools WHERE record_id=NEW.record_id AND tool_class_id=NEW.tool_class_id AND count=NEW.count)
BEGIN SELECT RAISE(ABORT,'typed_v1_current_record_retained'); END;
-- A claimed upload is not authority after its device was revoked. The graph
-- preservation marker can be absent; it is never an admission substitute.
CREATE TRIGGER typed_v1_header_authority BEFORE INSERT ON telemetry_v1_chunks
WHEN EXISTS(SELECT 1 FROM typed_v1_admission_state)
BEGIN SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM participants p JOIN device_credentials d ON d.participant_id=p.id
 JOIN device_upload_authorizations a ON a.participant_id=p.id AND a.issued_by_device_id=d.id
 JOIN telemetry_v1_device_consents c ON c.participant_id=p.id AND c.device_id=d.id
 JOIN typed_v1_authority_requests request ON request.chunk_id=NEW.id AND request.participant_id=p.id AND request.device_id=d.id
  AND request.authorization_id=a.id AND request.envelope_digest=NEW.envelope_digest
 WHERE p.id=NEW.participant_id AND p.state='active' AND p.owner_kind='social'
 AND d.id=NEW.device_id AND d.state='active' AND d.revoked_at IS NULL AND d.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND a.id=NEW.device_upload_authorization_id AND a.state='consuming' AND a.envelope_digest=request.authorization_digest
 AND a.consume_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND c.telemetry_schema_version='telemetry-contribution-v1.0' AND c.field_dictionary_version='telemetry-v1.0-registry-2026-08-07.1'
 AND c.privacy_contract_version='ongoing-privacy-safe-telemetry-v1.0')
 THEN RAISE(ABORT,'upload unavailable') END; END;
-- The original scoped marker pins the exact prior slot/revision and live upload
-- before correction. If that prior changes during preparation, no rows retire.
CREATE TRIGGER typed_v1_supersession_guard BEFORE UPDATE OF superseded_at ON telemetry_v1_chunks
WHEN EXISTS(SELECT 1 FROM typed_v1_admission_state) AND OLD.superseded_at IS NOT NEW.superseded_at
BEGIN SELECT CASE WHEN OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR NOT EXISTS(
 SELECT 1 FROM community_graph_update_scope s WHERE s.old_chunk_id=OLD.id AND s.phase='supersede'
 AND s.participant_id=OLD.participant_id AND s.device_id=OLD.device_id AND s.stream=OLD.stream
 AND s.chunk_day=OLD.chunk_day AND s.chunk_seq=OLD.chunk_seq AND s.new_revision=OLD.revision+1
 AND s.created_at=NEW.superseded_at)
 THEN RAISE(ABORT,'typed_v1_supersession_conflict') END; END;
