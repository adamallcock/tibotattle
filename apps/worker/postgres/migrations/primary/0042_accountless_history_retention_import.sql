-- Import permits for exact accountless v1.1 opt-out retention markers that
-- existed before 0041. The normal active-owner insert remains unchanged; this
-- adds a sealed, one-row-at-a-time exception for a completed source snapshot.
-- No migration backfill is performed.

CREATE TABLE accountless_public_history_import_runs (
  transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 128),
  schema_version text NOT NULL
    CHECK (schema_version = 'accountless-public-history-retention-import-v1'),
  source_kind text NOT NULL
    CHECK (source_kind = 'synthetic-retention-fixture-v1'),
  target_schema text NOT NULL CHECK (target_schema ~ '^[a-z_][a-z0-9_]{0,62}$'),
  source_snapshot_id text NOT NULL CHECK (length(source_snapshot_id) BETWEEN 8 AND 256),
  source_fence_id text NOT NULL CHECK (length(source_fence_id) BETWEEN 8 AND 256),
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
  source_migration_receipts jsonb NOT NULL CHECK (jsonb_typeof(source_migration_receipts) = 'array'),
  target_migration_version integer NOT NULL CHECK (target_migration_version = 42),
  target_migration_sha256 text NOT NULL CHECK (target_migration_sha256 ~ '^[0-9a-f]{64}$'),
  page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('importing', 'complete', 'aborted')),
  target_manifest_sha256 text CHECK (target_manifest_sha256 IS NULL OR target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  aborted_at timestamptz,
  UNIQUE (target_schema, source_snapshot_id),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((status = 'aborted') = (aborted_at IS NOT NULL)),
  CHECK ((status = 'complete') = (target_manifest_sha256 IS NOT NULL))
);

CREATE TABLE accountless_public_history_import_claims (
  transfer_id text NOT NULL REFERENCES accountless_public_history_import_runs(transfer_id) ON DELETE RESTRICT,
  source_participant_id text NOT NULL CHECK (length(source_participant_id) BETWEEN 1 AND 256),
  source_enrollment_device_id text NOT NULL CHECK (length(source_enrollment_device_id) BETWEEN 1 AND 256),
  source_device_credential_id text NOT NULL CHECK (length(source_device_credential_id) BETWEEN 1 AND 256),
  source_generation_id text NOT NULL CHECK (length(source_generation_id) = 36),
  target_participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  target_enrollment_device_id text NOT NULL CHECK (length(target_enrollment_device_id) BETWEEN 1 AND 256),
  target_device_credential_id text NOT NULL CHECK (length(target_device_credential_id) BETWEEN 1 AND 256),
  target_generation_id text NOT NULL CHECK (length(target_generation_id) = 36),
  head_revision integer NOT NULL CHECK (head_revision > 0),
  retained_at timestamptz NOT NULL,
  source_row_sha256 text NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  source_expires_at timestamptz NOT NULL
    CHECK (date_trunc('milliseconds', source_expires_at) = source_expires_at),
  source_device_secret_hash bytea NOT NULL CHECK (octet_length(source_device_secret_hash) = 32),
  consumed_at timestamptz,
  PRIMARY KEY (transfer_id, source_participant_id),
  UNIQUE (transfer_id, target_participant_id),
  UNIQUE (transfer_id, target_enrollment_device_id),
  UNIQUE (transfer_id, target_device_credential_id)
);

CREATE TABLE accountless_public_history_import_pages (
  transfer_id text NOT NULL REFERENCES accountless_public_history_import_runs(transfer_id) ON DELETE RESTRICT,
  page_number integer NOT NULL CHECK (page_number > 0),
  first_source_participant_id text NOT NULL,
  last_source_participant_id text NOT NULL,
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 500),
  cumulative_row_count bigint NOT NULL CHECK (cumulative_row_count >= row_count),
  page_sha256 text NOT NULL CHECK (page_sha256 ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transfer_id, page_number),
  UNIQUE (transfer_id, last_source_participant_id),
  CHECK (first_source_participant_id <= last_source_participant_id)
);

CREATE FUNCTION accountless_public_history_import_run_guard()
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
       OR NOT FOUND THEN
      RAISE EXCEPTION 'accountless_history_import_permit_refused' USING ERRCODE = 'P1005';
    END IF;
    PERFORM 1 FROM _tibotattle_migration_history receipt
     WHERE receipt.version = NEW.target_migration_version
       AND receipt.name = '0042_accountless_history_retention_import.sql'
       AND receipt.checksum_sha256 = NEW.target_migration_sha256;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'accountless_history_import_migration_receipt_refused' USING ERRCODE = 'P1005';
    END IF;
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
CREATE TRIGGER accountless_public_history_import_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accountless_public_history_import_runs
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_import_run_guard();

CREATE FUNCTION accountless_public_history_import_claim_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run_id text;
  expected_rows bigint;
  claim_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT run.transfer_id, run.source_row_count INTO run_id, expected_rows
      FROM accountless_public_history_import_runs run
     WHERE run.transfer_id = NEW.transfer_id
       AND run.status = 'importing'
       AND run.target_schema = current_schema()
       AND current_setting('tibotattle.accountless_history_import', true) = run.transfer_id
     FOR UPDATE;
    IF run_id IS NULL THEN
      RAISE EXCEPTION 'accountless_history_import_claim_refused' USING ERRCODE = 'P1005';
    END IF;
    SELECT count(*) INTO claim_count FROM accountless_public_history_import_claims claim
     WHERE claim.transfer_id = NEW.transfer_id;
    IF claim_count >= expected_rows THEN
      RAISE EXCEPTION 'accountless_history_import_claim_count_exceeded' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND current_setting('tibotattle.accountless_history_import_consuming', true) =
       OLD.transfer_id || E'\n' || OLD.source_participant_id
     AND (to_jsonb(NEW) - 'consumed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'accountless_history_import_claim_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER accountless_public_history_import_claim_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accountless_public_history_import_claims
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_import_claim_guard();

CREATE FUNCTION accountless_public_history_import_page_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run accountless_public_history_import_runs%ROWTYPE;
  prior accountless_public_history_import_pages%ROWTYPE;
  consumed bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'accountless_history_import_page_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT * INTO run FROM accountless_public_history_import_runs
   WHERE transfer_id = NEW.transfer_id AND status = 'importing'
     AND target_schema = current_schema()
     AND current_setting('tibotattle.accountless_history_import', true) = transfer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accountless_history_import_page_refused' USING ERRCODE = 'P1005';
  END IF;
  SELECT * INTO prior FROM accountless_public_history_import_pages
   WHERE transfer_id = NEW.transfer_id ORDER BY page_number DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.page_number <> prior.page_number + 1
       OR NEW.first_source_participant_id <= prior.last_source_participant_id
       OR NEW.cumulative_row_count <> prior.cumulative_row_count + NEW.row_count THEN
      RAISE EXCEPTION 'accountless_history_import_page_sequence_invalid' USING ERRCODE = 'P1005';
    END IF;
  ELSIF NEW.page_number <> 1 OR NEW.cumulative_row_count <> NEW.row_count THEN
    RAISE EXCEPTION 'accountless_history_import_page_sequence_invalid' USING ERRCODE = 'P1005';
  END IF;
  SELECT count(*) INTO consumed FROM accountless_public_history_import_claims claim
   WHERE claim.transfer_id = NEW.transfer_id AND claim.consumed_at IS NOT NULL;
  IF consumed <> NEW.cumulative_row_count OR NEW.cumulative_row_count > run.source_row_count
     OR NEW.row_count > run.page_size THEN
    RAISE EXCEPTION 'accountless_history_import_page_count_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_public_history_import_page_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accountless_public_history_import_pages
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_import_page_guard();

-- An open marker-import run is deliberately confined to a degraded schema.
-- Do not permit an operator to enable enrollment or publication between its
-- bounded page transactions.
CREATE FUNCTION accountless_public_history_import_controls_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.control_state = 'operational' OR NEW.enrollment_enabled OR NEW.publication_enabled)
     AND EXISTS (
       SELECT 1 FROM accountless_public_history_import_runs run
        WHERE run.status = 'importing' AND run.target_schema = current_schema()
     ) THEN
    RAISE EXCEPTION 'accountless_history_import_controls_locked' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_public_history_import_controls_guard
  BEFORE UPDATE OF control_state, enrollment_enabled, publication_enabled ON collection_controls
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_import_controls_guard();

CREATE FUNCTION accountless_public_history_import_no_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'accountless_history_import_truncate_refused' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER accountless_public_history_import_runs_no_truncate
  BEFORE TRUNCATE ON accountless_public_history_import_runs
  FOR EACH STATEMENT EXECUTE FUNCTION accountless_public_history_import_no_truncate();
CREATE TRIGGER accountless_public_history_import_claims_no_truncate
  BEFORE TRUNCATE ON accountless_public_history_import_claims
  FOR EACH STATEMENT EXECUTE FUNCTION accountless_public_history_import_no_truncate();
CREATE TRIGGER accountless_public_history_import_pages_no_truncate
  BEFORE TRUNCATE ON accountless_public_history_import_pages
  FOR EACH STATEMENT EXECUTE FUNCTION accountless_public_history_import_no_truncate();
CREATE TRIGGER accountless_public_history_retention_no_truncate
  BEFORE TRUNCATE ON accountless_public_history_retention
  FOR EACH STATEMENT EXECUTE FUNCTION accountless_public_history_import_no_truncate();

-- Extend 0041's guard without disabling it. Current active-owner opt-outs keep
-- using the original predicate; only pre-existing exact D1 opt-outs can use a
-- one-use claim inside an importing run.
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
     AND run.target_migration_version = 42
     AND EXISTS (
       SELECT 1 FROM _tibotattle_migration_history receipt
        WHERE receipt.version = run.target_migration_version
          AND receipt.name = '0042_accountless_history_retention_import.sql'
          AND receipt.checksum_sha256 = run.target_migration_sha256
     )
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
