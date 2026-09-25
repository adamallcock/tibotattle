-- A content-free, source-sealed snapshot of already-retained accountless v1.1
-- authority. The snapshot contains only the marker tuple and the source proof
-- fields used by ingestion-isolation migration 0005. It never copies telemetry.
--
-- Snapshot capture is one D1 batch (one SQL transaction): it records the
-- authority revision, checks the applied migration receipts, counts every
-- candidate, and inserts the full proof rows only when every marker is
-- eligible. D1 batches execute statements sequentially and roll the entire
-- batch back if a statement fails. Keyset reads thereafter touch only the
-- immutable materialized rows. Relevant source writes advance the revision
-- and invalidate an open snapshot in the same source transaction.

CREATE TABLE accountless_history_transfer_control (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  authority_revision INTEGER NOT NULL DEFAULT 0 CHECK (authority_revision >= 0)
) STRICT;

INSERT INTO accountless_history_transfer_control (singleton_id, authority_revision)
VALUES (1, 0);

CREATE TABLE accountless_history_transfer_runs (
  run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 120),
  state TEXT NOT NULL CHECK (state IN (
    'capturing', 'sealed', 'extracted', 'invalidated', 'aborted'
  )),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  latest_migration_name TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  invalid_marker_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_marker_count >= 0),
  migration_count INTEGER NOT NULL DEFAULT 0 CHECK (migration_count >= 0),
  snapshot_at TEXT NOT NULL,
  manifest_sha256 TEXT CHECK (
    manifest_sha256 IS NULL OR (
      length(manifest_sha256) = 64
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  invalidation_code TEXT CHECK (invalidation_code IS NULL OR invalidation_code IN (
    'SOURCE_MIGRATION_RECEIPT_MISMATCH',
    'SOURCE_MARKER_INELIGIBLE',
    'SOURCE_AUTHORITY_MUTATED',
    'SOURCE_SNAPSHOT_ABORTED'
  )),
  CHECK (row_count <= candidate_count),
  CHECK (state != 'sealed' OR (
    row_count = candidate_count
    AND invalid_marker_count = 0
    AND migration_count = 3
    AND latest_migration_name = '0063_accountless_history_transfer_source.sql'
    AND manifest_sha256 IS NULL
    AND page_count = 0
  )),
  CHECK (state != 'extracted' OR (
    row_count = candidate_count
    AND invalid_marker_count = 0
    AND migration_count = 3
    AND latest_migration_name = '0063_accountless_history_transfer_source.sql'
    AND manifest_sha256 IS NOT NULL
  ))
) STRICT;

CREATE UNIQUE INDEX accountless_history_transfer_one_open_run
  ON accountless_history_transfer_runs((1))
  WHERE state IN ('capturing', 'sealed', 'extracted');

CREATE TABLE accountless_history_transfer_migration_receipts (
  run_id TEXT NOT NULL REFERENCES accountless_history_transfer_runs(run_id),
  migration_name TEXT NOT NULL,
  PRIMARY KEY (run_id, migration_name),
  CHECK (migration_name IN (
    '0061_accountless_history_retention.sql',
    '0062_v1_acquisition_vocabulary.sql',
    '0063_accountless_history_transfer_source.sql'
  ))
) STRICT, WITHOUT ROWID;

-- The view intentionally retains incomplete joins as rows with is_eligible=0.
-- Capture refuses the entire run if even one marker fails the exact
-- post-opt-out predicate; it never silently omits a damaged marker.
CREATE VIEW accountless_history_transfer_candidates AS
SELECT
  retained.participant_id AS participant_id,
  retained.enrollment_device_id AS marker_enrollment_device_id,
  retained.device_credential_id AS marker_device_credential_id,
  retained.generation_id AS marker_generation_id,
  retained.head_revision AS marker_head_revision,
  retained.retained_at AS marker_retained_at,
  participant.owner_kind AS participant_owner_kind,
  participant.state AS participant_state,
  owner.participant_id AS owner_participant_id,
  owner.enrollment_device_id AS owner_enrollment_device_id,
  owner.device_credential_id AS owner_device_credential_id,
  owner.policy_version AS owner_policy_version,
  owner.authorization_basis AS owner_authorization_basis,
  owner.expires_at AS owner_expires_at,
  owner.state AS owner_state,
  owner.revoked_at AS owner_revoked_at,
  owner.revocation_reason AS owner_revocation_reason,
  ledger.device_id AS ledger_device_id,
  ledger.device_secret_hash AS ledger_device_secret_hash,
  ledger.schema_version AS ledger_schema_version,
  ledger.policy_version AS ledger_policy_version,
  ledger.authorization_basis AS ledger_authorization_basis,
  ledger.expires_at AS ledger_expires_at,
  ledger.state AS ledger_state,
  ledger.revoked_at AS ledger_revoked_at,
  ledger.revocation_reason AS ledger_revocation_reason,
  device.id AS device_id,
  device.participant_id AS device_participant_id,
  device.authority_kind AS device_authority_kind,
  device.accountless_enrollment_device_id AS device_enrollment_device_id,
  device.secret_hash AS device_secret_hash,
  device.paired_via_pairing_id AS device_paired_via_pairing_id,
  device.social_verified_at AS device_social_verified_at,
  device.expires_at AS device_expires_at,
  device.state AS device_state,
  device.revoked_at AS device_revoked_at,
  grant_row.enrollment_device_id AS grant_enrollment_device_id,
  grant_row.participant_id AS grant_participant_id,
  grant_row.device_credential_id AS grant_device_credential_id,
  grant_row.telemetry_schema_version AS grant_telemetry_schema_version,
  grant_row.field_dictionary_version AS grant_field_dictionary_version,
  grant_row.privacy_contract_version AS grant_privacy_contract_version,
  grant_row.expires_at AS grant_expires_at,
  grant_row.state AS grant_state,
  grant_row.revoked_at AS grant_revoked_at,
  grant_row.revocation_reason AS grant_revocation_reason,
  head.participant_id AS head_participant_id,
  head.generation_id AS head_generation_id,
  head.revision AS head_revision,
  domain.id AS domain_id,
  domain.participant_id AS domain_participant_id,
  domain.device_id AS domain_device_id,
  CASE WHEN
    participant.id = retained.participant_id
    AND participant.owner_kind = 'accountless' AND participant.state = 'active'
    AND owner.participant_id = retained.participant_id
    AND owner.enrollment_device_id = retained.enrollment_device_id
    AND owner.device_credential_id = retained.device_credential_id
    AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
    AND ledger.device_id = retained.enrollment_device_id
    AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
    AND device.id = retained.device_credential_id
    AND device.participant_id = retained.participant_id
    AND device.state = 'revoked' AND device.authority_kind = 'accountless'
    AND grant_row.enrollment_device_id = retained.enrollment_device_id
    AND grant_row.participant_id = retained.participant_id
    AND grant_row.device_credential_id = retained.device_credential_id
    AND grant_row.state = 'revoked' AND grant_row.revocation_reason = 'user_opt_out'
    AND owner.revoked_at = retained.retained_at
    AND ledger.revoked_at = retained.retained_at
    AND device.revoked_at = retained.retained_at
    AND grant_row.revoked_at = retained.retained_at
    AND device.id = ledger.device_id
    AND device.accountless_enrollment_device_id = ledger.device_id
    AND device.paired_via_pairing_id IS NULL
    AND device.social_verified_at IS NULL
    AND device.secret_hash = ledger.device_secret_hash
    AND ledger.schema_version = 'accountless-enrollment-v0.1'
    AND ledger.policy_version = 'accountless-opt-out-v1'
    AND ledger.authorization_basis = 'accountless-policy-v1'
    AND owner.policy_version = ledger.policy_version
    AND owner.authorization_basis = ledger.authorization_basis
    AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
    AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
    AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
    AND owner.expires_at = ledger.expires_at
    AND device.expires_at = ledger.expires_at
    AND grant_row.expires_at = ledger.expires_at
    AND head.participant_id = retained.participant_id
    AND head.generation_id = retained.generation_id
    AND head.revision = retained.head_revision
    AND domain.id = retained.generation_id
    AND domain.participant_id = retained.participant_id
    AND domain.device_id = retained.device_credential_id
  THEN 1 ELSE 0 END AS is_eligible
FROM accountless_public_history_retention retained
LEFT JOIN participants participant
  ON participant.id = retained.participant_id
LEFT JOIN accountless_upload_owners owner
  ON owner.participant_id = retained.participant_id
 AND owner.enrollment_device_id = retained.enrollment_device_id
 AND owner.device_credential_id = retained.device_credential_id
LEFT JOIN accountless_enrollment_ledger ledger
  ON ledger.device_id = retained.enrollment_device_id
LEFT JOIN device_credentials device
  ON device.id = retained.device_credential_id
LEFT JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = retained.enrollment_device_id
 AND grant_row.participant_id = retained.participant_id
 AND grant_row.device_credential_id = retained.device_credential_id
LEFT JOIN telemetry_v11_domain_heads head
  ON head.participant_id = retained.participant_id
LEFT JOIN telemetry_v11_domains domain
  ON domain.id = retained.generation_id;

CREATE TABLE accountless_history_transfer_rows (
  run_id TEXT NOT NULL REFERENCES accountless_history_transfer_runs(run_id),
  participant_id TEXT NOT NULL,
  marker_enrollment_device_id TEXT NOT NULL,
  marker_device_credential_id TEXT NOT NULL,
  marker_generation_id TEXT NOT NULL,
  marker_head_revision INTEGER NOT NULL CHECK (marker_head_revision > 0),
  marker_retained_at TEXT NOT NULL,
  participant_owner_kind TEXT NOT NULL,
  participant_state TEXT NOT NULL,
  owner_participant_id TEXT NOT NULL,
  owner_enrollment_device_id TEXT NOT NULL,
  owner_device_credential_id TEXT NOT NULL,
  owner_policy_version TEXT NOT NULL,
  owner_authorization_basis TEXT NOT NULL,
  owner_expires_at TEXT NOT NULL,
  owner_state TEXT NOT NULL,
  owner_revoked_at TEXT NOT NULL,
  owner_revocation_reason TEXT NOT NULL,
  ledger_device_id TEXT NOT NULL,
  ledger_device_secret_hash BLOB NOT NULL CHECK (length(ledger_device_secret_hash) = 32),
  ledger_schema_version TEXT NOT NULL,
  ledger_policy_version TEXT NOT NULL,
  ledger_authorization_basis TEXT NOT NULL,
  ledger_expires_at TEXT NOT NULL,
  ledger_state TEXT NOT NULL,
  ledger_revoked_at TEXT NOT NULL,
  ledger_revocation_reason TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_participant_id TEXT NOT NULL,
  device_authority_kind TEXT NOT NULL,
  device_enrollment_device_id TEXT NOT NULL,
  device_secret_hash BLOB NOT NULL CHECK (length(device_secret_hash) = 32),
  device_paired_via_pairing_id TEXT,
  device_social_verified_at TEXT,
  device_expires_at TEXT NOT NULL,
  device_state TEXT NOT NULL,
  device_revoked_at TEXT NOT NULL,
  grant_enrollment_device_id TEXT NOT NULL,
  grant_participant_id TEXT NOT NULL,
  grant_device_credential_id TEXT NOT NULL,
  grant_telemetry_schema_version TEXT NOT NULL,
  grant_field_dictionary_version TEXT NOT NULL,
  grant_privacy_contract_version TEXT NOT NULL,
  grant_expires_at TEXT NOT NULL,
  grant_state TEXT NOT NULL,
  grant_revoked_at TEXT NOT NULL,
  grant_revocation_reason TEXT NOT NULL,
  head_participant_id TEXT NOT NULL,
  head_generation_id TEXT NOT NULL,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  domain_id TEXT NOT NULL,
  domain_participant_id TEXT NOT NULL,
  domain_device_id TEXT NOT NULL,
  PRIMARY KEY (run_id, participant_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX accountless_history_transfer_rows_keyset
  ON accountless_history_transfer_rows(run_id, participant_id);

CREATE TABLE accountless_history_transfer_row_digests (
  run_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  row_sha256 TEXT NOT NULL CHECK (
    length(row_sha256) = 64 AND row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (run_id, participant_id),
  FOREIGN KEY (run_id, participant_id)
    REFERENCES accountless_history_transfer_rows(run_id, participant_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE accountless_history_transfer_pages (
  run_id TEXT NOT NULL REFERENCES accountless_history_transfer_runs(run_id),
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  after_participant_id TEXT NOT NULL,
  through_participant_id TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 500),
  page_sha256 TEXT NOT NULL CHECK (
    length(page_sha256) = 64 AND page_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (run_id, page_number),
  UNIQUE (run_id, after_participant_id),
  CHECK (through_participant_id > after_participant_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER accountless_history_transfer_run_transition
BEFORE UPDATE ON accountless_history_transfer_runs
WHEN NOT (
  (OLD.state = 'capturing' AND NEW.state IN ('sealed', 'invalidated')
    AND NEW.manifest_sha256 IS NULL AND NEW.page_count = 0)
  OR (OLD.state IN ('sealed', 'extracted') AND NEW.state = 'invalidated'
    AND NEW.candidate_count = OLD.candidate_count
    AND NEW.row_count = OLD.row_count
    AND NEW.invalid_marker_count = OLD.invalid_marker_count
    AND NEW.migration_count = OLD.migration_count
    AND NEW.manifest_sha256 IS OLD.manifest_sha256
    AND NEW.page_count = OLD.page_count)
  OR (OLD.state = 'sealed' AND NEW.state = 'extracted'
    AND NEW.candidate_count = OLD.candidate_count
    AND NEW.row_count = OLD.row_count
    AND NEW.invalid_marker_count = OLD.invalid_marker_count
    AND NEW.migration_count = OLD.migration_count
    AND NEW.manifest_sha256 IS NOT NULL)
  OR (OLD.state IN ('sealed', 'extracted') AND NEW.state = 'aborted'
    AND NEW.candidate_count = OLD.candidate_count
    AND NEW.row_count = OLD.row_count
    AND NEW.invalid_marker_count = OLD.invalid_marker_count
    AND NEW.migration_count = OLD.migration_count
    AND NEW.manifest_sha256 IS OLD.manifest_sha256
    AND NEW.page_count = OLD.page_count)
)
OR NEW.run_id IS NOT OLD.run_id
OR NEW.source_revision IS NOT OLD.source_revision
OR NEW.latest_migration_name IS NOT OLD.latest_migration_name
OR NEW.snapshot_at IS NOT OLD.snapshot_at
BEGIN
  SELECT RAISE(ABORT, 'accountless_history_transfer_run_immutable');
END;

CREATE TRIGGER accountless_history_transfer_receipt_immutable
BEFORE UPDATE ON accountless_history_transfer_migration_receipts
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_receipt_immutable'); END;
CREATE TRIGGER accountless_history_transfer_receipt_delete_guard
BEFORE DELETE ON accountless_history_transfer_migration_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = OLD.run_id AND state IN ('invalidated', 'aborted')
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_receipt_immutable'); END;
CREATE TRIGGER accountless_history_transfer_receipt_insert_guard
BEFORE INSERT ON accountless_history_transfer_migration_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = NEW.run_id AND state = 'capturing'
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_run_not_capturing'); END;

CREATE TRIGGER accountless_history_transfer_row_insert_guard
BEFORE INSERT ON accountless_history_transfer_rows
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = NEW.run_id AND state = 'capturing'
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_run_not_capturing'); END;
CREATE TRIGGER accountless_history_transfer_rows_immutable
BEFORE UPDATE ON accountless_history_transfer_rows
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_rows_immutable'); END;
CREATE TRIGGER accountless_history_transfer_rows_delete_guard
BEFORE DELETE ON accountless_history_transfer_rows
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = OLD.run_id AND state IN ('invalidated', 'aborted')
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_rows_immutable'); END;

CREATE TRIGGER accountless_history_transfer_digest_insert_guard
BEFORE INSERT ON accountless_history_transfer_row_digests
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = NEW.run_id AND state = 'sealed'
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_run_not_sealed'); END;
CREATE TRIGGER accountless_history_transfer_digests_immutable
BEFORE UPDATE ON accountless_history_transfer_row_digests
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_digests_immutable'); END;
CREATE TRIGGER accountless_history_transfer_digests_delete_guard
BEFORE DELETE ON accountless_history_transfer_row_digests
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = OLD.run_id AND state IN ('invalidated', 'aborted')
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_digests_immutable'); END;

CREATE TRIGGER accountless_history_transfer_page_insert_guard
BEFORE INSERT ON accountless_history_transfer_pages
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = NEW.run_id AND state = 'sealed'
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_run_not_sealed'); END;
CREATE TRIGGER accountless_history_transfer_pages_immutable
BEFORE UPDATE ON accountless_history_transfer_pages
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_pages_immutable'); END;
CREATE TRIGGER accountless_history_transfer_pages_delete_guard
BEFORE DELETE ON accountless_history_transfer_pages
WHEN NOT EXISTS (
  SELECT 1 FROM accountless_history_transfer_runs
   WHERE run_id = OLD.run_id AND state IN ('invalidated', 'aborted')
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_transfer_pages_immutable'); END;

-- Invalidated or explicitly aborted artifacts are no longer safe/useful to
-- transfer. Purge the copied proof and identifier-bearing checkpoints while
-- retaining a digest-free run disposition for operator reconciliation.
CREATE TRIGGER accountless_history_transfer_terminal_cleanup
AFTER UPDATE OF state ON accountless_history_transfer_runs
WHEN OLD.state IN ('capturing', 'sealed', 'extracted')
 AND NEW.state IN ('invalidated', 'aborted')
BEGIN
  DELETE FROM accountless_history_transfer_pages WHERE run_id = NEW.run_id;
  DELETE FROM accountless_history_transfer_row_digests WHERE run_id = NEW.run_id;
  DELETE FROM accountless_history_transfer_rows WHERE run_id = NEW.run_id;
  DELETE FROM accountless_history_transfer_migration_receipts WHERE run_id = NEW.run_id;
END;

-- Marker creation/removal can add or remove a source owner from the retained
-- set, so either invalidates every open snapshot, even for a different owner.
CREATE TRIGGER accountless_history_transfer_marker_insert
AFTER INSERT ON accountless_public_history_retention
BEGIN
  UPDATE accountless_history_transfer_control
     SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs
     SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_marker_delete
AFTER DELETE ON accountless_public_history_retention
BEGIN
  UPDATE accountless_history_transfer_control
     SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs
     SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

-- Participant status/owner kind are part of the retained eligibility proof.
CREATE TRIGGER accountless_history_transfer_participant_update
AFTER UPDATE OF owner_kind, state ON participants
WHEN (OLD.owner_kind IS NOT NEW.owner_kind OR OLD.state IS NOT NEW.state)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
               WHERE participant_id IN (OLD.id, NEW.id))
   OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
               WHERE participant_id IN (OLD.id, NEW.id)))
BEGIN
  UPDATE accountless_history_transfer_control
     SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs
     SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_participant_delete
AFTER DELETE ON participants
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
              WHERE participant_id = OLD.id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
              WHERE participant_id = OLD.id)
BEGIN
  UPDATE accountless_history_transfer_control
     SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs
     SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

-- Changes to owners, enrollment ledger, credentials, and v1.1 grants can
-- alter the proof. Ignore unrelated accountless/social rows with no retained
-- marker, while including snapshot keys so a terminal cascade is still seen.
CREATE TRIGGER accountless_history_transfer_owner_insert
AFTER INSERT ON accountless_upload_owners
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id
     OR enrollment_device_id = NEW.enrollment_device_id
     OR device_credential_id = NEW.device_credential_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id
     OR marker_enrollment_device_id = NEW.enrollment_device_id
     OR marker_device_credential_id = NEW.device_credential_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_owner_update
AFTER UPDATE OF participant_id, enrollment_device_id, device_credential_id,
  policy_version, authorization_basis, expires_at, state, revoked_at, revocation_reason
ON accountless_upload_owners
WHEN (OLD.participant_id IS NOT NEW.participant_id
 OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id
 OR OLD.device_credential_id IS NOT NEW.device_credential_id
 OR OLD.policy_version IS NOT NEW.policy_version
 OR OLD.authorization_basis IS NOT NEW.authorization_basis
 OR OLD.expires_at IS NOT NEW.expires_at OR OLD.state IS NOT NEW.state
 OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR enrollment_device_id IN (OLD.enrollment_device_id, NEW.enrollment_device_id)
     OR device_credential_id IN (OLD.device_credential_id, NEW.device_credential_id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR marker_enrollment_device_id IN (OLD.enrollment_device_id, NEW.enrollment_device_id)
     OR marker_device_credential_id IN (OLD.device_credential_id, NEW.device_credential_id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_owner_delete
AFTER DELETE ON accountless_upload_owners
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id
     OR enrollment_device_id = OLD.enrollment_device_id
     OR device_credential_id = OLD.device_credential_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id
     OR marker_enrollment_device_id = OLD.enrollment_device_id
     OR marker_device_credential_id = OLD.device_credential_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_ledger_insert
AFTER INSERT ON accountless_enrollment_ledger
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE enrollment_device_id = NEW.device_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE marker_enrollment_device_id = NEW.device_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_ledger_update
AFTER UPDATE OF device_id, device_secret_hash, schema_version, policy_version,
  authorization_basis, expires_at, state, revoked_at, revocation_reason
ON accountless_enrollment_ledger
WHEN (OLD.device_id IS NOT NEW.device_id
 OR OLD.device_secret_hash IS NOT NEW.device_secret_hash
 OR OLD.schema_version IS NOT NEW.schema_version
 OR OLD.policy_version IS NOT NEW.policy_version
 OR OLD.authorization_basis IS NOT NEW.authorization_basis
 OR OLD.expires_at IS NOT NEW.expires_at OR OLD.state IS NOT NEW.state
 OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE enrollment_device_id IN (OLD.device_id, NEW.device_id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE marker_enrollment_device_id IN (OLD.device_id, NEW.device_id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_ledger_delete
AFTER DELETE ON accountless_enrollment_ledger
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE enrollment_device_id = OLD.device_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE marker_enrollment_device_id = OLD.device_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_device_insert
AFTER INSERT ON device_credentials
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id OR device_credential_id = NEW.id
     OR enrollment_device_id = NEW.accountless_enrollment_device_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id OR marker_device_credential_id = NEW.id
     OR marker_enrollment_device_id = NEW.accountless_enrollment_device_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_device_update
AFTER UPDATE OF id, participant_id, authority_kind, paired_via_pairing_id,
  accountless_enrollment_device_id, secret_hash, state, expires_at, revoked_at,
  social_verified_at
ON device_credentials
WHEN (OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id
 OR OLD.authority_kind IS NOT NEW.authority_kind
 OR OLD.paired_via_pairing_id IS NOT NEW.paired_via_pairing_id
 OR OLD.accountless_enrollment_device_id IS NOT NEW.accountless_enrollment_device_id
 OR OLD.secret_hash IS NOT NEW.secret_hash OR OLD.state IS NOT NEW.state
 OR OLD.expires_at IS NOT NEW.expires_at OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.social_verified_at IS NOT NEW.social_verified_at)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR device_credential_id IN (OLD.id, NEW.id)
     OR enrollment_device_id IN (OLD.accountless_enrollment_device_id, NEW.accountless_enrollment_device_id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR marker_device_credential_id IN (OLD.id, NEW.id)
     OR marker_enrollment_device_id IN (OLD.accountless_enrollment_device_id, NEW.accountless_enrollment_device_id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_device_delete
AFTER DELETE ON device_credentials
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id OR device_credential_id = OLD.id
     OR enrollment_device_id = OLD.accountless_enrollment_device_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id OR marker_device_credential_id = OLD.id
     OR marker_enrollment_device_id = OLD.accountless_enrollment_device_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_grant_insert
AFTER INSERT ON accountless_v11_device_authorizations
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id
     OR enrollment_device_id = NEW.enrollment_device_id
     OR device_credential_id = NEW.device_credential_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id
     OR marker_enrollment_device_id = NEW.enrollment_device_id
     OR marker_device_credential_id = NEW.device_credential_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_grant_update
AFTER UPDATE OF enrollment_device_id, participant_id, device_credential_id,
  telemetry_schema_version, field_dictionary_version, privacy_contract_version,
  expires_at, state, revoked_at, revocation_reason
ON accountless_v11_device_authorizations
WHEN (OLD.enrollment_device_id IS NOT NEW.enrollment_device_id
 OR OLD.participant_id IS NOT NEW.participant_id
 OR OLD.device_credential_id IS NOT NEW.device_credential_id
 OR OLD.telemetry_schema_version IS NOT NEW.telemetry_schema_version
 OR OLD.field_dictionary_version IS NOT NEW.field_dictionary_version
 OR OLD.privacy_contract_version IS NOT NEW.privacy_contract_version
 OR OLD.expires_at IS NOT NEW.expires_at OR OLD.state IS NOT NEW.state
 OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR enrollment_device_id IN (OLD.enrollment_device_id, NEW.enrollment_device_id)
     OR device_credential_id IN (OLD.device_credential_id, NEW.device_credential_id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR marker_enrollment_device_id IN (OLD.enrollment_device_id, NEW.enrollment_device_id)
     OR marker_device_credential_id IN (OLD.device_credential_id, NEW.device_credential_id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_grant_delete
AFTER DELETE ON accountless_v11_device_authorizations
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id
     OR enrollment_device_id = OLD.enrollment_device_id
     OR device_credential_id = OLD.device_credential_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id
     OR marker_enrollment_device_id = OLD.enrollment_device_id
     OR marker_device_credential_id = OLD.device_credential_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_head_insert
AFTER INSERT ON telemetry_v11_domain_heads
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id OR generation_id = NEW.generation_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id OR marker_generation_id = NEW.generation_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_head_update
AFTER UPDATE OF participant_id, generation_id, revision ON telemetry_v11_domain_heads
WHEN (OLD.participant_id IS NOT NEW.participant_id
 OR OLD.generation_id IS NOT NEW.generation_id OR OLD.revision IS NOT NEW.revision)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR generation_id IN (OLD.generation_id, NEW.generation_id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR marker_generation_id IN (OLD.generation_id, NEW.generation_id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_head_delete
AFTER DELETE ON telemetry_v11_domain_heads
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id OR generation_id = OLD.generation_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id OR marker_generation_id = OLD.generation_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_domain_insert
AFTER INSERT ON telemetry_v11_domains
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id OR device_credential_id = NEW.device_id
     OR generation_id = NEW.id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id OR marker_device_credential_id = NEW.device_id
     OR marker_generation_id = NEW.id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_domain_update
AFTER UPDATE OF id, participant_id, device_id ON telemetry_v11_domains
WHEN (OLD.id IS NOT NEW.id OR OLD.participant_id IS NOT NEW.participant_id
 OR OLD.device_id IS NOT NEW.device_id)
 AND (EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR device_credential_id IN (OLD.device_id, NEW.device_id)
     OR generation_id IN (OLD.id, NEW.id))
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id IN (OLD.participant_id, NEW.participant_id)
     OR marker_device_credential_id IN (OLD.device_id, NEW.device_id)
     OR marker_generation_id IN (OLD.id, NEW.id)))
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_domain_delete
AFTER DELETE ON telemetry_v11_domains
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id OR device_credential_id = OLD.device_id
     OR generation_id = OLD.id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id OR marker_device_credential_id = OLD.device_id
     OR marker_generation_id = OLD.id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
