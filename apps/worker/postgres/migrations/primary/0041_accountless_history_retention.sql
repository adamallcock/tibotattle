-- A prospective, content-free pin for the exact accepted accountless v1.1
-- head at ordinary opt-out. There is deliberately no backfill: prior
-- revocations without a marker do not gain retained public authority.
CREATE TABLE accountless_public_history_retention (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  enrollment_device_id text NOT NULL UNIQUE,
  device_credential_id text NOT NULL UNIQUE,
  generation_id text NOT NULL,
  head_revision integer NOT NULL CHECK (head_revision > 0),
  retained_at timestamptz NOT NULL
);

-- Only a current, exact public accountless v1.1 head can be pinned. The
-- disconnect transaction inserts this row before it revokes any upload
-- authority, matching the D1 opt-out marker's proof boundary.
CREATE FUNCTION accountless_public_history_retention_insert_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
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
    RAISE EXCEPTION 'accountless_history_retention_unavailable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_public_history_retention_insert_guard
  BEFORE INSERT ON accountless_public_history_retention
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_retention_insert_guard();

-- The marker is immutable. Explicitly retiring it withdraws the owner link;
-- participant erasure reaches this trigger only after its link is already
-- terminal and then cascades the marker with the participant.
CREATE FUNCTION accountless_public_history_retention_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'accountless_history_retention_immutable' USING ERRCODE = 'P1005';
  END IF;
  UPDATE storage_v11_owner_links
     SET state = 'withdrawn'
   WHERE participant_id = OLD.participant_id AND state = 'active';
  RETURN OLD;
END;
$$;
CREATE TRIGGER accountless_public_history_retention_immutability_guard
  BEFORE UPDATE OR DELETE ON accountless_public_history_retention
  FOR EACH ROW EXECUTE FUNCTION accountless_public_history_retention_immutability_guard();
