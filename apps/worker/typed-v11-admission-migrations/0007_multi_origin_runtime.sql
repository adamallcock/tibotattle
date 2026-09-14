-- Forward namespace-aware read/deletion prerequisite. Copy authorization and
-- route activation remain absent. Existing unexplained v1.1 ownership or
-- origin state refuses this migration rather than being inferred.
PRAGMA legacy_alter_table=ON;
CREATE TABLE typed_v11_origin_upgrade_guard (n INTEGER CHECK(n=0));
INSERT INTO typed_v11_origin_upgrade_guard SELECT
 (SELECT count(*) FROM typed_v11_owner_memberships m
   LEFT JOIN typed_telemetry_owners o ON o.id=m.typed_owner_id
   LEFT JOIN typed_v11_admission_state s ON s.id=1
   WHERE o.id IS NULL OR o.namespace_id IS NOT s.namespace_id)
 +(SELECT count(*) FROM typed_telemetry_owners o
   JOIN typed_v11_admission_state s ON s.id=1
   WHERE o.namespace_id IS NOT s.namespace_id)
 +(SELECT count(*) FROM typed_v11_manifest_memberships m
   LEFT JOIN typed_telemetry_manifests manifest ON manifest.id=m.typed_manifest_id
   LEFT JOIN typed_v11_admission_state s ON s.id=1
   WHERE manifest.id IS NULL OR manifest.namespace_id IS NOT s.namespace_id)
 +(SELECT count(*) FROM typed_telemetry_records r WHERE r.format=11 AND (
   NOT EXISTS(SELECT 1 FROM typed_v11_owner_memberships m
    JOIN typed_telemetry_owners o ON o.id=m.typed_owner_id AND o.namespace_id=r.namespace_id
    JOIN typed_telemetry_compatibility_records c ON c.storage_row_id=r.id
    WHERE m.typed_owner_id=r.owner_id AND m.participant_id=c.participant_id)
   OR NOT EXISTS(SELECT 1 FROM typed_v11_manifest_memberships m
    JOIN typed_telemetry_manifests manifest ON manifest.id=m.typed_manifest_id
    WHERE manifest.id=r.manifest_id AND manifest.namespace_id=r.namespace_id)))
 +(SELECT count(*) FROM typed_telemetry_origin_contracts c
   WHERE EXISTS(SELECT 1 FROM typed_v11_admission_state s WHERE s.id=1)
    AND NOT EXISTS(SELECT 1 FROM typed_v11_admission_state s
      WHERE s.id=1 AND s.namespace_id=c.namespace_id AND s.source_namespace=c.source_namespace
       AND c.access_mode='current-write' AND c.registered_move_id IS NULL
       AND c.source_schema_digest='50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643'))
 +(SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_v11_admission_state WHERE id=1)
    AND (EXISTS(SELECT 1 FROM typed_v11_owner_memberships)
      OR EXISTS(SELECT 1 FROM typed_v11_manifest_memberships)
      OR EXISTS(SELECT 1 FROM typed_telemetry_records WHERE format=11)) THEN 1 ELSE 0 END);
DROP TABLE typed_v11_origin_upgrade_guard;

INSERT INTO typed_telemetry_origin_contracts(
 namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
 source_schema_digest,registered_move_id,registered_at)
SELECT s.namespace_id,n.original_id,'current-write',0,0,
 '50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643',NULL,
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM typed_v11_admission_state s JOIN typed_telemetry_namespaces n ON n.id=s.namespace_id
WHERE s.id=1 ON CONFLICT(namespace_id) DO NOTHING;

DROP VIEW IF EXISTS typed_v11_active_records;
DROP VIEW typed_v11_record_admissions;
DROP TRIGGER typed_v11_record_membership;
DROP TRIGGER typed_v11_active_proof_delete_guard;
DROP TRIGGER typed_v11_retained_proof_delete_guard;
DROP TRIGGER typed_v11_chunk_delete;

ALTER TABLE typed_v11_owner_memberships RENAME TO typed_v11_owner_memberships_single_origin;
CREATE TABLE typed_v11_owner_memberships (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 namespace_id INTEGER NOT NULL,
 typed_owner_id INTEGER NOT NULL,
 PRIMARY KEY(participant_id,namespace_id),
 UNIQUE(typed_owner_id),
 FOREIGN KEY(typed_owner_id,namespace_id)
   REFERENCES typed_telemetry_owners(id,namespace_id) ON DELETE CASCADE
) STRICT;
INSERT INTO typed_v11_owner_memberships(participant_id,namespace_id,typed_owner_id)
 SELECT old.participant_id,owner.namespace_id,old.typed_owner_id
 FROM typed_v11_owner_memberships_single_origin old
 JOIN typed_telemetry_owners owner ON owner.id=old.typed_owner_id;
DROP TABLE typed_v11_owner_memberships_single_origin;
CREATE INDEX typed_v11_memberships_participant
 ON typed_v11_owner_memberships(participant_id,namespace_id,typed_owner_id);

ALTER TABLE typed_v11_manifest_memberships RENAME TO typed_v11_manifest_memberships_single_origin;
CREATE TABLE typed_v11_manifest_memberships (
 manifest_id TEXT PRIMARY KEY REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
 namespace_id INTEGER NOT NULL REFERENCES typed_telemetry_namespaces(id),
 typed_manifest_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_manifests(id) ON DELETE CASCADE
) STRICT;
INSERT INTO typed_v11_manifest_memberships(manifest_id,namespace_id,typed_manifest_id)
 SELECT old.manifest_id,manifest.namespace_id,old.typed_manifest_id
 FROM typed_v11_manifest_memberships_single_origin old
 JOIN typed_telemetry_manifests manifest ON manifest.id=old.typed_manifest_id;
DROP TABLE typed_v11_manifest_memberships_single_origin;

CREATE TRIGGER typed_v11_owner_membership_guard BEFORE INSERT ON typed_v11_owner_memberships
BEGIN SELECT (CASE WHEN NOT EXISTS(
 SELECT 1 FROM typed_telemetry_owners candidate
 JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=candidate.namespace_id
 WHERE candidate.id=NEW.typed_owner_id AND candidate.namespace_id=NEW.namespace_id
  AND origin.v11_read_contract_version=2 AND (
   EXISTS(SELECT 1 FROM typed_telemetry_compatibility_records r
    WHERE r.owner_id=candidate.id AND r.namespace_id=candidate.namespace_id
     AND r.participant_id=NEW.participant_id AND r.format_code=11)
   OR EXISTS(SELECT 1 FROM typed_v11_owner_memberships existing
    JOIN typed_telemetry_owners existing_owner ON existing_owner.id=existing.typed_owner_id
    WHERE existing.participant_id=NEW.participant_id
     AND existing_owner.original_id=candidate.original_id))
) THEN RAISE(ABORT,'typed_v11_owner_membership_conflict') END); END;
CREATE TRIGGER typed_v11_owner_membership_immutable BEFORE UPDATE ON typed_v11_owner_memberships
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.namespace_id IS NOT NEW.namespace_id
 OR OLD.typed_owner_id IS NOT NEW.typed_owner_id
BEGIN SELECT RAISE(ABORT,'typed_v11_owner_membership_conflict'); END;
CREATE TRIGGER typed_v11_owner_membership_retained BEFORE DELETE ON typed_v11_owner_memberships
WHEN EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_owner_membership_retained'); END;
CREATE TRIGGER typed_v11_owner_delete AFTER DELETE ON typed_v11_owner_memberships
BEGIN DELETE FROM typed_telemetry_owners
 WHERE id=OLD.typed_owner_id AND namespace_id=OLD.namespace_id; END;

CREATE TRIGGER typed_v11_manifest_membership_guard BEFORE INSERT ON typed_v11_manifest_memberships
BEGIN SELECT (CASE WHEN NOT EXISTS(
 SELECT 1 FROM typed_telemetry_records raw
 JOIN typed_telemetry_manifests manifest ON manifest.id=raw.manifest_id
  AND manifest.namespace_id=raw.namespace_id
 JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=raw.id
 JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=raw.namespace_id
 WHERE raw.manifest_id=NEW.typed_manifest_id AND raw.namespace_id=NEW.namespace_id
  AND raw.format=11 AND r.manifest_id=NEW.manifest_id
  AND origin.v11_read_contract_version=2
) THEN RAISE(ABORT,'typed_v11_manifest_membership_conflict') END); END;
CREATE TRIGGER typed_v11_manifest_membership_immutable BEFORE UPDATE ON typed_v11_manifest_memberships
BEGIN SELECT RAISE(ABORT,'typed_v11_manifest_membership_conflict'); END;
CREATE TRIGGER typed_v11_manifest_membership_retained BEFORE DELETE ON typed_v11_manifest_memberships
WHEN EXISTS(SELECT 1 FROM typed_v11_record_proofs WHERE manifest_key=OLD.typed_manifest_id)
 AND EXISTS(SELECT 1 FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)
 AND EXISTS(SELECT 1 FROM typed_telemetry_manifests WHERE id=OLD.typed_manifest_id AND namespace_id=OLD.namespace_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_manifest_membership_retained'); END;

CREATE VIEW typed_v11_record_admissions AS
 SELECT p.typed_record_id,a.chunk_id,m.manifest_id,p.stream,p.occurrence_id,p.base_digest,
  p.legacy_occurrence_id,p.legacy_digest,p.observed_at_ms
 FROM typed_v11_record_proofs p
 JOIN typed_telemetry_chunks c ON c.id=p.chunk_key
 JOIN typed_v11_chunk_allocations a ON a.namespace_id=c.namespace_id AND a.chunk_original=c.original_id
 JOIN typed_v11_manifest_memberships m ON m.typed_manifest_id=p.manifest_key AND m.namespace_id=c.namespace_id;
CREATE TRIGGER typed_v11_record_compat_update INSTEAD OF UPDATE ON typed_v11_record_admissions
BEGIN SELECT RAISE(ABORT,'typed_v11_record_proof_immutable'); END;
CREATE TRIGGER typed_v11_record_compat_delete INSTEAD OF DELETE ON typed_v11_record_admissions
BEGIN DELETE FROM typed_v11_record_proofs WHERE typed_record_id=OLD.typed_record_id; END;

CREATE TRIGGER typed_v11_record_membership BEFORE INSERT ON typed_v11_record_proofs
BEGIN SELECT (CASE WHEN NOT EXISTS(
 SELECT 1 FROM typed_telemetry_records raw
 JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=raw.id
 JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=r.namespace_id
 JOIN typed_telemetry_chunks tc ON tc.id=raw.chunk_id
 JOIN typed_v11_chunk_allocations a ON a.namespace_id=r.namespace_id AND a.chunk_original=tc.original_id
 JOIN telemetry_v11_chunks c ON c.id=a.chunk_id
 JOIN telemetry_v11_day_manifests m ON m.id=c.manifest_id
 JOIN typed_v11_manifest_memberships mm ON mm.manifest_id=m.id
  AND mm.namespace_id=raw.namespace_id AND mm.typed_manifest_id=raw.manifest_id
 WHERE raw.id=NEW.typed_record_id AND raw.format=11 AND raw.chunk_id=NEW.chunk_key
  AND raw.manifest_id=NEW.manifest_key AND raw.stream=NEW.stream_code AND raw.occurrence_id=NEW.occurrence_blob
  AND (NEW.legacy_occurrence_blob IS NULL OR
   (NEW.stream_code IN(1,3) AND NEW.legacy_occurrence_blob=NEW.occurrence_blob) OR
   (NEW.stream_code=2 AND hex(substr(NEW.legacy_occurrence_blob,1,1))='00' AND NEW.legacy_occurrence_id GLOB 'q:*'))
  AND r.chunk_row_id=c.id AND r.manifest_id=c.manifest_id AND r.participant_id=c.participant_id AND r.device_id=c.device_id
  AND r.chunk_day=c.chunk_day AND r.observed_day=c.chunk_day AND substr(r.observed_at,1,10)=c.chunk_day
  AND raw.source_row_id>=a.first_source_row_id AND raw.source_row_id<a.first_source_row_id+a.record_count
  AND c.stream=NEW.stream AND r.stream=NEW.stream AND m.state='staged'
  AND origin.v11_read_contract_version=2
  AND EXISTS(SELECT 1 FROM typed_v11_owner_memberships owner
   WHERE owner.typed_owner_id=raw.owner_id AND owner.namespace_id=raw.namespace_id
    AND owner.participant_id=c.participant_id)
  AND (SELECT count(*) FROM typed_v11_record_proofs p WHERE p.chunk_key=raw.chunk_id)<c.record_count
) THEN RAISE(ABORT,'typed_v11_record_staging_denied') END); END;

CREATE TRIGGER typed_v11_active_proof_delete_guard BEFORE DELETE ON typed_v11_record_proofs
WHEN EXISTS(SELECT 1 FROM typed_v11_manifest_memberships membership
 JOIN telemetry_v11_domain_days d ON d.manifest_id=membership.manifest_id
 JOIN telemetry_v11_domain_heads h ON h.generation_id=d.generation_id
 JOIN participants participant ON participant.id=h.participant_id AND participant.state='active'
 WHERE membership.typed_manifest_id=OLD.manifest_key)
BEGIN SELECT RAISE(ABORT,'telemetry_domain_active'); END;
CREATE TRIGGER typed_v11_retained_proof_delete_guard BEFORE DELETE ON typed_v11_record_proofs
WHEN EXISTS(SELECT 1 FROM typed_v11_manifest_memberships membership
 JOIN telemetry_v11_domain_days d ON d.manifest_id=membership.manifest_id
 JOIN storage_v11_event_sources e ON e.generation_id=d.generation_id
 JOIN storage_owner_revisions o ON o.owner_digest=e.owner_digest
 WHERE membership.typed_manifest_id=OLD.manifest_key AND o.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;

CREATE TRIGGER typed_v11_chunk_delete BEFORE DELETE ON telemetry_v11_chunks
BEGIN DELETE FROM typed_telemetry_chunks WHERE format=11
 AND namespace_id=(SELECT namespace_id FROM typed_v11_chunk_allocations WHERE chunk_id=OLD.id)
 AND original_id=(SELECT chunk_original FROM typed_v11_chunk_allocations WHERE chunk_id=OLD.id); END;

CREATE VIEW typed_v11_active_records AS
SELECT r.storage_row_id,r.id,origin.source_namespace,h.participant_id,
 h.generation_id,g.device_id,p.chunk_id AS chunk_row_id,membership.manifest_id,
 d.observed_day,p.stream,p.occurrence_id,p.observed_at_ms,r.observed_at,r.provider,r.session_uuid,
 r.plan_type,r.plan_variant,r.limit_id,r.slot,r.used_percent,r.window_duration_minutes,r.resets_at,
 r.account_basis,r.account_track_id,r.plan_era_id,r.plan_basis
FROM telemetry_v11_domain_heads h
JOIN telemetry_v11_domains g ON g.id=h.generation_id
JOIN telemetry_v11_domain_days d ON d.generation_id=h.generation_id
JOIN typed_v11_manifest_memberships membership ON membership.manifest_id=d.manifest_id
JOIN typed_v11_record_admissions p ON p.manifest_id=membership.manifest_id
JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=p.typed_record_id
 AND r.namespace_id=membership.namespace_id
JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=r.namespace_id
 AND origin.v11_read_contract_version=2
JOIN typed_v11_owner_memberships owner ON owner.participant_id=h.participant_id
 AND owner.namespace_id=r.namespace_id AND owner.typed_owner_id=r.owner_id
WHERE r.format_code=11 AND r.participant_id=h.participant_id AND r.device_id=g.device_id
 AND r.manifest_id=membership.manifest_id;

DROP TRIGGER typed_v11_runtime_contract_qualify;
CREATE TRIGGER typed_v11_runtime_contract_qualify BEFORE UPDATE OF runtime_contract_version ON typed_v11_admission_state
WHEN OLD.runtime_contract_version IS NOT NEW.runtime_contract_version
BEGIN
 SELECT (CASE WHEN OLD.runtime_contract_version!=0 OR NEW.runtime_contract_version!=1
  OR NOT EXISTS(SELECT 1 FROM typed_telemetry_schema WHERE id=1 AND version=1)
  OR NOT EXISTS(SELECT 1 FROM storage_source_state WHERE singleton=1)
  OR EXISTS(SELECT 1 FROM telemetry_v11_records LIMIT 1)
 THEN RAISE(ABORT,'typed_v11_runtime_contract_unqualified') END);
 SELECT (CASE WHEN (SELECT count(*) FROM d1_migrations WHERE name IN (
   '0001_typed_telemetry.sql','0002_delivery_journal.sql','0004_read_compatibility.sql','0005_typed_origin_contracts.sql',
   '0001_v11_delivery_bridge.sql','0001_typed_chunk_admission.sql','0002_legacy_preservation_proofs.sql',
   '0003_typed_domain_closure.sql','0004_runtime_storage_contract.sql','0005_typed_active_reader.sql',
   '0006_compact_admission_proofs.sql','0007_multi_origin_runtime.sql'))!=12
 THEN RAISE(ABORT,'typed_v11_runtime_contract_unqualified') END);
 SELECT (CASE WHEN (SELECT count(*) FROM sqlite_schema WHERE name IN (
   'typed_telemetry_origin_contracts','typed_telemetry_one_current_origin',
   'typed_v11_owner_memberships','typed_v11_memberships_participant',
   'typed_v11_manifest_memberships','typed_v11_record_admissions',
   'typed_v11_active_records','typed_v11_record_membership',
   'typed_v11_chunk_delete','typed_v11_owner_membership_guard',
   'typed_v11_manifest_membership_guard'))!=11
 THEN RAISE(ABORT,'typed_v11_runtime_contract_unqualified') END);
END;
PRAGMA legacy_alter_table=OFF;
