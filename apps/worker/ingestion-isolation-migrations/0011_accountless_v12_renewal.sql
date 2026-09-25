-- Existing active v1.2 accountless grants follow an explicit owner-lease
-- renewal only when the old grant matched the complete old owner graph. The
-- application performs this update in the same D1 batch as the ledger CAS,
-- before advancing device, owner, and v1.1 expiry rows. No INSERT or revoked
-- grant transition is introduced here.
DROP TRIGGER accountless_v12_authorization_immutable;

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
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
  OR (NEW.expires_at IS NOT OLD.expires_at AND NOT (
    NEW.state = 'active'
    AND NEW.revoked_at IS NULL AND NEW.revocation_reason IS NULL
    AND NEW.expires_at > OLD.expires_at
    AND NEW.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at)
    AND EXISTS (
      SELECT 1
        FROM accountless_enrollment_ledger ledger
        JOIN accountless_upload_owners owner
          ON owner.enrollment_device_id = ledger.device_id
        JOIN device_credentials device ON device.id = owner.device_credential_id
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = ledger.device_id
         AND grant_row.participant_id = owner.participant_id
         AND grant_row.device_credential_id = device.id
       WHERE ledger.device_id = OLD.enrollment_device_id
         AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
         AND ledger.renewal_generation BETWEEN 1 AND 2147483647
         AND ledger.renewed_at IS NOT NULL
         AND ledger.expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', ledger.renewed_at, '+30 days')
         AND OLD.schema_version = 'accountless-upload-owner-v1.2'
         AND OLD.policy_version = 'accountless-telemetry-v1.2-policy-v1'
         AND OLD.authorization_basis = 'accountless-policy-v1.2'
         AND OLD.telemetry_schema_version = 'telemetry-contribution-v1.2'
         AND OLD.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
         AND OLD.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
         AND owner.participant_id = OLD.participant_id
         AND owner.device_credential_id = OLD.device_credential_id
         AND owner.state = 'active' AND owner.expires_at = OLD.expires_at
         AND device.participant_id = OLD.participant_id
         AND device.id = OLD.device_credential_id
         AND device.authority_kind = 'accountless'
         AND device.accountless_enrollment_device_id = OLD.enrollment_device_id
         AND device.secret_hash = ledger.device_secret_hash
         AND device.state = 'active' AND device.social_verified_at IS NULL
         AND device.expires_at = OLD.expires_at
         AND grant_row.state = 'active'
         AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
         AND grant_row.expires_at = OLD.expires_at
    )
  ))
BEGIN SELECT RAISE(ABORT, 'accountless v12 authorization immutable'); END;
