-- The source is already shard-locally fenced before this journal is opened.
-- Each transition owns one exact manifest/chunk or domain generation so an
-- interrupted cross-D1 call can be reconciled from destination state without
-- reopening the source or inventing a new identity.
CREATE TABLE storage_owner_move_history_imports (
 move_id TEXT PRIMARY KEY NOT NULL CHECK(length(move_id) BETWEEN 1 AND 128),
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 participant_id TEXT NOT NULL CHECK(length(participant_id) BETWEEN 1 AND 256),
 source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
 state TEXT NOT NULL CHECK(state IN('manifests','domains','complete')),
 manifest_after_created_at TEXT,
 manifest_after_id TEXT,
 current_manifest_id TEXT,
 chunk_after_created_at TEXT,
 chunk_after_id TEXT,
 current_chunk_id TEXT,
 chunk_phase TEXT CHECK(chunk_phase IS NULL OR chunk_phase IN('raw','typed')),
 last_domain_id TEXT,
 current_domain_id TEXT,
 domain_after_day TEXT,
 domain_count INTEGER NOT NULL DEFAULT 0 CHECK(domain_count>=0),
 source_head_generation_id TEXT,
 source_head_revision INTEGER CHECK(source_head_revision IS NULL OR source_head_revision>=1),
 source_head_updated_at TEXT,
 completed_digest TEXT CHECK(completed_digest IS NULL OR
  (length(completed_digest)=64 AND completed_digest NOT GLOB '*[^0-9a-f]*')),
 updated_at TEXT NOT NULL,
 CHECK((source_head_generation_id IS NULL)=(source_head_revision IS NULL)),
 CHECK((source_head_generation_id IS NULL)=(source_head_updated_at IS NULL)),
 CHECK((current_chunk_id IS NULL)=(chunk_phase IS NULL)),
 CHECK(state<>'complete' OR (current_manifest_id IS NULL AND current_chunk_id IS NULL
  AND current_domain_id IS NULL AND completed_digest IS NOT NULL))
) STRICT;
CREATE INDEX storage_owner_move_history_owner
 ON storage_owner_move_history_imports(owner_id,state);
CREATE TRIGGER storage_owner_move_history_identity BEFORE UPDATE ON storage_owner_move_history_imports
WHEN NEW.move_id<>OLD.move_id OR NEW.owner_id<>OLD.owner_id
 OR NEW.participant_id<>OLD.participant_id OR NEW.source_namespace<>OLD.source_namespace
 OR OLD.state='complete'
BEGIN SELECT RAISE(ABORT,'STORAGE_MOVE_HISTORY_CONFLICT'); END;

CREATE TABLE storage_owner_move_history_contract (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL CHECK(version=1)
) STRICT;
INSERT INTO storage_owner_move_history_contract(id,version) VALUES(1,1);

-- Once a source is fenced, its exact authority snapshot may expire while a
-- bounded history import is still progressing. The move journal is the only
-- alternate admission path; ordinary manifests and predecessors retain every
-- existing live-credential check.
DROP TRIGGER telemetry_v11_manifest_admission;
CREATE TRIGGER telemetry_v11_manifest_admission BEFORE INSERT ON telemetry_v11_day_manifests
BEGIN
 SELECT (CASE WHEN NOT EXISTS (
  SELECT 1 FROM storage_owner_move_history_imports move
  WHERE move.participant_id=NEW.participant_id AND move.state='manifests'
   AND move.current_manifest_id=NEW.id
 ) AND NOT EXISTS (
  SELECT 1 FROM device_credentials d JOIN participants p ON p.id=d.participant_id
  JOIN telemetry_transport_participant_floors f ON f.participant_id=p.id
  JOIN telemetry_transport_formats t ON t.schema_version='telemetry-contribution-v1.1'
  WHERE p.id=NEW.participant_id AND d.id=NEW.device_id AND d.state='active'
   AND d.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.state='active'
   AND t.lifecycle='accepted' AND t.format_rank>=f.minimum_rank
   AND ((p.owner_kind='social' AND d.authority_kind='social' AND EXISTS(
      SELECT 1 FROM telemetry_v11_device_consents c WHERE c.participant_id=p.id AND c.device_id=d.id))
    OR (p.owner_kind='accountless' AND d.authority_kind='accountless' AND EXISTS(
      SELECT 1 FROM accountless_enrollment_ledger ledger
      JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
      JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
      WHERE ledger.device_id=d.accountless_enrollment_device_id AND ledger.state='active'
       AND ledger.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ledger.expires_at=d.expires_at
       AND owner.participant_id=p.id AND owner.device_credential_id=d.id AND owner.state='active'
       AND owner.expires_at=ledger.expires_at AND grant_row.participant_id=p.id
       AND grant_row.device_credential_id=d.id AND grant_row.state='active'
       AND grant_row.expires_at=ledger.expires_at)))
   AND NOT EXISTS(SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id=NEW.participant_id AND legacy.status='accepted'
     AND legacy.transport_schema_version='telemetry-contribution-v0.2')
 ) THEN RAISE(ABORT,'telemetry_transport_blocked') END);
 SELECT (CASE WHEN NEW.expected_chunk_count!=json_array_length(NEW.manifest_json,'$.chunks')
  OR NEW.state!='staged' THEN RAISE(ABORT,'telemetry_manifest_invalid') END);
 SELECT (CASE WHEN (SELECT count(*) FROM (
  SELECT 1 FROM telemetry_v11_day_manifests WHERE participant_id=NEW.participant_id
   AND device_id=NEW.device_id AND created_at>=substr(NEW.created_at,1,10)||'T00:00:00.000Z' LIMIT 8192
 ))>=8192 THEN RAISE(ABORT,'telemetry_manifest_admission_exhausted') END);
END;

DROP TRIGGER telemetry_v11_predecessor_authority;
CREATE TRIGGER telemetry_v11_predecessor_authority BEFORE INSERT ON telemetry_v11_domain_predecessors
WHEN NOT EXISTS(
 SELECT 1 FROM storage_owner_move_history_imports move
 WHERE move.participant_id=NEW.participant_id AND move.state='domains' AND move.current_domain_id IS NOT NULL
) AND NOT EXISTS(
 SELECT 1 FROM device_credentials d JOIN participants p ON p.id=d.participant_id
 JOIN telemetry_transport_participant_floors f ON f.participant_id=p.id
 JOIN telemetry_transport_formats t ON t.schema_version='telemetry-contribution-v1.1'
 WHERE p.id=NEW.participant_id AND d.id=NEW.device_id AND p.state='active' AND d.state='active'
  AND d.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND t.lifecycle='accepted' AND t.format_rank>=f.minimum_rank
  AND ((p.owner_kind='social' AND d.authority_kind='social' AND EXISTS(
    SELECT 1 FROM telemetry_v11_device_consents c WHERE c.participant_id=p.id AND c.device_id=d.id))
   OR (p.owner_kind='accountless' AND d.authority_kind='accountless' AND EXISTS(
    SELECT 1 FROM accountless_enrollment_ledger ledger
    JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
    JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
    WHERE ledger.device_id=d.accountless_enrollment_device_id AND ledger.state='active'
     AND ledger.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ledger.expires_at=d.expires_at
     AND owner.participant_id=p.id AND owner.device_credential_id=d.id AND owner.state='active'
     AND owner.expires_at=ledger.expires_at AND grant_row.participant_id=p.id
     AND grant_row.device_credential_id=d.id AND grant_row.state='active'
     AND grant_row.expires_at=ledger.expires_at)))
)
BEGIN SELECT RAISE(ABORT,'telemetry_transport_blocked'); END;

DROP VIEW telemetry_v11_current_predecessors;
CREATE VIEW telemetry_v11_current_predecessors AS
SELECT x.* FROM telemetry_v11_domain_predecessors x
JOIN participants p ON p.id=x.participant_id AND p.state='active'
JOIN device_credentials c ON c.id=x.device_id AND c.participant_id=x.participant_id
 AND c.state='active' AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
JOIN telemetry_transport_participant_floors floor_row ON floor_row.participant_id=x.participant_id
 AND floor_row.minimum_rank<=11
JOIN telemetry_transport_formats format_row ON format_row.schema_version='telemetry-contribution-v1.1'
 AND format_row.lifecycle='accepted'
LEFT JOIN telemetry_v11_device_consents social_grant
 ON social_grant.participant_id=x.participant_id AND social_grant.device_id=x.device_id
LEFT JOIN accountless_enrollment_ledger ledger ON ledger.device_id=c.accountless_enrollment_device_id
LEFT JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
LEFT JOIN accountless_v11_device_authorizations accountless_grant
 ON accountless_grant.enrollment_device_id=ledger.device_id
JOIN community_analytical_input_versions v ON v.participant_id=x.participant_id AND v.revision=x.input_revision
LEFT JOIN telemetry_v11_domain_heads h ON h.participant_id=x.participant_id
WHERE x.consumed_at IS NULL AND x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND x.previous_generation_id IS h.generation_id
 AND ((p.owner_kind='social' AND c.authority_kind='social' AND social_grant.device_id IS NOT NULL)
  OR (p.owner_kind='accountless' AND c.authority_kind='accountless' AND ledger.state='active'
   AND ledger.expires_at=c.expires_at AND ledger.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND owner.participant_id=p.id AND owner.device_credential_id=c.id AND owner.state='active'
   AND owner.expires_at=ledger.expires_at AND accountless_grant.participant_id=p.id
   AND accountless_grant.device_credential_id=c.id AND accountless_grant.state='active'
   AND accountless_grant.expires_at=ledger.expires_at))
UNION
SELECT x.* FROM telemetry_v11_domain_predecessors x
JOIN storage_owner_move_history_imports move ON move.participant_id=x.participant_id
WHERE move.state='domains' AND move.current_domain_id IS NOT NULL AND x.consumed_at IS NULL;
-- Old consumed upload receipts can be years past their admission lease.  The
-- importer may attach an exact historical chunk only while its move-local
-- journal is open.  Every ordinary chunk still uses the existing admission
-- predicate below.
DROP TRIGGER telemetry_v11_chunk_admission;
CREATE TRIGGER telemetry_v11_chunk_admission BEFORE INSERT ON telemetry_v11_chunks
WHEN NOT EXISTS (
 SELECT 1 FROM storage_owner_move_history_imports move
 WHERE move.participant_id=NEW.participant_id AND move.owner_id IS NOT NULL
  AND move.state='manifests' AND move.current_manifest_id=NEW.manifest_id
  AND move.current_chunk_id=NEW.id AND move.chunk_phase='raw'
)
BEGIN
 SELECT (CASE WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v11_day_manifests m
   JOIN telemetry_transport_formats t ON t.schema_version='telemetry-contribution-v1.1'
   JOIN telemetry_transport_participant_floors f ON f.participant_id=m.participant_id
   JOIN participants p ON p.id=m.participant_id
   JOIN device_credentials d ON d.id=m.device_id AND d.participant_id=m.participant_id
   JOIN device_upload_authorizations a ON a.id=NEW.device_upload_authorization_id
   JOIN json_each(m.manifest_json,'$.chunks') expected
  WHERE m.id=NEW.manifest_id AND m.participant_id=NEW.participant_id
   AND m.device_id=NEW.device_id AND m.chunk_day=NEW.chunk_day
   AND m.parser_version=NEW.parser_version AND m.state='staged'
   AND d.state='active' AND d.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND p.state='active' AND t.lifecycle='accepted' AND t.format_rank>=f.minimum_rank
   AND ((p.owner_kind='social' AND d.authority_kind='social'
     AND EXISTS(SELECT 1 FROM telemetry_v11_device_consents c
      WHERE c.participant_id=p.id AND c.device_id=d.id))
    OR (p.owner_kind='accountless' AND d.authority_kind='accountless'
     AND EXISTS(SELECT 1 FROM accountless_enrollment_ledger ledger
      JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
      JOIN accountless_v11_device_authorizations grant_row ON grant_row.enrollment_device_id=ledger.device_id
      WHERE ledger.device_id=d.accountless_enrollment_device_id AND ledger.state='active'
       AND ledger.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ledger.expires_at=d.expires_at
       AND owner.participant_id=p.id AND owner.device_credential_id=d.id AND owner.state='active'
       AND owner.expires_at=ledger.expires_at AND grant_row.participant_id=p.id
       AND grant_row.device_credential_id=d.id AND grant_row.state='active'
       AND grant_row.expires_at=ledger.expires_at)))
   AND NOT EXISTS(SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id=NEW.participant_id AND legacy.status='accepted'
     AND legacy.transport_schema_version='telemetry-contribution-v0.2')
   AND a.participant_id=NEW.participant_id AND a.issued_by_device_id=NEW.device_id
   AND a.state='consuming' AND a.envelope_digest=NEW.envelope_digest
   AND a.consume_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND json_extract(expected.value,'$.chunkId')=NEW.chunk_id
   AND json_extract(expected.value,'$.chunkDigest')=NEW.chunk_digest
   AND json_extract(expected.value,'$.recordCount')=NEW.record_count
 ) THEN RAISE(ABORT,'telemetry_chunk_staging_denied') END);
END;

-- A historical predecessor may be long expired. It is admitted with a
-- temporary future expiry so the ordinary domain closure and head triggers do
-- all semantic validation and publication work, then restored to its exact
-- source expiry while this exact generation is journal-owned.
DROP TRIGGER telemetry_v11_predecessor_immutable;
CREATE TRIGGER telemetry_v11_predecessor_immutable
BEFORE UPDATE ON telemetry_v11_domain_predecessors
WHEN (NEW.token_hash IS NOT OLD.token_hash OR NEW.participant_id IS NOT OLD.participant_id
 OR NEW.device_id IS NOT OLD.device_id OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
 OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision
 OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day
 OR NEW.winners_json IS NOT OLD.winners_json OR NEW.created_at IS NOT OLD.created_at
 OR NEW.expires_at IS NOT OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL)
AND NOT EXISTS(
 SELECT 1 FROM storage_owner_move_history_imports move
 JOIN telemetry_v11_domains domain ON domain.id=move.current_domain_id
 WHERE move.participant_id=OLD.participant_id AND domain.predecessor_token_hash=OLD.token_hash
  AND move.state='domains' AND NEW.token_hash=OLD.token_hash AND NEW.participant_id=OLD.participant_id
  AND NEW.device_id=OLD.device_id AND NEW.previous_generation_id IS OLD.previous_generation_id
  AND NEW.legacy_fingerprint=OLD.legacy_fingerprint AND NEW.input_revision=OLD.input_revision
  AND NEW.from_day=OLD.from_day AND NEW.through_day=OLD.through_day
  AND NEW.winners_json=OLD.winners_json AND NEW.created_at=OLD.created_at
  AND NEW.consumed_at IS OLD.consumed_at
)
BEGIN SELECT RAISE(ABORT,'telemetry_domain_immutable'); END;

DROP TRIGGER typed_v11_allocation_guard;
CREATE TRIGGER typed_v11_allocation_guard BEFORE INSERT ON typed_v11_chunk_allocations
BEGIN
 SELECT (CASE WHEN NOT EXISTS(
  SELECT 1 FROM typed_v11_admission_state s JOIN telemetry_v11_chunks c ON c.id=NEW.chunk_id
  WHERE s.namespace_id=NEW.namespace_id AND s.next_source_row_id=NEW.first_source_row_id
   AND c.record_count=NEW.record_count
 ) AND NOT EXISTS(
  SELECT 1 FROM storage_owner_move_history_imports move
  JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=NEW.namespace_id
  JOIN telemetry_v11_chunks c ON c.id=NEW.chunk_id AND c.participant_id=move.participant_id
  WHERE move.current_chunk_id=NEW.chunk_id AND move.chunk_phase='typed' AND move.state='manifests'
   AND origin.source_namespace=move.source_namespace AND origin.access_mode='retained-read'
   AND origin.registered_move_id=move.move_id AND origin.v11_read_contract_version=2
   AND c.record_count=NEW.record_count
 ) THEN RAISE(ABORT,'typed_v11_allocator_race') END);
END;
DROP TRIGGER typed_v11_allocation_advance;
CREATE TRIGGER typed_v11_allocation_advance AFTER INSERT ON typed_v11_chunk_allocations
BEGIN
 UPDATE typed_v11_admission_state SET next_source_row_id=NEW.first_source_row_id+NEW.record_count
  WHERE id=1 AND namespace_id=NEW.namespace_id AND next_source_row_id=NEW.first_source_row_id;
 SELECT (CASE WHEN changes()!=1 AND NOT EXISTS(
  SELECT 1 FROM storage_owner_move_history_imports move
  JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=NEW.namespace_id
  WHERE move.current_chunk_id=NEW.chunk_id AND move.chunk_phase='typed' AND move.state='manifests'
   AND origin.source_namespace=move.source_namespace AND origin.access_mode='retained-read'
   AND origin.registered_move_id=move.move_id AND origin.v11_read_contract_version=2
 ) THEN RAISE(ABORT,'typed_v11_allocator_race') END);
END;

DROP TRIGGER typed_v11_legacy_record_refusal;
CREATE TRIGGER typed_v11_legacy_record_refusal BEFORE INSERT ON telemetry_v11_records
WHEN EXISTS(SELECT 1 FROM typed_v11_admission_state) AND NOT EXISTS(
 SELECT 1 FROM storage_owner_move_history_imports move
 WHERE move.current_chunk_id=NEW.chunk_id AND move.current_manifest_id=NEW.manifest_id
  AND move.state='manifests' AND move.chunk_phase='raw'
)
BEGIN SELECT RAISE(ABORT,'typed_v11_json_write_disabled'); END;
