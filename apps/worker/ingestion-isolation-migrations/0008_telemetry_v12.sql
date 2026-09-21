-- Staged v1.2 successor transport.  This migration is deliberately separate
-- from the frozen v1/v1.1 transport tables and floors.  Applying it creates a
-- dormant contract; an owner-operated activation changes only the singleton
-- runtime state after the client/storage qualification gates have passed.
PRAGMA foreign_keys = ON;

CREATE TABLE telemetry_v12_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL CHECK (schema_version = 'telemetry-contribution-v1.2'),
  envelope_schema_version TEXT NOT NULL CHECK (envelope_schema_version = 'telemetry-envelope-v1.2'),
  field_dictionary_version TEXT NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'),
  privacy_contract_version TEXT NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'),
  state TEXT NOT NULL CHECK (state IN ('staged', 'active')),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  max_day_chunks INTEGER NOT NULL CHECK (max_day_chunks BETWEEN 1 AND 4096),
  max_chunk_records INTEGER NOT NULL CHECK (max_chunk_records BETWEEN 1 AND 200),
  max_day_bytes INTEGER NOT NULL CHECK (max_day_bytes BETWEEN 1 AND 64000000),
  changed_at TEXT NOT NULL
) STRICT;
INSERT INTO telemetry_v12_runtime (
  id, schema_version, envelope_schema_version, field_dictionary_version,
  privacy_contract_version, state, policy_revision, max_day_chunks,
  max_chunk_records, max_day_bytes, changed_at
) VALUES (
  1, 'telemetry-contribution-v1.2', 'telemetry-envelope-v1.2',
  'telemetry-v1.2-registry-2026-09-20.1',
  'ongoing-privacy-safe-telemetry-v1.2', 'staged', 1, 4096, 200, 64000000,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Legacy admission is device-scoped once this successor migration is present.
-- The historical participant floor remains the owner-policy/rollback record,
-- while this table prevents a v1.1 grant on one device from stranding a
-- still-valid v1 device on the same participant. Existing social devices that
-- already carry the v1.1 consent retain rank 11; other social devices retain
-- at least the v1 rank (10) when the old owner floor was already 11. Accountless
-- devices remain on their existing accountless floor.
CREATE TABLE telemetry_transport_device_floors (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  minimum_rank INTEGER NOT NULL CHECK (minimum_rank IN (1, 2, 10, 11)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, device_id),
  UNIQUE (device_id)
) STRICT;
INSERT INTO telemetry_transport_device_floors (
  participant_id, device_id, minimum_rank, revision, changed_at
)
SELECT d.participant_id, d.id,
  CASE
    WHEN p.owner_kind = 'accountless' THEN floor.minimum_rank
    WHEN floor.minimum_rank = 11 AND EXISTS (
      SELECT 1 FROM telemetry_v11_device_consents consent
       WHERE consent.participant_id = d.participant_id AND consent.device_id = d.id
    ) THEN 11
    WHEN floor.minimum_rank = 11 THEN 10
    ELSE floor.minimum_rank
  END,
  0, floor.changed_at
FROM device_credentials d
JOIN participants p ON p.id = d.participant_id
JOIN telemetry_transport_participant_floors floor ON floor.participant_id = d.participant_id;
CREATE INDEX telemetry_transport_device_floors_participant
  ON telemetry_transport_device_floors(participant_id, minimum_rank, device_id);
CREATE TRIGGER telemetry_transport_device_floor_created AFTER INSERT ON device_credentials
BEGIN
  INSERT INTO telemetry_transport_device_floors (
    participant_id, device_id, minimum_rank, changed_at
  )
  SELECT NEW.participant_id, NEW.id,
    CASE WHEN p.owner_kind = 'accountless' THEN floor.minimum_rank
         WHEN floor.minimum_rank = 11 THEN 10 ELSE floor.minimum_rank END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM participants p
    JOIN telemetry_transport_participant_floors floor ON floor.participant_id = p.id
   WHERE p.id = NEW.participant_id;
END;
CREATE TRIGGER telemetry_transport_device_floor_revision
BEFORE UPDATE ON telemetry_transport_device_floors
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry_transport_device_floor_revision_conflict'); END;
CREATE TRIGGER telemetry_transport_device_floor_no_implicit_downgrade
BEFORE UPDATE OF minimum_rank ON telemetry_transport_device_floors
WHEN NEW.minimum_rank < OLD.minimum_rank
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM telemetry_transport_floor_rollbacks floor_rollback
      JOIN admin_action_audit audit_row ON audit_row.operation_id = floor_rollback.operation_id
     WHERE floor_rollback.participant_id = OLD.participant_id
       AND floor_rollback.from_rank = OLD.minimum_rank
       AND floor_rollback.to_rank = NEW.minimum_rank
       AND audit_row.outcome = 'started'
  ) THEN RAISE(ABORT, 'telemetry_transport_device_floor_rollback_required') END;
END;

-- Preserve the device boundary even if a legacy v1.1 consent insert reaches
-- SQLite without the newer policy helper. The existing consent trigger still
-- raises the participant-wide historical floor; this companion update records
-- the explicit device opt-in without changing any v1 device on the owner.
CREATE TRIGGER telemetry_transport_device_floor_v11_consent
AFTER INSERT ON telemetry_v11_device_consents
WHEN EXISTS (
  SELECT 1 FROM telemetry_transport_device_floors
   WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
     AND minimum_rank < 11
)
BEGIN
  UPDATE telemetry_transport_device_floors
     SET minimum_rank = 11, revision = revision + 1, changed_at = NEW.consented_at
   WHERE participant_id = NEW.participant_id AND device_id = NEW.device_id
     AND minimum_rank < 11;
END;

-- The frozen migration's v1 insert trigger predates device-scoped floors and
-- still joins the participant-wide rank. Replace only that guard after the
-- per-device table exists: an older v1 device must remain uploadable when a
-- different device raises its own floor to v1.1, while an explicitly upgraded
-- device remains barred from silently downgrading to v1. A missing device-floor
-- row fails closed rather than falling back to the owner-wide rank.
DROP TRIGGER IF EXISTS telemetry_transport_v1_insert;
CREATE TRIGGER telemetry_transport_v12_v1_insert
BEFORE INSERT ON telemetry_v1_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM telemetry_transport_formats format_row
      JOIN telemetry_transport_device_floors device_floor
        ON device_floor.participant_id = NEW.participant_id
       AND device_floor.device_id = NEW.device_id
     WHERE format_row.schema_version = 'telemetry-contribution-v1.0'
       AND format_row.lifecycle = 'accepted'
       AND format_row.format_rank >= device_floor.minimum_rank
  ) THEN RAISE(ABORT, 'telemetry_transport_blocked') END;
END;

-- A v1.2 grant is device-scoped and does not alter the legacy participant
-- floor.  This lets old and repaired clients continue uploading concurrently.
CREATE TABLE telemetry_v12_device_capabilities (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version TEXT NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.2'),
  field_dictionary_version TEXT NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'),
  privacy_contract_version TEXT NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'revoked')),
  consented_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (participant_id, device_id),
  CHECK ((state = 'accepted') = (revoked_at IS NULL))
) STRICT;
CREATE INDEX telemetry_v12_capabilities_device
  ON telemetry_v12_device_capabilities(device_id, state);

-- Accountless ownership has no browser session, so it receives a distinct
-- device/enrollment grant.  This never reuses the v1.1 authorization row or
-- raises the frozen participant floor.
CREATE TABLE accountless_v12_device_authorizations (
  enrollment_device_id TEXT PRIMARY KEY NOT NULL
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id TEXT NOT NULL UNIQUE REFERENCES device_credentials(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'accountless-upload-owner-v1.2'),
  policy_version TEXT NOT NULL CHECK (policy_version = 'accountless-telemetry-v1.2-policy-v1'),
  authorization_basis TEXT NOT NULL CHECK (authorization_basis = 'accountless-policy-v1.2'),
  telemetry_schema_version TEXT NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.2'),
  field_dictionary_version TEXT NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'),
  privacy_contract_version TEXT NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'),
  authorized_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at TEXT,
  revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'user_opt_out', 'security_reset', 'operator_containment'
  )),
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
) STRICT;
CREATE INDEX accountless_v12_device_authorizations_active
  ON accountless_v12_device_authorizations(state, expires_at);

CREATE TRIGGER accountless_v12_authorization_admission
BEFORE INSERT ON accountless_v12_device_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_upload_owners owner
    JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
    JOIN device_credentials d ON d.id = owner.device_credential_id
   WHERE owner.enrollment_device_id = NEW.enrollment_device_id
     AND owner.participant_id = NEW.participant_id
     AND owner.device_credential_id = NEW.device_credential_id
     AND owner.state = 'active' AND owner.expires_at = NEW.expires_at
     AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
     AND d.authority_kind = 'accountless' AND d.state = 'active'
     AND d.accountless_enrollment_device_id = NEW.enrollment_device_id
     AND d.expires_at = NEW.expires_at
)
BEGIN SELECT RAISE(ABORT, 'accountless v12 authorization unavailable'); END;

CREATE TRIGGER accountless_v12_authorization_immutable
BEFORE UPDATE ON accountless_v12_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.authorization_basis IS NOT OLD.authorization_basis
  OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
BEGIN SELECT RAISE(ABORT, 'accountless v12 authorization immutable'); END;

-- All v1.2 source writes use this single SQL authority view.  The accountless
-- lane is intentionally separate from the social consent table: it requires
-- the active owner, enrollment lease, device identity and the exact successor
-- grant at the same time.  Keeping that proof in a view lets every manifest,
-- chunk and domain fence share the same fail-closed predicate.
CREATE VIEW telemetry_v12_active_authorizations AS
SELECT c.participant_id, c.device_id, 'social' AS authority_kind
  FROM telemetry_v12_device_capabilities c
  JOIN telemetry_v12_runtime r ON r.id = 1
  JOIN participants p ON p.id = c.participant_id
  JOIN device_credentials d ON d.id = c.device_id AND d.participant_id = p.id
 WHERE c.state = 'accepted' AND r.state = 'active'
   AND p.state = 'active' AND p.owner_kind = 'social'
   AND d.state = 'active' AND d.authority_kind = 'social'
   AND c.telemetry_schema_version = r.schema_version
   AND c.field_dictionary_version = r.field_dictionary_version
   AND c.privacy_contract_version = r.privacy_contract_version
UNION ALL
SELECT a.participant_id, a.device_credential_id AS device_id, 'accountless' AS authority_kind
  FROM accountless_v12_device_authorizations a
  JOIN telemetry_v12_runtime r ON r.id = 1
  JOIN participants p ON p.id = a.participant_id
  JOIN device_credentials d ON d.id = a.device_credential_id AND d.participant_id = p.id
  JOIN accountless_enrollment_ledger ledger
    ON ledger.device_id = a.enrollment_device_id
  JOIN accountless_upload_owners owner
    ON owner.enrollment_device_id = a.enrollment_device_id
 WHERE a.state = 'active' AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND r.state = 'active'
   AND p.state = 'active' AND p.owner_kind = 'accountless'
   AND d.state = 'active' AND d.authority_kind = 'accountless'
   AND d.accountless_enrollment_device_id = a.enrollment_device_id
   AND d.expires_at = a.expires_at
   AND ledger.state = 'active' AND ledger.expires_at = a.expires_at
   AND owner.participant_id = a.participant_id
   AND owner.device_credential_id = a.device_credential_id
   AND owner.state = 'active' AND owner.expires_at = a.expires_at
   AND a.schema_version = 'accountless-upload-owner-v1.2'
   AND a.policy_version = 'accountless-telemetry-v1.2-policy-v1'
   AND a.authorization_basis = 'accountless-policy-v1.2'
   AND a.telemetry_schema_version = r.schema_version
   AND a.field_dictionary_version = r.field_dictionary_version
   AND a.privacy_contract_version = r.privacy_contract_version;

CREATE TRIGGER telemetry_v12_capability_admission
BEFORE INSERT ON telemetry_v12_device_capabilities
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v12_runtime r
      JOIN participants p ON p.id = NEW.participant_id
      JOIN device_credentials d ON d.id = NEW.device_id AND d.participant_id = p.id
     WHERE r.id = 1 AND r.state = 'active'
       AND p.state = 'active' AND p.owner_kind = 'social'
       AND d.state = 'active' AND d.authority_kind = 'social'
       AND NEW.state = 'accepted'
       AND NEW.telemetry_schema_version = r.schema_version
       AND NEW.field_dictionary_version = r.field_dictionary_version
       AND NEW.privacy_contract_version = r.privacy_contract_version
  ) THEN RAISE(ABORT, 'telemetry_v12_capability_unavailable') END;
END;
CREATE TRIGGER telemetry_v12_capability_immutable
BEFORE UPDATE ON telemetry_v12_device_capabilities
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.consented_at IS NOT OLD.consented_at
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_capability_immutable'); END;

CREATE TABLE telemetry_v12_day_manifests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day TEXT NOT NULL CHECK (length(chunk_day) = 10),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND length(manifest_json) <= 1250000),
  expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count BETWEEN 1 AND 4096),
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'ready')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  UNIQUE (participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
) STRICT;
CREATE INDEX telemetry_v12_manifests_device_day
  ON telemetry_v12_day_manifests(participant_id, device_id, chunk_day, created_at, id);

CREATE TRIGGER telemetry_v12_manifest_admission
BEFORE INSERT ON telemetry_v12_day_manifests
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v12_active_authorizations auth
     WHERE auth.participant_id = NEW.participant_id
       AND auth.device_id = NEW.device_id
  ) THEN RAISE(ABORT, 'telemetry_v12_transport_blocked') END;
  SELECT CASE WHEN NEW.state != 'staged'
    OR NEW.expected_chunk_count != json_array_length(NEW.manifest_json, '$.chunks')
    OR json_extract(NEW.manifest_json, '$.schemaVersion') != 'telemetry-day-manifest-v1.2'
    OR json_extract(NEW.manifest_json, '$.day') != NEW.chunk_day
    THEN RAISE(ABORT, 'telemetry_v12_manifest_invalid') END;
END;
CREATE TRIGGER telemetry_v12_manifest_immutable
BEFORE UPDATE OF id, participant_id, device_id, chunk_day, manifest_digest,
  parser_version, manifest_json, expected_chunk_count, created_at
ON telemetry_v12_day_manifests
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_manifest_immutable'); END;

CREATE TABLE telemetry_v12_chunks (
  id TEXT PRIMARY KEY CHECK (length(id) = 42 AND substr(id, 1, 6) = 'chunk:'),
  manifest_id TEXT NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  chunk_day TEXT NOT NULL CHECK (length(chunk_day) = 10),
  chunk_seq INTEGER NOT NULL CHECK (chunk_seq BETWEEN 0 AND 99999),
  chunk_id TEXT NOT NULL,
  chunk_digest TEXT NOT NULL CHECK (length(chunk_digest) = 64 AND chunk_digest NOT GLOB '*[^0-9a-f]*'),
  envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  r2_key TEXT NOT NULL UNIQUE,
  device_upload_authorization_id TEXT NOT NULL UNIQUE REFERENCES device_upload_authorizations(id),
  created_at TEXT NOT NULL,
  UNIQUE (manifest_id, chunk_id),
  UNIQUE (participant_id, envelope_digest)
) STRICT;
CREATE INDEX telemetry_v12_chunks_participant ON telemetry_v12_chunks(participant_id, created_at, id);
CREATE INDEX telemetry_v12_chunks_device ON telemetry_v12_chunks(device_id);

CREATE TRIGGER telemetry_v12_chunk_admission
BEFORE INSERT ON telemetry_v12_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v12_day_manifests m
      JOIN telemetry_v12_active_authorizations auth
        ON auth.participant_id = m.participant_id AND auth.device_id = m.device_id
      JOIN device_upload_authorizations a ON a.id = NEW.device_upload_authorization_id
      JOIN json_each(m.manifest_json, '$.chunks') expected
     WHERE m.id = NEW.manifest_id AND m.participant_id = NEW.participant_id
       AND m.device_id = NEW.device_id AND m.chunk_day = NEW.chunk_day
       AND m.parser_version = NEW.parser_version AND m.state = 'staged'
       AND a.participant_id = NEW.participant_id AND a.issued_by_device_id = NEW.device_id
       AND a.state = 'consuming' AND a.envelope_digest = NEW.envelope_digest
       AND a.consume_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND json_extract(expected.value, '$.chunkId') = NEW.chunk_id
       AND json_extract(expected.value, '$.chunkDigest') = NEW.chunk_digest
       AND json_extract(expected.value, '$.recordCount') = NEW.record_count
  ) THEN RAISE(ABORT, 'telemetry_v12_chunk_staging_denied') END;
END;
CREATE TRIGGER telemetry_v12_chunk_immutable
BEFORE UPDATE OF id, manifest_id, participant_id, device_id, stream, chunk_day,
  chunk_seq, chunk_id, chunk_digest, envelope_digest, parser_version,
  record_count, r2_key, device_upload_authorization_id, created_at
ON telemetry_v12_chunks
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_chunk_immutable'); END;
CREATE TRIGGER telemetry_v12_chunk_authorization_consumed
AFTER INSERT ON telemetry_v12_chunks
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed', consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL, consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id AND state = 'consuming';
END;

-- v1.2 records use the reviewed typed storage vocabulary.  The wire JSON is
-- validated before admission and retained only in the encrypted source object;
-- no per-event JSON copy is persisted in D1. Existing dictionary rows are
-- shared by the typed storage foundation, while the successor extension keeps
-- its own stream/attribution rows so frozen v1/v1.1 layouts remain untouched.
CREATE TABLE telemetry_v12_attributions (
  id INTEGER PRIMARY KEY,
  account_basis INTEGER NOT NULL CHECK (account_basis BETWEEN 0 AND 2),
  account_track BLOB NOT NULL,
  plan_basis INTEGER NOT NULL CHECK (plan_basis BETWEEN 0 AND 3),
  plan_type_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_era BLOB NOT NULL,
  CHECK ((account_basis = 0 AND length(account_track) = 0)
    OR (account_basis != 0 AND length(account_track) BETWEEN 2 AND 257)),
  CHECK (length(plan_era) = 0 OR length(plan_era) BETWEEN 2 AND 257),
  CHECK (plan_basis IN (1, 2) OR length(plan_era) = 0),
  UNIQUE (account_basis, account_track, plan_basis, plan_type_id, plan_era)
) STRICT;

CREATE TABLE telemetry_v12_records (
  id INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES telemetry_v12_chunks(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  record_index INTEGER NOT NULL CHECK (record_index BETWEEN 0 AND 199),
  occurrence_id BLOB NOT NULL CHECK (length(occurrence_id) BETWEEN 2 AND 257),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  observed_day INTEGER NOT NULL CHECK (observed_day BETWEEN -100000 AND 100000),
  provider_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  canonical_digest BLOB NOT NULL CHECK (length(canonical_digest) = 32),
  UNIQUE (chunk_id, record_index),
  UNIQUE (chunk_id, occurrence_id),
  UNIQUE (manifest_id, stream, occurrence_id)
) STRICT;
CREATE INDEX telemetry_v12_records_order
  ON telemetry_v12_records(manifest_id, stream, observed_at_ms, occurrence_id);

CREATE TABLE telemetry_v12_usage (
  record_id INTEGER PRIMARY KEY REFERENCES telemetry_v12_records(id) ON DELETE CASCADE,
  session_id BLOB NOT NULL CHECK (length(session_id) BETWEEN 2 AND 257),
  model_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  speed_mode_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  api_service_tier_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  surface_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  billing_surface_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  reasoning_effort_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  agent_scope_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  outcome_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  attribution_id INTEGER NOT NULL REFERENCES telemetry_v12_attributions(id),
  total_input_context_tokens INTEGER CHECK (total_input_context_tokens IS NULL OR total_input_context_tokens BETWEEN 0 AND 1000000000000),
  input_uncached_tokens INTEGER CHECK (input_uncached_tokens IS NULL OR input_uncached_tokens BETWEEN 0 AND 1000000000000),
  input_cache_read_tokens INTEGER CHECK (input_cache_read_tokens IS NULL OR input_cache_read_tokens BETWEEN 0 AND 1000000000000),
  input_cache_write_tokens INTEGER CHECK (input_cache_write_tokens IS NULL OR input_cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_text_tokens INTEGER CHECK (output_text_tokens IS NULL OR output_text_tokens BETWEEN 0 AND 1000000000000),
  output_reasoning_tokens INTEGER CHECK (output_reasoning_tokens IS NULL OR output_reasoning_tokens BETWEEN 0 AND 1000000000000),
  output_combined_tokens INTEGER CHECK (output_combined_tokens IS NULL OR output_combined_tokens BETWEEN 0 AND 1000000000000),
  boundary_flags INTEGER CHECK (boundary_flags IS NULL OR boundary_flags BETWEEN 0 AND 3),
  tie_order INTEGER CHECK (tie_order IS NULL OR tie_order BETWEEN 0 AND 819199),
  cache_write_ttl_five_minute_tokens INTEGER CHECK (cache_write_ttl_five_minute_tokens IS NULL OR cache_write_ttl_five_minute_tokens BETWEEN 0 AND 1000000000000),
  cache_write_ttl_one_hour_tokens INTEGER CHECK (cache_write_ttl_one_hour_tokens IS NULL OR cache_write_ttl_one_hour_tokens BETWEEN 0 AND 1000000000000),
  CHECK ((cache_write_ttl_five_minute_tokens IS NULL) = (cache_write_ttl_one_hour_tokens IS NULL)),
  CHECK (cache_write_ttl_five_minute_tokens IS NULL OR input_cache_write_tokens IS NOT NULL),
  CHECK (cache_write_ttl_five_minute_tokens IS NULL
    OR cache_write_ttl_five_minute_tokens + cache_write_ttl_one_hour_tokens = input_cache_write_tokens)
) STRICT;
CREATE INDEX telemetry_v12_usage_order
  ON telemetry_v12_usage(session_id, record_id, tie_order);

CREATE TABLE telemetry_v12_quota (
  record_id INTEGER PRIMARY KEY REFERENCES telemetry_v12_records(id) ON DELETE CASCADE,
  plan_type_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_variant_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  limit_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  slot_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  used_percent REAL CHECK (used_percent IS NULL OR used_percent BETWEEN 0 AND 100),
  window_duration_minutes INTEGER CHECK (window_duration_minutes IS NULL OR window_duration_minutes BETWEEN 1 AND 527040),
  resets_at_ms INTEGER CHECK (resets_at_ms IS NULL OR resets_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  attribution_id INTEGER NOT NULL REFERENCES telemetry_v12_attributions(id)
) STRICT;

CREATE TABLE telemetry_v12_session_tools (
  record_id INTEGER NOT NULL REFERENCES telemetry_v12_records(id) ON DELETE CASCADE,
  tool_class_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  count INTEGER NOT NULL CHECK (count BETWEEN 0 AND 1000000000),
  PRIMARY KEY (record_id, tool_class_id)
) STRICT;

CREATE TRIGGER telemetry_v12_record_admission
BEFORE INSERT ON telemetry_v12_records
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v12_chunks c JOIN telemetry_v12_day_manifests m ON m.id = c.manifest_id
     WHERE c.id = NEW.chunk_id AND c.manifest_id = NEW.manifest_id
       AND c.stream = NEW.stream AND m.state = 'staged'
       AND NEW.observed_day = CAST(strftime('%s', c.chunk_day || 'T00:00:00Z') AS INTEGER) / 86400
       AND (SELECT count(*) FROM telemetry_v12_records r WHERE r.chunk_id = c.id) < c.record_count
  ) THEN RAISE(ABORT, 'telemetry_v12_record_staging_denied') END;
END;
CREATE TRIGGER telemetry_v12_usage_admission
BEFORE INSERT ON telemetry_v12_usage
WHEN NOT EXISTS (SELECT 1 FROM telemetry_v12_records r WHERE r.id = NEW.record_id AND r.stream = 'usage')
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_staging_denied'); END;
CREATE TRIGGER telemetry_v12_quota_admission
BEFORE INSERT ON telemetry_v12_quota
WHEN NOT EXISTS (SELECT 1 FROM telemetry_v12_records r WHERE r.id = NEW.record_id AND r.stream = 'quota')
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_staging_denied'); END;
CREATE TRIGGER telemetry_v12_session_admission
BEFORE INSERT ON telemetry_v12_session_tools
WHEN NOT EXISTS (SELECT 1 FROM telemetry_v12_records r WHERE r.id = NEW.record_id AND r.stream = 'session')
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_staging_denied'); END;

CREATE TRIGGER telemetry_v12_manifest_ready
BEFORE UPDATE OF state ON telemetry_v12_day_manifests
WHEN NEW.state = 'ready'
BEGIN
  SELECT CASE WHEN OLD.state != 'staged'
    OR NEW.ready_at IS NULL
    OR NEW.expected_chunk_count != (SELECT count(*) FROM telemetry_v12_chunks c WHERE c.manifest_id = NEW.id)
    OR EXISTS (SELECT 1 FROM telemetry_v12_chunks c WHERE c.manifest_id = NEW.id
      AND c.record_count != (SELECT count(*) FROM telemetry_v12_records r WHERE r.chunk_id = c.id))
    THEN RAISE(ABORT, 'telemetry_v12_manifest_incomplete') END;
END;
CREATE TRIGGER telemetry_v12_record_immutable
BEFORE UPDATE ON telemetry_v12_records
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_immutable'); END;
CREATE TRIGGER telemetry_v12_usage_immutable
BEFORE UPDATE ON telemetry_v12_usage
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_immutable'); END;
CREATE TRIGGER telemetry_v12_quota_immutable
BEFORE UPDATE ON telemetry_v12_quota
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_immutable'); END;
CREATE TRIGGER telemetry_v12_session_tool_immutable
BEFORE UPDATE ON telemetry_v12_session_tools
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_record_immutable'); END;

-- Successor domain closure is isolated from the v1.1 head.  It is an
-- analytical source pin only; no existing reader is switched by this schema.
CREATE TABLE telemetry_v12_domain_predecessors (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  previous_generation_id TEXT,
  legacy_fingerprint TEXT NOT NULL CHECK (length(legacy_fingerprint) = 64 AND legacy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0),
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  through_day TEXT NOT NULL CHECK (length(through_day) = 10),
  days_json TEXT NOT NULL CHECK (json_valid(days_json) AND length(days_json) <= 1250000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (participant_id, device_id, token_hash)
) STRICT;
CREATE INDEX telemetry_v12_predecessors_current
  ON telemetry_v12_domain_predecessors(participant_id, device_id, consumed_at, expires_at);

CREATE TRIGGER telemetry_v12_predecessor_admission
BEFORE INSERT ON telemetry_v12_domain_predecessors
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v12_active_authorizations auth
   WHERE auth.participant_id = NEW.participant_id AND auth.device_id = NEW.device_id
)
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_transport_blocked'); END;

CREATE TABLE telemetry_v12_domains (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  predecessor_token_hash TEXT NOT NULL REFERENCES telemetry_v12_domain_predecessors(token_hash),
  previous_generation_id TEXT,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  legacy_fingerprint TEXT NOT NULL CHECK (length(legacy_fingerprint) = 64 AND legacy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0),
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  through_day TEXT NOT NULL CHECK (length(through_day) = 10),
  days_json TEXT NOT NULL CHECK (json_valid(days_json) AND length(days_json) <= 1250000),
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, manifest_digest)
) STRICT;
CREATE TRIGGER telemetry_v12_domain_admission
BEFORE INSERT ON telemetry_v12_domains
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v12_domain_predecessors predecessor
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id = predecessor.participant_id
     AND auth.device_id = predecessor.device_id
   WHERE predecessor.token_hash = NEW.predecessor_token_hash
     AND predecessor.participant_id = NEW.participant_id
     AND predecessor.device_id = NEW.device_id
     AND predecessor.consumed_at IS NULL
     AND predecessor.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND predecessor.previous_generation_id IS NEW.previous_generation_id
     AND predecessor.legacy_fingerprint = NEW.legacy_fingerprint
     AND predecessor.input_revision = NEW.input_revision
)
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_transport_blocked'); END;
CREATE TABLE telemetry_v12_domain_days (
  generation_id TEXT NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  observed_day TEXT NOT NULL CHECK (length(observed_day) = 10),
  manifest_id TEXT NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (generation_id, observed_day),
  UNIQUE (generation_id, manifest_id)
) STRICT;
CREATE TABLE telemetry_v12_domain_heads (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX telemetry_v12_domain_days_manifest ON telemetry_v12_domain_days(manifest_id);

CREATE TRIGGER telemetry_v12_domain_day_admission
BEFORE INSERT ON telemetry_v12_domain_days
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v12_domains d
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id = d.participant_id AND auth.device_id = d.device_id
    JOIN telemetry_v12_day_manifests m
      ON m.participant_id = d.participant_id AND m.device_id = d.device_id
   WHERE d.id = NEW.generation_id
     AND m.id = NEW.manifest_id AND m.manifest_digest = NEW.manifest_digest
     AND m.chunk_day = NEW.observed_day AND m.state = 'ready'
)
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_manifest_incomplete'); END;

CREATE TRIGGER telemetry_v12_domain_head_immutable
BEFORE UPDATE ON telemetry_v12_domain_heads
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR OLD.revision < 1 OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_domain_revision_conflict'); END;
