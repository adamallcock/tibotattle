-- Forward, fresh/unbound compact admission role only. Existing admitted proofs
-- require a separately verified conversion; this migration never discards them.
CREATE TABLE typed_v11_compaction_guard (n INTEGER CHECK(n=0));
INSERT INTO typed_v11_compaction_guard SELECT count(*) FROM typed_v11_record_admissions;
DROP TABLE typed_v11_compaction_guard;
DROP TABLE typed_v11_record_admissions;

CREATE TABLE typed_v11_manifest_memberships (
 manifest_id TEXT PRIMARY KEY REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
 typed_manifest_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_manifests(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE typed_v11_record_proofs (
 typed_record_id INTEGER PRIMARY KEY REFERENCES typed_telemetry_records(id) ON DELETE CASCADE,
 chunk_key INTEGER NOT NULL REFERENCES typed_telemetry_chunks(id) ON DELETE CASCADE,
 manifest_key INTEGER NOT NULL REFERENCES typed_telemetry_manifests(id) ON DELETE CASCADE,
 stream_code INTEGER NOT NULL CHECK(stream_code IN(1,2,3)),
 stream TEXT GENERATED ALWAYS AS (CASE stream_code WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END) VIRTUAL,
 occurrence_blob BLOB NOT NULL,
 occurrence_id TEXT GENERATED ALWAYS AS (CASE
    WHEN hex(substr(occurrence_blob, 1, 1)) = '00' THEN CAST(substr(occurrence_blob, 2) AS TEXT)
    WHEN (hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(occurrence_blob) = 17)
      OR (hex(substr(occurrence_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(occurrence_blob) = 33)
    THEN (CASE hex(substr(occurrence_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(occurrence_blob, 2, 4))) || '-' || lower(hex(substr(occurrence_blob, 6, 2))) || '-' || lower(hex(substr(occurrence_blob, 8, 2))) || '-' || lower(hex(substr(occurrence_blob, 10, 2))) || '-' || lower(hex(substr(occurrence_blob, 12, 6))) ELSE lower(hex(substr(occurrence_blob, 2))) END
    END) VIRTUAL NOT NULL CHECK(length(occurrence_id) BETWEEN 8 AND 128),
 base_digest BLOB NOT NULL CHECK(length(base_digest)=32),
 legacy_occurrence_blob BLOB,
 legacy_occurrence_id TEXT GENERATED ALWAYS AS (CASE
    WHEN hex(substr(legacy_occurrence_blob, 1, 1)) = '00' THEN CAST(substr(legacy_occurrence_blob, 2) AS TEXT)
    WHEN (hex(substr(legacy_occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B') AND length(legacy_occurrence_blob) = 17)
      OR (hex(substr(legacy_occurrence_blob, 1, 1)) IN ('06','07','08','09','0A') AND length(legacy_occurrence_blob) = 33)
    THEN (CASE hex(substr(legacy_occurrence_blob, 1, 1)) WHEN '02' THEN 'participant:' WHEN '03' THEN 'device:'
      WHEN '04' THEN 'v1:' WHEN '05' THEN 'contribution:' WHEN '07' THEN 'event:v2:'
      WHEN '08' THEN 'quota-occurrence:v1:' WHEN '09' THEN 'account-track:v2:'
      WHEN '0A' THEN 'plan-era:v1:' WHEN '0B' THEN 'chunk:' ELSE '' END)
      || CASE WHEN hex(substr(legacy_occurrence_blob, 1, 1)) IN ('01','02','03','04','05','0B')
        THEN lower(hex(substr(legacy_occurrence_blob, 2, 4))) || '-' || lower(hex(substr(legacy_occurrence_blob, 6, 2))) || '-' || lower(hex(substr(legacy_occurrence_blob, 8, 2))) || '-' || lower(hex(substr(legacy_occurrence_blob, 10, 2))) || '-' || lower(hex(substr(legacy_occurrence_blob, 12, 6))) ELSE lower(hex(substr(legacy_occurrence_blob, 2))) END
    END) VIRTUAL,
 legacy_digest BLOB CHECK(legacy_digest IS NULL OR length(legacy_digest)=32),
 observed_at_ms INTEGER NOT NULL,
 CHECK((legacy_occurrence_blob IS NULL)=(legacy_digest IS NULL)),
 CHECK(legacy_occurrence_blob IS NULL OR (legacy_occurrence_id IS NOT NULL AND length(legacy_occurrence_id) BETWEEN 8 AND 128))
) STRICT;
-- The core's UNIQUE(chunk_id,occurrence_id) and manifest/stream/occurrence
-- constraint already enforce exact canonical duplicates. Do not duplicate them.
-- Decoded virtual sort keys retain TEXT lexical order for every codec form.
CREATE INDEX typed_v11_proof_chunk ON typed_v11_record_proofs(chunk_key);
CREATE INDEX typed_v11_proof_manifest ON typed_v11_record_proofs(manifest_key,stream,occurrence_id);
CREATE INDEX typed_v11_admissions_legacy ON typed_v11_record_proofs(manifest_key,stream,legacy_occurrence_id);
CREATE INDEX typed_v11_manifest_observed ON typed_v11_record_proofs(manifest_key,stream,observed_at_ms,occurrence_id);
CREATE VIEW typed_v11_record_admissions AS
 SELECT p.typed_record_id,a.chunk_id,m.manifest_id,p.stream,p.occurrence_id,p.base_digest,
  p.legacy_occurrence_id,p.legacy_digest,p.observed_at_ms
 FROM typed_v11_record_proofs p
 JOIN typed_telemetry_chunks c ON c.id=p.chunk_key
 JOIN typed_v11_chunk_allocations a ON a.namespace_id=c.namespace_id AND a.chunk_original=c.original_id
 JOIN typed_v11_manifest_memberships m ON m.typed_manifest_id=p.manifest_key;
CREATE TRIGGER typed_v11_manifest_membership_guard BEFORE INSERT ON typed_v11_manifest_memberships
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_telemetry_records tr
  JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=tr.id
  WHERE tr.manifest_id=NEW.typed_manifest_id AND tr.format=11 AND r.manifest_id=NEW.manifest_id)
 THEN RAISE(ABORT,'typed_v11_manifest_membership_conflict') END;
END;
CREATE TRIGGER typed_v11_manifest_membership_immutable BEFORE UPDATE ON typed_v11_manifest_memberships
BEGIN SELECT RAISE(ABORT,'typed_v11_manifest_membership_conflict'); END;
CREATE TRIGGER typed_v11_manifest_membership_retained BEFORE DELETE ON typed_v11_manifest_memberships
WHEN EXISTS(SELECT 1 FROM typed_v11_record_proofs WHERE manifest_key=OLD.typed_manifest_id)
 AND EXISTS(SELECT 1 FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)
 AND EXISTS(SELECT 1 FROM typed_telemetry_manifests WHERE id=OLD.typed_manifest_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_manifest_membership_retained'); END;
CREATE TRIGGER typed_v11_record_membership BEFORE INSERT ON typed_v11_record_proofs
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM typed_telemetry_records raw
  JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=raw.id
  JOIN typed_v11_admission_state s ON s.namespace_id=r.namespace_id AND s.source_namespace=r.source_namespace
  JOIN typed_telemetry_chunks tc ON tc.id=raw.chunk_id
  JOIN typed_v11_chunk_allocations a ON a.namespace_id=r.namespace_id AND a.chunk_original=tc.original_id
  JOIN telemetry_v11_chunks c ON c.id=a.chunk_id
  JOIN telemetry_v11_day_manifests m ON m.id=c.manifest_id
  JOIN typed_v11_manifest_memberships mm ON mm.manifest_id=m.id AND mm.typed_manifest_id=raw.manifest_id
  WHERE raw.id=NEW.typed_record_id AND raw.format=11 AND raw.chunk_id=NEW.chunk_key
   AND raw.manifest_id=NEW.manifest_key AND raw.stream=NEW.stream_code AND raw.occurrence_id=NEW.occurrence_blob
   AND (NEW.legacy_occurrence_blob IS NULL OR
    (NEW.stream_code IN(1,3) AND NEW.legacy_occurrence_blob=NEW.occurrence_blob) OR
    (NEW.stream_code=2 AND hex(substr(NEW.legacy_occurrence_blob,1,1))='00' AND NEW.legacy_occurrence_id GLOB 'q:*'))
   AND r.chunk_row_id=c.id AND r.manifest_id=c.manifest_id AND r.participant_id=c.participant_id AND r.device_id=c.device_id
   AND r.chunk_day=c.chunk_day AND r.observed_day=c.chunk_day AND substr(r.observed_at,1,10)=c.chunk_day
   AND raw.source_row_id>=a.first_source_row_id AND raw.source_row_id<a.first_source_row_id+a.record_count
   AND c.stream=NEW.stream AND r.stream=NEW.stream AND m.state='staged'
   AND EXISTS(SELECT 1 FROM typed_v11_owner_memberships o WHERE o.typed_owner_id=raw.owner_id AND o.participant_id=c.participant_id)
   AND (SELECT count(*) FROM typed_v11_record_proofs p WHERE p.chunk_key=raw.chunk_id)<c.record_count)
 THEN RAISE(ABORT,'typed_v11_record_staging_denied') END;
END;
CREATE TRIGGER typed_v11_record_time_guard BEFORE INSERT ON typed_v11_record_proofs
WHEN NEW.observed_at_ms IS NOT (SELECT observed_at_ms FROM typed_telemetry_records WHERE id=NEW.typed_record_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_record_time_conflict'); END;
CREATE TRIGGER typed_v11_record_proof_immutable BEFORE UPDATE ON typed_v11_record_proofs
BEGIN SELECT RAISE(ABORT,'typed_v11_record_proof_immutable'); END;
CREATE TRIGGER typed_v11_record_compat_update INSTEAD OF UPDATE ON typed_v11_record_admissions
BEGIN SELECT RAISE(ABORT,'typed_v11_record_proof_immutable'); END;
CREATE TRIGGER typed_v11_record_compat_delete INSTEAD OF DELETE ON typed_v11_record_admissions
BEGIN DELETE FROM typed_v11_record_proofs WHERE typed_record_id=OLD.typed_record_id; END;
CREATE TRIGGER typed_v11_active_proof_delete_guard BEFORE DELETE ON typed_v11_record_proofs
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days d
  JOIN telemetry_v11_domain_heads h ON h.generation_id = d.generation_id
  JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
  WHERE d.manifest_id = (SELECT manifest_id FROM typed_v11_manifest_memberships WHERE typed_manifest_id=OLD.manifest_key))
BEGIN SELECT RAISE(ABORT,'telemetry_domain_active'); END;
CREATE TRIGGER typed_v11_retained_proof_delete_guard BEFORE DELETE ON typed_v11_record_proofs
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days d
  JOIN storage_v11_event_sources e ON e.generation_id = d.generation_id
  JOIN storage_owner_revisions o ON o.owner_digest = e.owner_digest
  WHERE d.manifest_id = (SELECT manifest_id FROM typed_v11_manifest_memberships WHERE typed_manifest_id=OLD.manifest_key) AND o.state != 'erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;

DROP TRIGGER typed_v11_runtime_contract_qualify;
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
      '0003_typed_domain_closure.sql','0004_runtime_storage_contract.sql','0005_typed_active_reader.sql','0006_compact_admission_proofs.sql')) != 10
    OR (SELECT count(*) FROM sqlite_schema WHERE (type,name) IN (
      ('table','storage_v11_event_sources'),('table','storage_v11_owner_links'),
      ('view','typed_v11_record_admissions'),('table','typed_v11_record_proofs'),('table','typed_v11_manifest_memberships'),('table','typed_v1_preservation_proofs'),
      ('trigger','typed_v11_manifest_membership_guard'),('trigger','typed_v11_manifest_membership_immutable'),
      ('trigger','typed_v11_manifest_membership_retained'),('trigger','typed_v11_record_compat_update'),
      ('trigger','typed_v11_record_compat_delete'),('trigger','typed_v11_record_proof_immutable'),
      ('view','typed_telemetry_compatibility_records'),
      ('trigger','storage_v11_head_insert'),('trigger','storage_v11_head_update'),
      ('trigger','storage_v11_participant_erasure'),('trigger','storage_v11_chunks_retained'),
      ('trigger','telemetry_v11_domain_complete_before_insert'),('trigger','telemetry_v11_manifest_ready'),
      ('trigger','typed_v11_record_membership'),('trigger','typed_v11_allocation_guard'),
      ('trigger','typed_v11_active_proof_delete_guard'),('trigger','typed_v11_retained_proof_delete_guard'),
      ('trigger','typed_v11_usage_delete_guard'),('trigger','typed_v11_quota_delete_guard'),
      ('trigger','typed_v11_session_tools_delete_guard'),('trigger','typed_v11_session_tools_insert_guard'),
      ('trigger','typed_v11_record_time_guard'),('view','typed_v11_active_records'),('index','typed_v11_manifest_observed')
    )) != 30
    THEN RAISE(ABORT,'typed_v11_runtime_contract_unqualified') END;
END;
