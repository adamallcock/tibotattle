PRAGMA foreign_keys = ON;

-- A fresh-social recovery may prove the immediately preceding client secret
-- after its remote rotation committed but local replacement did not. Retain
-- that hashed proof only on the exact attempt receipt; ordinary device auth
-- and unrelated rotations never accept it. Existing retention/erasure applies.
ALTER TABLE device_credential_rotations ADD COLUMN recovery_proof_hash BLOB
  CHECK (recovery_proof_hash IS NULL OR length(recovery_proof_hash) = 32);

CREATE INDEX telemetry_contributions_successor_compatibility
  ON telemetry_contributions(participant_id)
  WHERE status = 'accepted' AND transport_schema_version = 'telemetry-contribution-v0.2';

-- Namespace is authenticated-enrollment scoped, never a device identifier or
-- wire version. Existing enrollments get fresh random bindings, not historical
-- account claims. Deletion cascades; recreating a participant cannot restore a
-- removed namespace. The external deletion ledger remains authoritative.
CREATE TABLE attribution_enrollments (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL UNIQUE CHECK (length(namespace) = 64 AND namespace NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO attribution_enrollments (participant_id, namespace, created_at)
  SELECT id, lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM participants;
CREATE TRIGGER attribution_enrollment_created AFTER INSERT ON participants
BEGIN
  INSERT INTO attribution_enrollments (participant_id, namespace, created_at)
    VALUES (NEW.id, lower(hex(randomblob(32))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER attribution_enrollment_immutable BEFORE UPDATE ON attribution_enrollments
BEGIN SELECT RAISE(ABORT, 'attribution_enrollment_immutable'); END;

CREATE TABLE telemetry_transport_formats (
  schema_version TEXT PRIMARY KEY,
  format_rank INTEGER NOT NULL UNIQUE CHECK (format_rank IN (1, 2, 10, 11)),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('accepted', 'staged', 'blocked'))
) STRICT;
INSERT INTO telemetry_transport_formats VALUES
  ('telemetry-contribution-v0.1', 1, 'accepted'),
  ('telemetry-contribution-v0.2', 2, 'blocked'),
  ('telemetry-contribution-v1.0', 10, 'accepted'),
  ('telemetry-contribution-v1.1', 11, 'staged');
CREATE TRIGGER telemetry_transport_format_identity_immutable
BEFORE UPDATE OF schema_version, format_rank ON telemetry_transport_formats
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_identity_immutable'); END;

-- A re-pair/new device never lowers the enrollment's write floor. No existing
-- participant is upgraded by this migration. A separate explicit grant raises
-- the floor; a rollback needs an owner-audited, compare-and-swap operation.
CREATE TABLE telemetry_transport_participant_floors (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  minimum_rank INTEGER NOT NULL DEFAULT 1 CHECK (minimum_rank IN (1, 2, 10, 11)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at TEXT NOT NULL
) STRICT;
INSERT INTO telemetry_transport_participant_floors (participant_id, changed_at)
  SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM participants;
CREATE TRIGGER telemetry_transport_floor_created AFTER INSERT ON participants
BEGIN
  INSERT INTO telemetry_transport_participant_floors (participant_id, changed_at)
    VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE telemetry_transport_floor_rollbacks (
  operation_id TEXT PRIMARY KEY REFERENCES admin_action_audit(operation_id),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  participant_digest TEXT NOT NULL CHECK (length(participant_digest) = 64 AND participant_digest NOT GLOB '*[^0-9a-f]*'),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  from_rank INTEGER NOT NULL CHECK (from_rank IN (1, 2, 10, 11)),
  to_rank INTEGER NOT NULL CHECK (to_rank IN (1, 2, 10, 11) AND to_rank < from_rank),
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, expected_revision)
) STRICT;
CREATE TRIGGER telemetry_transport_rollback_owner_only
BEFORE INSERT ON telemetry_transport_floor_rollbacks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM admin_action_audit a
      JOIN telemetry_transport_participant_floors f ON f.participant_id = NEW.participant_id
      JOIN participants p ON p.id = f.participant_id
     WHERE a.operation_id = NEW.operation_id AND a.action = 'run_maintenance'
       AND a.outcome = 'started' AND p.state = 'active'
       AND json_extract(a.details_json, '$.operation') = 'telemetry_transport_rollback'
       AND json_extract(a.details_json, '$.participantDigest') = NEW.participant_digest
       AND json_extract(a.details_json, '$.expectedRevision') = NEW.expected_revision
       AND json_extract(a.details_json, '$.fromRank') = NEW.from_rank
       AND json_extract(a.details_json, '$.toRank') = NEW.to_rank
       AND f.revision = NEW.expected_revision AND f.minimum_rank = NEW.from_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_rollback_denied') END);
END;
CREATE TRIGGER telemetry_transport_floor_revision
BEFORE UPDATE ON telemetry_transport_participant_floors
WHEN NEW.participant_id != OLD.participant_id OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_floor_revision_conflict'); END;
CREATE TRIGGER telemetry_transport_floor_no_implicit_downgrade
BEFORE UPDATE OF minimum_rank ON telemetry_transport_participant_floors
WHEN NEW.minimum_rank < OLD.minimum_rank
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_floor_rollbacks r
      JOIN admin_action_audit a ON a.operation_id = r.operation_id
     WHERE r.participant_id = OLD.participant_id AND r.expected_revision = OLD.revision
       AND r.from_rank = OLD.minimum_rank AND r.to_rank = NEW.minimum_rank
       AND a.outcome = 'started'
  ) THEN RAISE(ABORT, 'telemetry_transport_rollback_required') END);
END;

-- Older account-scoped contributions have no successor compatibility adapter.
-- Keep their participant on the legacy lane; consent cannot strand history by
-- advancing admission before a complete semantic replacement is possible.
CREATE TRIGGER telemetry_transport_floor_successor_history_guard
BEFORE UPDATE OF minimum_rank ON telemetry_transport_participant_floors
WHEN NEW.minimum_rank = 11 AND NEW.minimum_rank > OLD.minimum_rank
  AND EXISTS (SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
      AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_blocked'); END;

CREATE TABLE telemetry_v11_device_consents (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version TEXT NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.1'),
  field_dictionary_version TEXT NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'),
  privacy_contract_version TEXT NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'),
  consented_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, device_id)
) STRICT;
-- Device erasure probes this foreign key without a participant predicate.
-- The participant-leading primary key cannot serve that child lookup.
CREATE INDEX telemetry_v11_consents_device ON telemetry_v11_device_consents(device_id);
CREATE TRIGGER telemetry_v11_consent_admission BEFORE INSERT ON telemetry_v11_device_consents
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM participants p JOIN device_credentials d ON d.participant_id = p.id
      JOIN attribution_enrollments e ON e.participant_id = p.id
      JOIN telemetry_transport_formats f ON f.schema_version = NEW.telemetry_schema_version
     WHERE p.id = NEW.participant_id AND p.state = 'active'
       AND d.id = NEW.device_id AND d.state = 'active' AND f.lifecycle = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;
CREATE TRIGGER telemetry_v11_consent_floor AFTER INSERT ON telemetry_v11_device_consents
BEGIN
  UPDATE telemetry_transport_participant_floors
     SET minimum_rank = max(minimum_rank, 11), revision = revision + 1, changed_at = NEW.consented_at
   WHERE participant_id = NEW.participant_id;
END;
CREATE TRIGGER telemetry_v11_consent_immutable BEFORE UPDATE ON telemetry_v11_device_consents
BEGIN SELECT RAISE(ABORT, 'telemetry_consent_immutable'); END;

-- Legacy entry points cannot bypass an upgraded participant's floor, including
-- the dormant v0.2 branch. Retained old rows are unchanged and still readable.
CREATE TRIGGER telemetry_transport_legacy_insert BEFORE INSERT ON telemetry_contributions
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_formats f
      JOIN telemetry_transport_participant_floors p ON p.participant_id = NEW.participant_id
     WHERE f.schema_version = NEW.transport_schema_version
       AND f.lifecycle = 'accepted' AND f.format_rank >= p.minimum_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;
CREATE TRIGGER telemetry_transport_v1_insert BEFORE INSERT ON telemetry_v1_chunks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_transport_formats f
      JOIN telemetry_transport_participant_floors p ON p.participant_id = NEW.participant_id
     WHERE f.schema_version = 'telemetry-contribution-v1.0'
       AND f.lifecycle = 'accepted' AND f.format_rank >= p.minimum_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
END;

CREATE TABLE telemetry_v11_day_manifests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day TEXT NOT NULL CHECK (length(chunk_day) = 10),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND length(manifest_json) <= 1250000),
  expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count BETWEEN 0 AND 4096),
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'ready')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  UNIQUE (participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
) STRICT;
CREATE INDEX telemetry_v11_manifests_device_day
  ON telemetry_v11_day_manifests(participant_id, device_id, chunk_day, created_at, id);
CREATE INDEX telemetry_v11_manifests_admission
  ON telemetry_v11_day_manifests(participant_id, device_id, created_at);
CREATE INDEX telemetry_v11_manifests_export
  ON telemetry_v11_day_manifests(participant_id, created_at, id);
CREATE INDEX telemetry_v11_manifests_device ON telemetry_v11_day_manifests(device_id);

CREATE TABLE telemetry_v11_chunks (
  id TEXT PRIMARY KEY CHECK (length(id) = 42 AND substr(id, 1, 6) = 'chunk:'),
  manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  chunk_day TEXT NOT NULL,
  chunk_seq INTEGER NOT NULL CHECK (chunk_seq BETWEEN 0 AND 99999),
  chunk_id TEXT NOT NULL,
  chunk_digest TEXT NOT NULL CHECK (length(chunk_digest) = 64 AND chunk_digest NOT GLOB '*[^0-9a-f]*'),
  envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  r2_key TEXT NOT NULL UNIQUE,
  device_upload_authorization_id TEXT NOT NULL UNIQUE REFERENCES device_upload_authorizations(id),
  quarantine_deleted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (manifest_id, chunk_id),
  UNIQUE (participant_id, envelope_digest)
) STRICT;
CREATE INDEX telemetry_v11_chunks_participant ON telemetry_v11_chunks(participant_id, created_at, id);
CREATE INDEX telemetry_v11_chunks_device ON telemetry_v11_chunks(device_id);
CREATE INDEX telemetry_v11_chunks_retention ON telemetry_v11_chunks(created_at, id) WHERE quarantine_deleted_at IS NULL;

CREATE TABLE telemetry_v11_records (
  chunk_id TEXT NOT NULL REFERENCES telemetry_v11_chunks(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) BETWEEN 8 AND 128),
  observed_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND length(record_json) <= 100000),
  legacy_occurrence_id TEXT CHECK (legacy_occurrence_id IS NULL OR length(legacy_occurrence_id) BETWEEN 8 AND 128),
  legacy_record_json TEXT CHECK (legacy_record_json IS NULL OR (json_valid(legacy_record_json) AND length(legacy_record_json) <= 100000)),
  PRIMARY KEY (chunk_id, occurrence_id),
  UNIQUE (manifest_id, stream, occurrence_id),
  CHECK ((legacy_occurrence_id IS NULL) = (legacy_record_json IS NULL))
) STRICT;
CREATE INDEX telemetry_v11_records_legacy_counterpart
  ON telemetry_v11_records(manifest_id, stream, legacy_occurrence_id);

CREATE TRIGGER telemetry_v11_manifest_admission BEFORE INSERT ON telemetry_v11_day_manifests
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_device_consents c
      JOIN device_credentials d ON d.id = c.device_id AND d.participant_id = c.participant_id
      JOIN participants p ON p.id = c.participant_id
      JOIN telemetry_transport_participant_floors f ON f.participant_id = c.participant_id
      JOIN telemetry_transport_formats t ON t.schema_version = c.telemetry_schema_version
     WHERE c.participant_id = NEW.participant_id AND c.device_id = NEW.device_id
       AND d.state = 'active' AND p.state = 'active' AND t.lifecycle = 'accepted'
       AND t.format_rank >= f.minimum_rank
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END);
  SELECT (CASE WHEN NEW.expected_chunk_count != json_array_length(NEW.manifest_json, '$.chunks')
    OR NEW.state != 'staged' THEN RAISE(ABORT, 'telemetry_manifest_invalid') END);
  -- Empty manifests need their own bound; chunk admission alone does not
  -- constrain zero-row days or endless different candidate digests.
  SELECT (CASE WHEN (SELECT count(*) FROM (
    SELECT 1 FROM telemetry_v11_day_manifests
     WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
       AND created_at >= substr(NEW.created_at, 1, 10) || 'T00:00:00.000Z'
     LIMIT 8192
  )) >= 8192 THEN RAISE(ABORT, 'telemetry_manifest_admission_exhausted') END);
END;
CREATE TRIGGER telemetry_v11_manifest_immutable
BEFORE UPDATE OF id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json, expected_chunk_count, created_at
ON telemetry_v11_day_manifests
BEGIN SELECT RAISE(ABORT, 'telemetry_manifest_immutable'); END;

CREATE TRIGGER telemetry_v11_chunk_admission BEFORE INSERT ON telemetry_v11_chunks
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_day_manifests m
      JOIN telemetry_v11_device_consents c ON c.participant_id = m.participant_id AND c.device_id = m.device_id
      JOIN telemetry_transport_formats t ON t.schema_version = c.telemetry_schema_version
      JOIN telemetry_transport_participant_floors f ON f.participant_id = m.participant_id
      JOIN participants p ON p.id = m.participant_id
      JOIN device_credentials d ON d.id = m.device_id AND d.participant_id = m.participant_id
      JOIN device_upload_authorizations a ON a.id = NEW.device_upload_authorization_id
      JOIN json_each(m.manifest_json, '$.chunks') expected
     WHERE m.id = NEW.manifest_id AND m.participant_id = NEW.participant_id
       AND m.device_id = NEW.device_id AND m.chunk_day = NEW.chunk_day
       AND m.parser_version = NEW.parser_version AND m.state = 'staged'
       AND d.state = 'active' AND p.state = 'active' AND t.lifecycle = 'accepted'
       AND t.format_rank >= f.minimum_rank
       AND NOT EXISTS (SELECT 1 FROM telemetry_contributions legacy
         WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
           AND legacy.transport_schema_version = 'telemetry-contribution-v0.2')
       AND a.participant_id = NEW.participant_id AND a.issued_by_device_id = NEW.device_id
       AND a.state = 'consuming' AND a.envelope_digest = NEW.envelope_digest
       AND a.consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND json_extract(expected.value, '$.chunkId') = NEW.chunk_id
       AND json_extract(expected.value, '$.chunkDigest') = NEW.chunk_digest
       AND json_extract(expected.value, '$.recordCount') = NEW.record_count
  ) THEN RAISE(ABORT, 'telemetry_chunk_staging_denied') END);
END;
CREATE TRIGGER telemetry_v11_chunks_enforce_admission BEFORE INSERT ON telemetry_v11_chunks
WHEN COALESCE((
  SELECT accepted_count FROM telemetry_v1_chunk_admission_windows
   WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
     AND window_day = substr(NEW.created_at, 1, 10)
), 0) >= (CASE WHEN (
  SELECT issued_at FROM device_credentials WHERE id = NEW.device_id
) > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-7 days') THEN 20000 ELSE 2000 END)
BEGIN SELECT RAISE(ABORT, 'chunk admission window exhausted'); END;
CREATE TRIGGER telemetry_v11_chunks_record_admission AFTER INSERT ON telemetry_v11_chunks
BEGIN
  INSERT INTO telemetry_v1_chunk_admission_windows (
    participant_id, device_id, window_day, accepted_count, last_accepted_at
  ) VALUES (NEW.participant_id, NEW.device_id, substr(NEW.created_at, 1, 10), 1, NEW.created_at)
  ON CONFLICT (participant_id, device_id, window_day) DO UPDATE SET
    accepted_count = accepted_count + 1, last_accepted_at = excluded.last_accepted_at;
  UPDATE device_upload_authorizations
     SET state = 'consumed', consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL, consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id AND state = 'consuming';
END;
CREATE TRIGGER telemetry_v11_chunk_immutable
BEFORE UPDATE OF id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
  chunk_id, chunk_digest, envelope_digest, parser_version, record_count, r2_key,
  device_upload_authorization_id, created_at ON telemetry_v11_chunks
BEGIN SELECT RAISE(ABORT, 'telemetry_chunk_immutable'); END;
CREATE TRIGGER telemetry_v11_record_admission BEFORE INSERT ON telemetry_v11_records
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_chunks c JOIN telemetry_v11_day_manifests m ON m.id = c.manifest_id
     WHERE c.id = NEW.chunk_id AND c.manifest_id = NEW.manifest_id
       AND c.stream = NEW.stream AND m.state = 'staged'
       AND substr(NEW.observed_at, 1, 10) = c.chunk_day
       AND (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id) < c.record_count
  ) THEN RAISE(ABORT, 'telemetry_record_staging_denied') END);
END;
CREATE TRIGGER telemetry_v11_record_immutable BEFORE UPDATE ON telemetry_v11_records
BEGIN SELECT RAISE(ABORT, 'telemetry_record_immutable'); END;
CREATE TRIGGER telemetry_v11_manifest_ready BEFORE UPDATE OF state ON telemetry_v11_day_manifests
BEGIN
  SELECT (CASE WHEN OLD.state != 'staged' OR NEW.state != 'ready'
    OR NEW.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks WHERE manifest_id = NEW.id)
    OR EXISTS (
      SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = NEW.id
        AND c.record_count != (SELECT count(*) FROM telemetry_v11_records r WHERE r.chunk_id = c.id)
    ) THEN RAISE(ABORT, 'telemetry_manifest_incomplete') END);
END;
