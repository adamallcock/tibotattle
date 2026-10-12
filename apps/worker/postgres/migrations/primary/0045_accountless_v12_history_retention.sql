-- D1 isolation 0011 (owner decision 2026-09-25) lets an ordinary opt-out
-- marker pin an accepted v1.2 head for an accountless device that has no v1.1
-- domain. Mirror that prospective rule here. The guard keeps its exact v1.1
-- branch and its artifact-bound import path unchanged, so an imported marker
-- still needs a v1.1 claim; importing a D1 v1.2 marker stays refused until a
-- separately reviewed import lane proves it. No row is backfilled: a device
-- revoked before this migration keeps its unretained state.

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

  -- A device with no v1.1 domain may pin its accepted v1.2 head instead, on
  -- the exact terms of D1 isolation 0011's active v1.2 public-source branch:
  -- the same active lease graph proved by the separate successor grant.
  IF EXISTS (
    SELECT 1
      FROM participants participant
      JOIN accountless_upload_owners owner
        ON owner.participant_id = participant.id
      JOIN accountless_enrollment_ledger ledger
        ON ledger.device_id = owner.enrollment_device_id
      JOIN device_credentials device
        ON device.id = owner.device_credential_id
      JOIN accountless_v12_device_authorizations successor
        ON successor.enrollment_device_id = owner.enrollment_device_id
       AND successor.participant_id = owner.participant_id
       AND successor.device_credential_id = owner.device_credential_id
      JOIN telemetry_v12_domain_heads head
        ON head.participant_id = owner.participant_id
      JOIN telemetry_v12_domains domain
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
       AND successor.state = 'active' AND successor.revoked_at IS NULL
       AND successor.revocation_reason IS NULL
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
       AND successor.schema_version = 'accountless-upload-owner-v1.2'
       AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
       AND successor.authorization_basis = 'accountless-policy-v1.2'
       AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
       AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
       AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
       AND owner.expires_at = ledger.expires_at
       AND device.expires_at = ledger.expires_at
       AND successor.expires_at = ledger.expires_at
       AND head.generation_id = NEW.generation_id
       AND head.revision = NEW.head_revision
       AND domain.participant_id = participant.id
       AND domain.device_id = device.id
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_v11_domains legacy_domain
          WHERE legacy_domain.participant_id = participant.id
            AND legacy_domain.device_id = device.id
       )
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
