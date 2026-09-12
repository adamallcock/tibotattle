-- OPTIONAL, fresh typed-admission target only. Apply after complete baseline
-- 0001--0060, typed ingestion 0001--0004 and ingestion bridge 0001.
-- Authority/header tables remain the
-- actual baseline tables; no record JSON is copied, replaced or dropped here.
CREATE TABLE typed_v11_admission_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_namespace TEXT NOT NULL UNIQUE,
  namespace_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_namespaces(id),
  next_source_row_id INTEGER NOT NULL CHECK (next_source_row_id BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE TABLE typed_v11_chunk_allocations (
  chunk_id TEXT PRIMARY KEY REFERENCES telemetry_v11_chunks(id) ON DELETE CASCADE,
  namespace_id INTEGER NOT NULL REFERENCES typed_telemetry_namespaces(id),
  chunk_original BLOB NOT NULL CHECK (length(chunk_original) BETWEEN 2 AND 257),
  first_source_row_id INTEGER NOT NULL CHECK (first_source_row_id >= 1),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  CHECK (first_source_row_id + record_count <= 9007199254740991),
  UNIQUE (namespace_id, first_source_row_id),
  UNIQUE (namespace_id, chunk_original)
) STRICT;
CREATE TABLE typed_v11_owner_memberships (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  typed_owner_id INTEGER NOT NULL UNIQUE REFERENCES typed_telemetry_owners(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE typed_v11_record_admissions (
  typed_record_id INTEGER PRIMARY KEY REFERENCES typed_telemetry_records(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES telemetry_v11_chunks(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('usage','quota','session')),
  occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) BETWEEN 8 AND 128),
  base_digest BLOB NOT NULL CHECK (length(base_digest) = 32),
  legacy_occurrence_id TEXT CHECK (legacy_occurrence_id IS NULL OR length(legacy_occurrence_id) BETWEEN 8 AND 128),
  legacy_digest BLOB CHECK (legacy_digest IS NULL OR length(legacy_digest) = 32),
  CHECK ((legacy_occurrence_id IS NULL) = (legacy_digest IS NULL)),
  UNIQUE (chunk_id, occurrence_id),
  UNIQUE (manifest_id, stream, occurrence_id)
) STRICT;
CREATE INDEX typed_v11_admissions_legacy
  ON typed_v11_record_admissions(manifest_id, stream, legacy_occurrence_id);

CREATE TRIGGER typed_v11_initialize_empty BEFORE INSERT ON typed_v11_admission_state
WHEN NOT EXISTS (SELECT 1 FROM typed_v11_admission_state)
BEGIN
  SELECT CASE WHEN NEW.next_source_row_id != 1
    OR EXISTS (SELECT 1 FROM telemetry_v11_records)
    OR EXISTS (SELECT 1 FROM telemetry_v11_chunks)
    OR EXISTS (SELECT 1 FROM typed_telemetry_records WHERE format = 11)
    OR NOT EXISTS (SELECT 1 FROM typed_telemetry_schema WHERE id = 1 AND version = 1)
    THEN RAISE(ABORT,'typed_v11_unqualified_history') END;
END;
CREATE TRIGGER typed_v11_state_immutable BEFORE UPDATE ON typed_v11_admission_state
WHEN NEW.id IS NOT OLD.id OR NEW.source_namespace IS NOT OLD.source_namespace
  OR NEW.namespace_id IS NOT OLD.namespace_id OR (NEW.next_source_row_id IS NOT OLD.next_source_row_id AND (
    NEW.next_source_row_id <= OLD.next_source_row_id OR NOT EXISTS (
      SELECT 1 FROM typed_v11_chunk_allocations a WHERE a.namespace_id = OLD.namespace_id
        AND a.first_source_row_id = OLD.next_source_row_id
        AND a.first_source_row_id + a.record_count = NEW.next_source_row_id)))
BEGIN SELECT RAISE(ABORT,'typed_v11_namespace_or_allocator_conflict'); END;
CREATE TRIGGER typed_v11_state_retained BEFORE DELETE ON typed_v11_admission_state
BEGIN SELECT RAISE(ABORT,'typed_v11_namespace_retained'); END;
CREATE TRIGGER typed_v11_allocation_guard BEFORE INSERT ON typed_v11_chunk_allocations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM typed_v11_admission_state s JOIN telemetry_v11_chunks c ON c.id = NEW.chunk_id
    WHERE s.namespace_id = NEW.namespace_id AND s.next_source_row_id = NEW.first_source_row_id
      AND c.record_count = NEW.record_count)
    THEN RAISE(ABORT,'typed_v11_allocator_race') END;
END;
CREATE TRIGGER typed_v11_allocation_advance AFTER INSERT ON typed_v11_chunk_allocations
BEGIN
  UPDATE typed_v11_admission_state SET next_source_row_id = NEW.first_source_row_id + NEW.record_count
    WHERE id = 1 AND namespace_id = NEW.namespace_id AND next_source_row_id = NEW.first_source_row_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT,'typed_v11_allocator_race') END;
END;
CREATE TRIGGER typed_v11_allocation_immutable BEFORE UPDATE ON typed_v11_chunk_allocations
BEGIN SELECT RAISE(ABORT,'typed_v11_allocation_immutable'); END;
CREATE TRIGGER typed_v11_legacy_record_refusal BEFORE INSERT ON telemetry_v11_records
WHEN EXISTS (SELECT 1 FROM typed_v11_admission_state)
BEGIN SELECT RAISE(ABORT,'typed_v11_json_write_disabled'); END;

-- A generic typed copy cannot insert unallocated v11 rows into a live typed
-- target. The existing copy API stays unchanged on targets without this mode.
CREATE TRIGGER typed_v11_typed_row_allocation BEFORE INSERT ON typed_telemetry_records
WHEN NEW.format = 11 AND EXISTS (SELECT 1 FROM typed_v11_admission_state)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM typed_v11_chunk_allocations a JOIN typed_telemetry_chunks c ON c.id = NEW.chunk_id
    WHERE a.namespace_id = NEW.namespace_id AND c.namespace_id = a.namespace_id
      AND c.original_id = a.chunk_original AND NEW.source_row_id >= a.first_source_row_id
      AND NEW.source_row_id < a.first_source_row_id + a.record_count)
    THEN RAISE(ABORT,'typed_v11_unallocated_record') END;
END;
CREATE TRIGGER typed_v11_record_membership BEFORE INSERT ON typed_v11_record_admissions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM typed_telemetry_compatibility_records r
      JOIN typed_v11_admission_state s ON s.namespace_id = r.namespace_id AND s.source_namespace = r.source_namespace
      JOIN typed_v11_chunk_allocations a ON a.chunk_id = NEW.chunk_id AND a.namespace_id = r.namespace_id
      JOIN telemetry_v11_chunks c ON c.id = a.chunk_id
      JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id
    WHERE r.storage_row_id = NEW.typed_record_id AND r.format_code = 11
      AND r.chunk_row_id = c.id AND r.manifest_id = c.manifest_id
      AND r.participant_id = c.participant_id AND r.device_id = c.device_id
      AND r.chunk_day = c.chunk_day AND r.observed_day = c.chunk_day
      AND substr(r.observed_at,1,10) = c.chunk_day
      AND r.source_row_id >= a.first_source_row_id AND r.source_row_id < a.first_source_row_id + a.record_count
      AND c.manifest_id = NEW.manifest_id AND c.stream = NEW.stream AND r.stream = NEW.stream
      AND r.occurrence_id = NEW.occurrence_id AND m.state = 'staged'
      AND EXISTS (SELECT 1 FROM typed_v11_owner_memberships o WHERE o.typed_owner_id=r.owner_id AND o.participant_id=c.participant_id)
      AND (SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id = c.id) < c.record_count)
    THEN RAISE(ABORT,'typed_v11_record_staging_denied') END;
END;
CREATE TRIGGER typed_v11_record_proof_immutable BEFORE UPDATE ON typed_v11_record_admissions
BEGIN SELECT RAISE(ABORT,'typed_v11_record_proof_immutable'); END;
CREATE TRIGGER typed_v11_active_proof_delete_guard BEFORE DELETE ON typed_v11_record_admissions
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days d
  JOIN telemetry_v11_domain_heads h ON h.generation_id = d.generation_id
  JOIN participants p ON p.id = h.participant_id AND p.state = 'active'
  WHERE d.manifest_id = OLD.manifest_id)
BEGIN SELECT RAISE(ABORT,'telemetry_domain_active'); END;
CREATE TRIGGER typed_v11_retained_proof_delete_guard BEFORE DELETE ON typed_v11_record_admissions
WHEN EXISTS (SELECT 1 FROM telemetry_v11_domain_days d
  JOIN storage_v11_event_sources e ON e.generation_id = d.generation_id
  JOIN storage_owner_revisions o ON o.owner_digest = e.owner_digest
  WHERE d.manifest_id = OLD.manifest_id AND o.state != 'erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;
-- Mirror actual header deletion to the typed rows and owner dictionaries. The
-- existing owner-erasure/active-domain/retention guards remain authoritative.
CREATE TRIGGER typed_v11_chunk_delete BEFORE DELETE ON telemetry_v11_chunks
BEGIN
  DELETE FROM typed_telemetry_chunks WHERE namespace_id = (SELECT namespace_id FROM typed_v11_admission_state)
    AND format = 11 AND original_id = (SELECT chunk_original FROM typed_v11_chunk_allocations WHERE chunk_id = OLD.id);
END;
-- Keep an explicit owner link even after every staged chunk was discarded.
-- Its cascade runs after ALL participant BEFORE DELETE triggers, including the
-- delivery bridge terminal erasure; correctness never depends on trigger order.
CREATE TRIGGER typed_v11_owner_membership_guard BEFORE INSERT ON typed_v11_owner_memberships
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM typed_telemetry_compatibility_records r
    JOIN typed_v11_admission_state s ON s.namespace_id=r.namespace_id
    WHERE r.owner_id=NEW.typed_owner_id AND r.participant_id=NEW.participant_id AND r.format_code=11)
    THEN RAISE(ABORT,'typed_v11_owner_membership_conflict') END;
END;
CREATE TRIGGER typed_v11_owner_membership_immutable BEFORE UPDATE ON typed_v11_owner_memberships
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.typed_owner_id IS NOT NEW.typed_owner_id
BEGIN SELECT RAISE(ABORT,'typed_v11_owner_membership_conflict'); END;
CREATE TRIGGER typed_v11_owner_membership_retained BEFORE DELETE ON typed_v11_owner_memberships
WHEN EXISTS (SELECT 1 FROM participants WHERE id=OLD.participant_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_owner_membership_retained'); END;
CREATE TRIGGER typed_v11_owner_delete AFTER DELETE ON typed_v11_owner_memberships
BEGIN DELETE FROM typed_telemetry_owners WHERE id=OLD.typed_owner_id; END;

DROP TRIGGER telemetry_v11_manifest_ready;
CREATE TRIGGER telemetry_v11_manifest_ready BEFORE UPDATE OF state ON telemetry_v11_day_manifests
BEGIN
  SELECT CASE WHEN OLD.state != 'staged' OR NEW.state != 'ready'
    OR NEW.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks WHERE manifest_id = NEW.id)
    OR EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = NEW.id
      AND c.record_count != (SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id = c.id))
    THEN RAISE(ABORT,'telemetry_manifest_incomplete') END;
END;

-- A digest/proof must never outlive only part of its admitted record. Actual
-- parent cascades remove the base record before deleting child rows; they remain
-- permitted, including staged discard and terminal owner erasure.
CREATE TRIGGER typed_v11_usage_delete_guard BEFORE DELETE ON typed_telemetry_usage
WHEN EXISTS (SELECT 1 FROM typed_telemetry_records r JOIN typed_v11_record_admissions p ON p.typed_record_id=r.id
  WHERE r.id=OLD.record_id AND r.format=11)
BEGIN SELECT RAISE(ABORT,'typed_v11_admitted_record_retained'); END;
CREATE TRIGGER typed_v11_quota_delete_guard BEFORE DELETE ON typed_telemetry_quota
WHEN EXISTS (SELECT 1 FROM typed_telemetry_records r JOIN typed_v11_record_admissions p ON p.typed_record_id=r.id
  WHERE r.id=OLD.record_id AND r.format=11)
BEGIN SELECT RAISE(ABORT,'typed_v11_admitted_record_retained'); END;
CREATE TRIGGER typed_v11_session_tools_delete_guard BEFORE DELETE ON typed_telemetry_session_tools
WHEN EXISTS (SELECT 1 FROM typed_telemetry_records r JOIN typed_v11_record_admissions p ON p.typed_record_id=r.id
  WHERE r.id=OLD.record_id AND r.format=11)
BEGIN SELECT RAISE(ABORT,'typed_v11_admitted_record_retained'); END;
CREATE TRIGGER typed_v11_session_tools_insert_guard BEFORE INSERT ON typed_telemetry_session_tools
WHEN EXISTS (SELECT 1 FROM typed_v11_record_admissions WHERE typed_record_id=NEW.record_id)
  AND NOT EXISTS (SELECT 1 FROM typed_telemetry_session_tools WHERE record_id=NEW.record_id
    AND tool_class_id=NEW.tool_class_id AND count=NEW.count)
BEGIN SELECT RAISE(ABORT,'typed_v11_admitted_record_retained'); END;
