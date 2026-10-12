-- Isolation 0011 lets an ordinary opt-out marker name an accepted v1.2 head
-- for a device that has no v1.1 domain. The retained-history transfer source
-- (baseline 0063) predates that and proves every marker only through the v1.1
-- grant, head and domain, so one v1.2-only opt-out made every capture refuse
-- with SOURCE_MARKER_INELIGIBLE, for every owner.
--
-- This forward-only migration requires 0063 (the view must already exist) and
-- the v1.2 tables of 0008; it changes no stored row. It (1) re-creates the
-- candidate view with two disjoint lineages, and (2) adds the matching v1.2
-- invalidation triggers. A marker whose generation names a v1.2 domain is
-- proved exactly like isolation 0011's retained v1.2 public-source branch:
-- revoked successor grant, v1.2 head and domain of this device, and no v1.1
-- domain for it. Every other marker keeps 0063's v1.1 proof unchanged. The
-- snapshot columns are unchanged; a v1.2 row carries the successor grant in
-- its grant_* fields, so grant_telemetry_schema_version names its lineage.
-- Incomplete joins still yield is_eligible=0, and capture still refuses them.

DROP VIEW accountless_history_transfer_candidates;
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
  ON domain.id = retained.generation_id
WHERE NOT EXISTS (
  SELECT 1 FROM telemetry_v12_domains successor_domain
   WHERE successor_domain.id = retained.generation_id
)
UNION ALL
SELECT
  retained.participant_id,
  retained.enrollment_device_id,
  retained.device_credential_id,
  retained.generation_id,
  retained.head_revision,
  retained.retained_at,
  participant.owner_kind,
  participant.state,
  owner.participant_id,
  owner.enrollment_device_id,
  owner.device_credential_id,
  owner.policy_version,
  owner.authorization_basis,
  owner.expires_at,
  owner.state,
  owner.revoked_at,
  owner.revocation_reason,
  ledger.device_id,
  ledger.device_secret_hash,
  ledger.schema_version,
  ledger.policy_version,
  ledger.authorization_basis,
  ledger.expires_at,
  ledger.state,
  ledger.revoked_at,
  ledger.revocation_reason,
  device.id,
  device.participant_id,
  device.authority_kind,
  device.accountless_enrollment_device_id,
  device.secret_hash,
  device.paired_via_pairing_id,
  device.social_verified_at,
  device.expires_at,
  device.state,
  device.revoked_at,
  successor.enrollment_device_id,
  successor.participant_id,
  successor.device_credential_id,
  successor.telemetry_schema_version,
  successor.field_dictionary_version,
  successor.privacy_contract_version,
  successor.expires_at,
  successor.state,
  successor.revoked_at,
  successor.revocation_reason,
  head.participant_id,
  head.generation_id,
  head.revision,
  domain.id,
  domain.participant_id,
  domain.device_id,
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
    AND successor.enrollment_device_id = retained.enrollment_device_id
    AND successor.participant_id = retained.participant_id
    AND successor.device_credential_id = retained.device_credential_id
    AND successor.state = 'revoked' AND successor.revocation_reason = 'user_opt_out'
    AND owner.revoked_at = retained.retained_at
    AND ledger.revoked_at = retained.retained_at
    AND device.revoked_at = retained.retained_at
    AND successor.revoked_at = retained.retained_at
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
    AND head.participant_id = retained.participant_id
    AND head.generation_id = retained.generation_id
    AND head.revision = retained.head_revision
    AND domain.id = retained.generation_id
    AND domain.participant_id = retained.participant_id
    AND domain.device_id = retained.device_credential_id
    AND NOT EXISTS (
      SELECT 1 FROM telemetry_v11_domains legacy_domain
       WHERE legacy_domain.participant_id = retained.participant_id
         AND legacy_domain.device_id = retained.device_credential_id
    )
  THEN 1 ELSE 0 END
FROM accountless_public_history_retention retained
JOIN telemetry_v12_domains domain
  ON domain.id = retained.generation_id
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
LEFT JOIN accountless_v12_device_authorizations successor
  ON successor.enrollment_device_id = retained.enrollment_device_id
 AND successor.participant_id = retained.participant_id
 AND successor.device_credential_id = retained.device_credential_id
LEFT JOIN telemetry_v12_domain_heads head
  ON head.participant_id = retained.participant_id;

-- A v1.2 proof also depends on the successor grant, the v1.2 head and the
-- v1.2 domain; the lineage itself depends on which domain table names the
-- marker's generation. Mirror 0063's v1.1 triggers so any such mutation
-- advances the revision and invalidates an open snapshot in its own
-- transaction, while unrelated rows with no marker or snapshot are ignored.
CREATE TRIGGER accountless_history_transfer_v12_grant_insert
AFTER INSERT ON accountless_v12_device_authorizations
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
CREATE TRIGGER accountless_history_transfer_v12_grant_update
AFTER UPDATE OF enrollment_device_id, participant_id, device_credential_id,
  schema_version, policy_version, authorization_basis,
  telemetry_schema_version, field_dictionary_version, privacy_contract_version,
  expires_at, state, revoked_at, revocation_reason
ON accountless_v12_device_authorizations
WHEN (OLD.enrollment_device_id IS NOT NEW.enrollment_device_id
 OR OLD.participant_id IS NOT NEW.participant_id
 OR OLD.device_credential_id IS NOT NEW.device_credential_id
 OR OLD.schema_version IS NOT NEW.schema_version
 OR OLD.policy_version IS NOT NEW.policy_version
 OR OLD.authorization_basis IS NOT NEW.authorization_basis
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
CREATE TRIGGER accountless_history_transfer_v12_grant_delete
AFTER DELETE ON accountless_v12_device_authorizations
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

CREATE TRIGGER accountless_history_transfer_v12_head_insert
AFTER INSERT ON telemetry_v12_domain_heads
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = NEW.participant_id OR generation_id = NEW.generation_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = NEW.participant_id OR marker_generation_id = NEW.generation_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;
CREATE TRIGGER accountless_history_transfer_v12_head_update
AFTER UPDATE OF participant_id, generation_id, revision ON telemetry_v12_domain_heads
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
CREATE TRIGGER accountless_history_transfer_v12_head_delete
AFTER DELETE ON telemetry_v12_domain_heads
WHEN EXISTS (SELECT 1 FROM accountless_public_history_retention
  WHERE participant_id = OLD.participant_id OR generation_id = OLD.generation_id)
  OR EXISTS (SELECT 1 FROM accountless_history_transfer_rows
  WHERE participant_id = OLD.participant_id OR marker_generation_id = OLD.generation_id)
BEGIN
  UPDATE accountless_history_transfer_control SET authority_revision = authority_revision + 1 WHERE singleton_id = 1;
  UPDATE accountless_history_transfer_runs SET state = 'invalidated', invalidation_code = 'SOURCE_AUTHORITY_MUTATED'
   WHERE state IN ('capturing', 'sealed', 'extracted');
END;

CREATE TRIGGER accountless_history_transfer_v12_domain_insert
AFTER INSERT ON telemetry_v12_domains
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
CREATE TRIGGER accountless_history_transfer_v12_domain_update
AFTER UPDATE OF id, participant_id, device_id ON telemetry_v12_domains
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
CREATE TRIGGER accountless_history_transfer_v12_domain_delete
AFTER DELETE ON telemetry_v12_domains
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
