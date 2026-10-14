-- Final isolated ingestion role, after baseline 0061, the typed admission
-- adapters and isolation 0004. Ordinary accountless disconnect revokes every
-- upload capability while keeping its prospectively marked accepted v1.1 head
-- eligible for historical analytics. No telemetry is copied or backfilled.

DROP VIEW community_public_source_owners;
CREATE VIEW community_public_source_owners(participant_id, owner_kind, device_id) AS
SELECT p.id, p.owner_kind, NULL
FROM participants p WHERE p.owner_kind = 'social' AND p.state = 'active'
UNION ALL
SELECT p.id, p.owner_kind, device.id
FROM accountless_upload_owners owner
JOIN participants p ON p.id = owner.participant_id
JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
JOIN device_credentials device ON device.id = owner.device_credential_id
JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = owner.enrollment_device_id
 AND grant_row.participant_id = owner.participant_id
 AND grant_row.device_credential_id = owner.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
  AND device.state = 'active' AND device.revoked_at IS NULL
  AND grant_row.state = 'active' AND grant_row.revoked_at IS NULL AND grant_row.revocation_reason IS NULL
  AND device.participant_id = p.id AND device.authority_kind = 'accountless'
  AND device.id = ledger.device_id AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
  AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
  AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND grant_row.expires_at = ledger.expires_at
  AND EXISTS (SELECT 1 FROM telemetry_v11_domain_heads head
    JOIN telemetry_v11_domains domain ON domain.id = head.generation_id
    WHERE head.participant_id = p.id AND domain.participant_id = p.id
      AND domain.device_id = device.id)
UNION ALL
SELECT p.id, p.owner_kind, device.id
FROM accountless_public_history_retention retained
JOIN participants p ON p.id = retained.participant_id
JOIN accountless_upload_owners owner
  ON owner.participant_id = retained.participant_id
 AND owner.enrollment_device_id = retained.enrollment_device_id
 AND owner.device_credential_id = retained.device_credential_id
JOIN accountless_enrollment_ledger ledger
  ON ledger.device_id = retained.enrollment_device_id
JOIN device_credentials device
  ON device.id = retained.device_credential_id
 AND device.participant_id = retained.participant_id
JOIN accountless_v11_device_authorizations grant_row
  ON grant_row.enrollment_device_id = retained.enrollment_device_id
 AND grant_row.participant_id = retained.participant_id
 AND grant_row.device_credential_id = retained.device_credential_id
JOIN telemetry_v11_domain_heads head
  ON head.participant_id = retained.participant_id
 AND head.generation_id = retained.generation_id
 AND head.revision = retained.head_revision
JOIN telemetry_v11_domains domain
  ON domain.id = retained.generation_id
 AND domain.participant_id = retained.participant_id
 AND domain.device_id = retained.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
  AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
  AND grant_row.state = 'revoked' AND grant_row.revocation_reason = 'user_opt_out'
  AND device.state = 'revoked' AND device.authority_kind = 'accountless'
  AND ledger.revoked_at = retained.retained_at
  AND owner.revoked_at = retained.retained_at
  AND grant_row.revoked_at = retained.retained_at
  AND device.revoked_at = retained.retained_at
  AND device.id = ledger.device_id
  AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
  AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
  AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND grant_row.expires_at = ledger.expires_at;

-- Only the exact prospective user-opt-out transition is non-terminal. Every
-- partial transition, metadata change, containment, reset, deletion, head
-- removal and participant state change keeps the original hard withdrawal.
CREATE TRIGGER accountless_public_history_retention_withdraw_delete
BEFORE DELETE ON accountless_public_history_retention
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn'
 WHERE participant_id=OLD.participant_id AND state='active'; END;

DROP TRIGGER storage_v11_ledger_withdraw_update;
CREATE TRIGGER storage_v11_ledger_withdraw_update
BEFORE UPDATE OF state,revoked_at,revocation_reason,schema_version,policy_version,authorization_basis,device_secret_hash,device_id
ON accountless_enrollment_ledger
WHEN (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.schema_version IS NOT NEW.schema_version
 OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis
 OR OLD.device_secret_hash IS NOT NEW.device_secret_hash OR OLD.device_id IS NOT NEW.device_id)
AND NOT EXISTS (SELECT 1 FROM accountless_public_history_retention retained
 WHERE retained.enrollment_device_id=OLD.device_id
 AND OLD.state='active' AND OLD.revoked_at IS NULL AND OLD.revocation_reason IS NULL
 AND NEW.state='revoked' AND NEW.revocation_reason='user_opt_out'
 AND NEW.revoked_at=retained.retained_at
 AND OLD.schema_version IS NEW.schema_version AND OLD.policy_version IS NEW.policy_version
 AND OLD.authorization_basis IS NEW.authorization_basis AND OLD.device_secret_hash IS NEW.device_secret_hash
 AND OLD.device_id IS NEW.device_id)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn'
 WHERE participant_id=COALESCE(
  (SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),
  (SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id))
 AND state='active'; END;

DROP TRIGGER storage_v11_owner_withdraw_update;
CREATE TRIGGER storage_v11_owner_withdraw_update
BEFORE UPDATE OF state,revoked_at,revocation_reason,enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis
ON accountless_upload_owners
WHEN (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id
 OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id
 OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis)
AND NOT EXISTS (SELECT 1 FROM accountless_public_history_retention retained
 WHERE retained.participant_id=OLD.participant_id
 AND retained.enrollment_device_id=OLD.enrollment_device_id
 AND retained.device_credential_id=OLD.device_credential_id
 AND OLD.state='active' AND OLD.revoked_at IS NULL AND OLD.revocation_reason IS NULL
 AND NEW.state='revoked' AND NEW.revocation_reason='user_opt_out'
 AND NEW.revoked_at=retained.retained_at
 AND OLD.enrollment_device_id IS NEW.enrollment_device_id AND OLD.participant_id IS NEW.participant_id
 AND OLD.device_credential_id IS NEW.device_credential_id AND OLD.policy_version IS NEW.policy_version
 AND OLD.authorization_basis IS NEW.authorization_basis)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn'
 WHERE participant_id=OLD.participant_id AND state='active'; END;

DROP TRIGGER storage_v11_grant_withdraw_update;
CREATE TRIGGER storage_v11_grant_withdraw_update
BEFORE UPDATE OF state,revoked_at,revocation_reason,enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version
ON accountless_v11_device_authorizations
WHEN (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id
 OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id
 OR OLD.telemetry_schema_version IS NOT NEW.telemetry_schema_version
 OR OLD.field_dictionary_version IS NOT NEW.field_dictionary_version
 OR OLD.privacy_contract_version IS NOT NEW.privacy_contract_version)
AND NOT EXISTS (SELECT 1 FROM accountless_public_history_retention retained
 WHERE retained.participant_id=OLD.participant_id
 AND retained.enrollment_device_id=OLD.enrollment_device_id
 AND retained.device_credential_id=OLD.device_credential_id
 AND OLD.state='active' AND OLD.revoked_at IS NULL AND OLD.revocation_reason IS NULL
 AND NEW.state='revoked' AND NEW.revocation_reason='user_opt_out'
 AND NEW.revoked_at=retained.retained_at
 AND OLD.enrollment_device_id IS NEW.enrollment_device_id AND OLD.participant_id IS NEW.participant_id
 AND OLD.device_credential_id IS NEW.device_credential_id
 AND OLD.telemetry_schema_version IS NEW.telemetry_schema_version
 AND OLD.field_dictionary_version IS NEW.field_dictionary_version
 AND OLD.privacy_contract_version IS NEW.privacy_contract_version)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn'
 WHERE participant_id=OLD.participant_id AND state='active'; END;

DROP TRIGGER storage_v11_device_withdraw_update;
CREATE TRIGGER storage_v11_device_withdraw_update
BEFORE UPDATE OF state,revoked_at,authority_kind,participant_id,id,accountless_enrollment_device_id,secret_hash,social_verified_at,paired_via_pairing_id
ON device_credentials
WHEN OLD.authority_kind='accountless' AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at
 OR OLD.authority_kind IS NOT NEW.authority_kind OR OLD.participant_id IS NOT NEW.participant_id
 OR OLD.id IS NOT NEW.id OR OLD.accountless_enrollment_device_id IS NOT NEW.accountless_enrollment_device_id
 OR OLD.secret_hash IS NOT NEW.secret_hash OR OLD.social_verified_at IS NOT NEW.social_verified_at
 OR OLD.paired_via_pairing_id IS NOT NEW.paired_via_pairing_id)
AND NOT EXISTS (SELECT 1 FROM accountless_public_history_retention retained
 WHERE retained.participant_id=OLD.participant_id
 AND retained.enrollment_device_id=OLD.accountless_enrollment_device_id
 AND retained.device_credential_id=OLD.id
 AND OLD.state='active' AND OLD.revoked_at IS NULL AND NEW.state='revoked'
 AND NEW.revoked_at=retained.retained_at
 AND OLD.authority_kind IS NEW.authority_kind AND OLD.participant_id IS NEW.participant_id
 AND OLD.id IS NEW.id AND OLD.accountless_enrollment_device_id IS NEW.accountless_enrollment_device_id
 AND OLD.secret_hash IS NEW.secret_hash AND OLD.social_verified_at IS NEW.social_verified_at
 AND OLD.paired_via_pairing_id IS NEW.paired_via_pairing_id
 AND EXISTS (SELECT 1 FROM accountless_enrollment_ledger ledger
  JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
  JOIN accountless_v11_device_authorizations grant_row
   ON grant_row.enrollment_device_id=ledger.device_id
  WHERE ledger.device_id=OLD.accountless_enrollment_device_id
   AND ledger.state='revoked' AND ledger.revocation_reason='user_opt_out'
   AND owner.participant_id=OLD.participant_id AND owner.device_credential_id=OLD.id
   AND owner.state='revoked' AND owner.revocation_reason='user_opt_out'
   AND grant_row.participant_id=OLD.participant_id AND grant_row.device_credential_id=OLD.id
   AND grant_row.state='revoked' AND grant_row.revocation_reason='user_opt_out'))
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn'
 WHERE participant_id=OLD.participant_id AND state='active'; END;
