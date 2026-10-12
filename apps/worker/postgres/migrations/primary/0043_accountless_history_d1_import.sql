-- Add an offline, artifact-bound D1 source kind while retaining the
-- version-42 synthetic permit and its replay path. No source data is backfilled.
ALTER TABLE accountless_public_history_import_runs
  DROP CONSTRAINT accountless_public_history_import_runs_source_kind_check,
  DROP CONSTRAINT accountless_public_history_impor_target_migration_version_check;
ALTER TABLE accountless_public_history_import_runs
  ADD CONSTRAINT accountless_public_history_import_runs_source_kind_check
    CHECK (source_kind IN (
      'synthetic-retention-fixture-v1',
      'cloudflare-d1-accountless-retention-snapshot-v1'
    )),
  ADD CONSTRAINT accountless_public_history_impor_target_migration_version_check
    CHECK (
      (target_migration_version = 42 AND source_kind = 'synthetic-retention-fixture-v1')
      OR (target_migration_version = 43 AND source_kind IN (
        'synthetic-retention-fixture-v1',
        'cloudflare-d1-accountless-retention-snapshot-v1'
      ))
    );

ALTER TABLE accountless_public_history_import_runs
  ADD COLUMN source_run_id text,
  ADD COLUMN source_revision bigint,
  ADD COLUMN source_mapping_sha256 text,
  ADD COLUMN source_fence_state text NOT NULL DEFAULT 'not_required';
ALTER TABLE accountless_public_history_import_runs
  ADD CONSTRAINT accountless_public_history_import_runs_source_fence_state_check
    CHECK (source_fence_state IN ('not_required', 'pending', 'reconciled', 'invalidated')),
  ADD CONSTRAINT accountless_public_history_import_runs_source_fence_metadata_check
    CHECK (
      (source_kind = 'synthetic-retention-fixture-v1'
       AND source_run_id IS NULL AND source_revision IS NULL AND source_mapping_sha256 IS NULL
       AND source_fence_state = 'not_required')
      OR (source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
       AND source_run_id IS NOT NULL AND length(source_run_id) BETWEEN 1 AND 120
       AND source_revision IS NOT NULL AND source_revision >= 0
       AND source_mapping_sha256 ~ '^[0-9a-f]{64}$'
       AND source_fence_state IN ('pending', 'reconciled', 'invalidated'))
    );

CREATE TABLE accountless_public_history_import_fence_receipts (
  transfer_id text NOT NULL REFERENCES accountless_public_history_import_runs(transfer_id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  result_state text NOT NULL CHECK (result_state = 'invalidated'),
  source_run_id text NOT NULL CHECK (length(source_run_id) BETWEEN 1 AND 120),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_mapping_sha256 text NOT NULL CHECK (source_mapping_sha256 ~ '^[0-9a-f]{64}$'),
  invalidation_code text NOT NULL CHECK (invalidation_code IN (
    'SOURCE_MIGRATION_RECEIPT_MISMATCH', 'SOURCE_MARKER_INELIGIBLE',
    'SOURCE_AUTHORITY_REVISION_CHANGED', 'SOURCE_SNAPSHOT_ABORTED', 'SOURCE_SNAPSHOT_INVALIDATED'
  )),
  proof_sha256 text NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transfer_id, sequence),
  UNIQUE (transfer_id, proof_sha256),
  CHECK (sequence = 1)
);

CREATE FUNCTION accountless_public_history_import_fence_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run accountless_public_history_import_runs%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'accountless_history_import_fence_receipt_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT * INTO run FROM accountless_public_history_import_runs
   WHERE transfer_id = NEW.transfer_id AND status = 'complete'
     AND source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
     AND target_schema = current_schema()
   FOR UPDATE;
  IF NOT FOUND
     OR NEW.source_run_id <> run.source_run_id
     OR NEW.source_revision <> run.source_revision
     OR NEW.source_artifact_sha256 <> run.source_artifact_sha256
     OR NEW.source_mapping_sha256 <> run.source_mapping_sha256
     OR current_setting('tibotattle.accountless_history_fence_invalidate', true)
       IS DISTINCT FROM NEW.transfer_id || E'\n' || NEW.result_state || E'\n' || NEW.proof_sha256 THEN
    RAISE EXCEPTION 'accountless_history_import_fence_receipt_refused' USING ERRCODE = 'P1005';
  END IF;
  IF EXISTS (SELECT 1 FROM accountless_public_history_import_fence_receipts
              WHERE transfer_id = NEW.transfer_id) THEN
    RAISE EXCEPTION 'accountless_history_import_fence_receipt_sequence_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF run.source_fence_state <> 'pending' THEN
    RAISE EXCEPTION 'accountless_history_import_fence_invalidation_refused' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_public_history_import_fence_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accountless_public_history_import_fence_receipts
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_import_fence_receipt_guard();
CREATE TRIGGER accountless_public_history_import_fence_receipts_no_truncate
  BEFORE TRUNCATE ON accountless_public_history_import_fence_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION accountless_public_history_import_no_truncate();

CREATE OR REPLACE FUNCTION accountless_public_history_import_run_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  page_count bigint;
  imported_count bigint;
  imported_pages bigint;
  claim_count bigint;
  expected_page_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM collection_controls controls
     WHERE controls.singleton = 1
       AND controls.control_state = 'degraded'
       AND controls.enrollment_enabled = false
       AND controls.publication_enabled = false
     FOR SHARE;
    IF NEW.status <> 'importing'
       OR NEW.target_schema <> current_schema()
       OR (NEW.source_kind = 'synthetic-retention-fixture-v1'
           AND NEW.source_fence_state <> 'not_required')
       OR (NEW.source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
           AND NEW.source_fence_state <> 'pending')
       OR NOT FOUND THEN
      RAISE EXCEPTION 'accountless_history_import_permit_refused' USING ERRCODE = 'P1005';
    END IF;
    PERFORM 1 FROM _tibotattle_migration_history receipt
     WHERE receipt.version = NEW.target_migration_version
       AND receipt.checksum_sha256 = NEW.target_migration_sha256
       AND ((NEW.target_migration_version = 42
             AND receipt.name = '0042_accountless_history_retention_import.sql')
         OR (NEW.target_migration_version = 43
             AND receipt.name = '0043_accountless_history_d1_import.sql'));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'accountless_history_import_migration_receipt_refused' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'complete'
     AND OLD.source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
     AND OLD.source_fence_state = 'pending'
     AND NEW.source_fence_state = 'invalidated'
     AND (to_jsonb(NEW) - ARRAY['source_fence_state', 'updated_at'])
       IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['source_fence_state', 'updated_at'])
     AND current_setting('tibotattle.accountless_history_fence_invalidate', true) IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM accountless_public_history_import_fence_receipts receipt
        WHERE receipt.transfer_id = OLD.transfer_id
          AND receipt.result_state = NEW.source_fence_state
          AND current_setting('tibotattle.accountless_history_fence_invalidate', true)
            = OLD.transfer_id || E'\n' || NEW.source_fence_state || E'\n' || receipt.proof_sha256
          AND receipt.sequence = (SELECT max(latest.sequence)
            FROM accountless_public_history_import_fence_receipts latest
            WHERE latest.transfer_id = OLD.transfer_id)
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     OR OLD.status <> 'importing'
     OR NEW.status NOT IN ('complete', 'aborted')
     OR (to_jsonb(NEW) - ARRAY['status', 'target_manifest_sha256', 'updated_at', 'completed_at', 'aborted_at'])
       IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'target_manifest_sha256', 'updated_at', 'completed_at', 'aborted_at']) THEN
    RAISE EXCEPTION 'accountless_history_import_run_immutable' USING ERRCODE = 'P1005';
  END IF;

  IF NEW.status = 'complete' THEN
    SELECT count(*), COALESCE(sum(page.row_count), 0)
      INTO page_count, imported_pages
      FROM accountless_public_history_import_pages page
     WHERE page.transfer_id = OLD.transfer_id;
    SELECT count(*) INTO imported_count
      FROM accountless_public_history_import_claims claim
     WHERE claim.transfer_id = OLD.transfer_id AND claim.consumed_at IS NOT NULL;
    SELECT count(*) INTO claim_count
      FROM accountless_public_history_import_claims claim
     WHERE claim.transfer_id = OLD.transfer_id;
    IF OLD.source_row_count = 0 THEN
      expected_page_count := 0;
    ELSE
      expected_page_count := ceil(OLD.source_row_count::numeric / NEW.page_size)::bigint;
    END IF;
    IF NEW.completed_at IS NULL OR NEW.aborted_at IS NOT NULL
       OR NEW.target_manifest_sha256 IS NULL
       OR claim_count <> OLD.source_row_count
       OR imported_count <> OLD.source_row_count
       OR imported_pages <> OLD.source_row_count
       OR (SELECT COALESCE(max(page.cumulative_row_count), 0)
             FROM accountless_public_history_import_pages page
            WHERE page.transfer_id = OLD.transfer_id) <> OLD.source_row_count
       OR page_count <> expected_page_count THEN
      RAISE EXCEPTION 'accountless_history_import_incomplete' USING ERRCODE = 'P1005';
    END IF;
  ELSIF NEW.completed_at IS NOT NULL OR NEW.target_manifest_sha256 IS NOT NULL
        OR EXISTS (SELECT 1 FROM accountless_public_history_import_pages page
                    WHERE page.transfer_id = OLD.transfer_id)
        OR EXISTS (SELECT 1 FROM accountless_public_history_import_claims claim
                    WHERE claim.transfer_id = OLD.transfer_id) THEN
    RAISE EXCEPTION 'accountless_history_import_abort_refused' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION accountless_public_history_d1_fence_controls_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.control_state = 'operational' OR NEW.enrollment_enabled OR NEW.publication_enabled)
     AND EXISTS (
       SELECT 1 FROM accountless_public_history_import_runs run
        WHERE run.target_schema = current_schema()
          AND run.source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
          AND (run.status = 'importing'
            OR run.status = 'complete' AND run.source_fence_state <> 'reconciled')
     ) THEN
    RAISE EXCEPTION 'accountless_history_import_source_fence_unreconciled' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_public_history_d1_fence_controls_guard
  BEFORE UPDATE OF control_state, enrollment_enabled, publication_enabled ON collection_controls
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_d1_fence_controls_guard();

CREATE OR REPLACE FUNCTION accountless_public_history_retention_insert_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  claim accountless_public_history_import_claims%ROWTYPE;
  requested_transfer_id text;
  consumed_rows integer;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM participants participant
      JOIN accountless_upload_owners owner
        ON owner.participant_id = participant.id
      JOIN accountless_enrollment_ledger ledger
        ON ledger.device_id = owner.enrollment_device_id
      JOIN device_credentials device
        ON device.id = owner.device_credential_id
      JOIN accountless_v11_device_authorizations grant_row
        ON grant_row.enrollment_device_id = owner.enrollment_device_id
       AND grant_row.participant_id = owner.participant_id
       AND grant_row.device_credential_id = owner.device_credential_id
      JOIN telemetry_v11_domain_heads head
        ON head.participant_id = owner.participant_id
      JOIN telemetry_v11_domains domain
        ON domain.id = head.generation_id
     WHERE participant.id = NEW.participant_id
       AND participant.owner_kind = 'accountless' AND participant.state = 'active'
       AND owner.enrollment_device_id = NEW.enrollment_device_id
       AND owner.device_credential_id = NEW.device_credential_id
       AND owner.state = 'active' AND owner.revoked_at IS NULL
       AND owner.revocation_reason IS NULL
       AND ledger.state = 'active' AND ledger.revoked_at IS NULL
       AND ledger.revocation_reason IS NULL
       AND device.state = 'active' AND device.revoked_at IS NULL
       AND grant_row.state = 'active' AND grant_row.revoked_at IS NULL
       AND grant_row.revocation_reason IS NULL
       AND device.participant_id = participant.id
       AND device.authority_kind = 'accountless'
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
       AND head.generation_id = NEW.generation_id
       AND head.revision = NEW.head_revision
       AND domain.participant_id = participant.id
       AND domain.device_id = device.id
  ) THEN
    RETURN NEW;
  END IF;

  requested_transfer_id := current_setting('tibotattle.accountless_history_import', true);
  IF requested_transfer_id IS NULL OR requested_transfer_id = '' THEN
    RAISE EXCEPTION 'accountless_history_retention_unavailable' USING ERRCODE = 'P1005';
  END IF;

  SELECT expected.* INTO claim
    FROM accountless_public_history_import_claims expected
    JOIN accountless_public_history_import_runs run USING (transfer_id)
   WHERE expected.transfer_id = requested_transfer_id
     AND run.status = 'importing'
     AND run.target_schema = current_schema()
     AND ((run.target_migration_version = 42
           AND EXISTS (
             SELECT 1 FROM _tibotattle_migration_history receipt
              WHERE receipt.version = 42
                AND receipt.name = '0042_accountless_history_retention_import.sql'
                AND receipt.checksum_sha256 = run.target_migration_sha256
           ))
       OR (run.target_migration_version = 43
           AND EXISTS (
             SELECT 1 FROM _tibotattle_migration_history receipt
              WHERE receipt.version = 43
                AND receipt.name = '0043_accountless_history_d1_import.sql'
                AND receipt.checksum_sha256 = run.target_migration_sha256
           )))
     AND expected.consumed_at IS NULL
     AND expected.target_participant_id = NEW.participant_id
     AND expected.target_enrollment_device_id = NEW.enrollment_device_id
     AND expected.target_device_credential_id = NEW.device_credential_id
     AND expected.target_generation_id = NEW.generation_id
     AND expected.head_revision = NEW.head_revision
     AND expected.retained_at = NEW.retained_at
   FOR UPDATE OF expected, run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_claim_refused' USING ERRCODE = 'P1005';
  END IF;
  IF date_trunc('milliseconds', NEW.retained_at) IS DISTINCT FROM NEW.retained_at THEN
    RAISE EXCEPTION 'accountless_history_import_timestamp_precision_invalid' USING ERRCODE = 'P1005';
  END IF;

  -- Match the final D1 retained-owner predicate against the already imported
  -- PostgreSQL authority rows. The import never creates or repairs authority.
  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id
     AND participant.owner_kind = 'accountless' AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_identity_unavailable' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM accountless_upload_owners owner
   WHERE owner.participant_id = NEW.participant_id
     AND owner.enrollment_device_id = NEW.enrollment_device_id
     AND owner.device_credential_id = NEW.device_credential_id
     AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
     AND owner.revoked_at = NEW.retained_at
     AND owner.policy_version = 'accountless-opt-out-v1'
     AND owner.authorization_basis = 'accountless-policy-v1'
     AND owner.expires_at = claim.source_expires_at
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM accountless_enrollment_ledger ledger
   WHERE ledger.device_id = NEW.enrollment_device_id
     AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
     AND ledger.revoked_at = NEW.retained_at
     AND ledger.schema_version = 'accountless-enrollment-v0.1'
     AND ledger.policy_version = 'accountless-opt-out-v1'
     AND ledger.authorization_basis = 'accountless-policy-v1'
     AND ledger.expires_at = claim.source_expires_at
     AND ledger.device_secret_hash = claim.source_device_secret_hash
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM device_credentials device
   WHERE device.id = NEW.device_credential_id
     AND device.participant_id = NEW.participant_id
     AND device.authority_kind = 'accountless'
     AND device.accountless_enrollment_device_id = NEW.enrollment_device_id
     AND device.paired_via_pairing_id IS NULL
     AND device.social_verified_at IS NULL
     AND device.state = 'revoked' AND device.revoked_at = NEW.retained_at
     AND device.expires_at = claim.source_expires_at
     AND device.secret_hash = claim.source_device_secret_hash
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM accountless_v11_device_authorizations grant_row
   WHERE grant_row.enrollment_device_id = NEW.enrollment_device_id
     AND grant_row.participant_id = NEW.participant_id
     AND grant_row.device_credential_id = NEW.device_credential_id
     AND grant_row.state = 'revoked' AND grant_row.revocation_reason = 'user_opt_out'
     AND grant_row.revoked_at = NEW.retained_at
     AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
     AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
     AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
     AND grant_row.expires_at = claim.source_expires_at
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_authority_mismatch' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM telemetry_v11_domain_heads head
   JOIN telemetry_v11_domains domain
     ON domain.id = head.generation_id
    AND domain.participant_id = head.participant_id
   JOIN storage_v11_owner_links owner_link
     ON owner_link.participant_id = head.participant_id
    AND owner_link.generation_id = head.generation_id
    AND owner_link.head_revision = head.revision
    AND owner_link.state = 'active'
   WHERE head.participant_id = NEW.participant_id
     AND head.generation_id = NEW.generation_id
     AND head.revision = NEW.head_revision
     AND domain.device_id = NEW.device_credential_id
   FOR SHARE OF head, domain, owner_link;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_head_mismatch' USING ERRCODE = 'P1005';
  END IF;

  PERFORM set_config('tibotattle.accountless_history_import_consuming',
    claim.transfer_id || E'\n' || claim.source_participant_id, true);
  UPDATE accountless_public_history_import_claims
     SET consumed_at = clock_timestamp()
   WHERE transfer_id = claim.transfer_id
     AND source_participant_id = claim.source_participant_id
     AND consumed_at IS NULL;
  GET DIAGNOSTICS consumed_rows = ROW_COUNT;
  PERFORM set_config('tibotattle.accountless_history_import_consuming', '', true);
  IF consumed_rows <> 1 THEN
    RAISE EXCEPTION 'accountless_history_import_claim_reused' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
