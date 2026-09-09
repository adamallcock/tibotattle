PRAGMA foreign_keys = ON;

-- The installation key is durable, while its upload authority remains a
-- finite lease.  Keep the original issued_at and secret immutable; these two
-- fields describe only the latest authorized lease and are advanced together
-- with the same owner/device/v1.1 authorization graph below.
ALTER TABLE accountless_enrollment_ledger
  ADD COLUMN renewal_generation INTEGER NOT NULL DEFAULT 0
    CHECK (renewal_generation BETWEEN 0 AND 2147483647);
ALTER TABLE accountless_enrollment_ledger
  ADD COLUMN renewed_at TEXT
    CONSTRAINT accountless_enrollment_lease_shape CHECK (
      COALESCE((
        issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)
        AND (
          (
            renewal_generation = 0
            AND renewed_at IS NULL
            AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+30 days')
          )
          OR
          (
            renewal_generation BETWEEN 1 AND 2147483647
            AND renewed_at IS NOT NULL
            AND renewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', renewed_at)
            AND renewed_at >= issued_at
            AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', renewed_at, '+30 days')
          )
        )
      ), 0)
    );

-- 0047 intentionally made the owner graph immutable. Renewal needs exactly
-- one controlled exception: an active graph may advance its common expiry in
-- a D1 batch after the ledger has recorded the next generation. The named
-- ledger CHECK rejects a standalone expiry change; Worker-side compare-and-
-- swap and exact graph readback authorize the sole coordinated transition.
-- Every other identity, secret, policy, consent and revocation invariant
-- remains frozen.
DROP TRIGGER accountless_device_credential_nonrenewable;
DROP TRIGGER accountless_upload_owner_immutable;
DROP TRIGGER accountless_v11_authorization_immutable;

CREATE TRIGGER accountless_device_credential_nonrenewable
BEFORE UPDATE OF secret_hash, expires_at, issued_at, credential_generation,
  authority_kind, paired_via_pairing_id, accountless_enrollment_device_id
ON device_credentials
WHEN OLD.authority_kind = 'accountless'
 AND NOT (
   NEW.id IS OLD.id
   AND NEW.participant_id IS OLD.participant_id
   AND NEW.authority_kind = 'accountless'
   AND NEW.paired_via_pairing_id IS NULL
   AND NEW.accountless_enrollment_device_id IS OLD.accountless_enrollment_device_id
   AND NEW.secret_hash IS OLD.secret_hash
   AND NEW.state = 'active'
   AND NEW.issued_at IS OLD.issued_at
   AND NEW.expires_at > OLD.expires_at
   AND NEW.last_used_at IS OLD.last_used_at
   AND NEW.revoked_at IS OLD.revoked_at
   AND NEW.social_verified_at IS NULL
   AND NEW.credential_generation IS OLD.credential_generation
   AND EXISTS (
     SELECT 1
       FROM accountless_enrollment_ledger ledger
       JOIN accountless_upload_owners owner
         ON owner.enrollment_device_id = ledger.device_id
       JOIN accountless_v11_device_authorizations grant_row
         ON grant_row.enrollment_device_id = ledger.device_id
      WHERE ledger.device_id = OLD.accountless_enrollment_device_id
        AND ledger.state = 'active'
        AND ledger.expires_at = NEW.expires_at
        AND ledger.renewal_generation BETWEEN 1 AND 2147483647
        AND ledger.renewed_at IS NOT NULL
        AND owner.participant_id = OLD.participant_id
        AND owner.device_credential_id = OLD.id
        AND owner.state = 'active' AND owner.expires_at = OLD.expires_at
        AND grant_row.participant_id = OLD.participant_id
        AND grant_row.device_credential_id = OLD.id
        AND grant_row.state = 'active' AND grant_row.expires_at = OLD.expires_at
   )
 )
BEGIN SELECT RAISE(ABORT, 'accountless device credential immutable'); END;

CREATE TRIGGER accountless_upload_owner_immutable
BEFORE UPDATE ON accountless_upload_owners
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.authorization_basis IS NOT OLD.authorization_basis
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
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = OLD.enrollment_device_id
         AND grant_row.participant_id = OLD.participant_id
         AND grant_row.device_credential_id = OLD.device_credential_id
       WHERE ledger.device_id = OLD.enrollment_device_id
         AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
         AND ledger.renewal_generation BETWEEN 1 AND 2147483647
         AND ledger.renewed_at IS NOT NULL
         AND device.participant_id = OLD.participant_id
         AND device.authority_kind = 'accountless' AND device.state = 'active'
         AND device.expires_at = ledger.expires_at
         AND grant_row.state = 'active' AND grant_row.expires_at = OLD.expires_at
    )
  ))
BEGIN SELECT RAISE(ABORT, 'accountless owner immutable'); END;

CREATE TRIGGER accountless_v11_authorization_immutable
BEFORE UPDATE ON accountless_v11_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
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
BEGIN SELECT RAISE(ABORT, 'accountless authorization immutable'); END;
