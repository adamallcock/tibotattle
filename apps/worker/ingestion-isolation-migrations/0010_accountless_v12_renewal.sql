-- Accountless lease renewal extends the ledger, device credential, upload
-- owner and v1.1 grant together (baseline 0059). The v1.2 successor grant was
-- created with the same expiry but its immutability trigger forbade any
-- expiry change, so the first renewal left it behind and the active
-- authorization view (which requires equal expiries) stopped admitting that
-- device's v1.2 uploads permanently. Allow exactly the same forward-only,
-- lease-bound extension the v1.1 grant already has, then repair grants that
-- have already drifted. No other column, state or revocation rule changes.

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
    AND EXISTS (
      SELECT 1
        FROM accountless_enrollment_ledger ledger
        JOIN device_credentials device ON device.id = OLD.device_credential_id
        JOIN accountless_upload_owners owner
          ON owner.enrollment_device_id = OLD.enrollment_device_id
         AND owner.participant_id = OLD.participant_id
         AND owner.device_credential_id = OLD.device_credential_id
       WHERE ledger.device_id = OLD.enrollment_device_id
         AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
         AND ledger.renewal_generation BETWEEN 1 AND 2147483647
         AND ledger.renewed_at IS NOT NULL
         AND device.participant_id = OLD.participant_id
         AND device.authority_kind = 'accountless' AND device.state = 'active'
         AND device.expires_at = ledger.expires_at
         AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
    )
  ))
BEGIN SELECT RAISE(ABORT, 'accountless v12 authorization immutable'); END;

-- One bounded repair of grants already left behind by a completed renewal.
-- Only an active grant whose whole renewed lease graph is active and agrees
-- on a later expiry moves; revoked, expired-graph and unrenewed rows stay.
UPDATE accountless_v12_device_authorizations
   SET expires_at = (
     SELECT ledger.expires_at FROM accountless_enrollment_ledger ledger
      WHERE ledger.device_id = accountless_v12_device_authorizations.enrollment_device_id)
 WHERE state = 'active'
   AND EXISTS (
     SELECT 1
       FROM accountless_enrollment_ledger ledger
       JOIN device_credentials device
         ON device.id = accountless_v12_device_authorizations.device_credential_id
       JOIN accountless_upload_owners owner
         ON owner.enrollment_device_id = ledger.device_id
        AND owner.participant_id = accountless_v12_device_authorizations.participant_id
        AND owner.device_credential_id = device.id
      WHERE ledger.device_id = accountless_v12_device_authorizations.enrollment_device_id
        AND ledger.state = 'active'
        AND ledger.expires_at > accountless_v12_device_authorizations.expires_at
        AND ledger.renewal_generation BETWEEN 1 AND 2147483647
        AND ledger.renewed_at IS NOT NULL
        AND device.participant_id = accountless_v12_device_authorizations.participant_id
        AND device.authority_kind = 'accountless' AND device.state = 'active'
        AND device.expires_at = ledger.expires_at
        AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
   );
