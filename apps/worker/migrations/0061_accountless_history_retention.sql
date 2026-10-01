-- Prospective source-identity marker for the opt-out-stops-future-uploads
-- policy. It copies no telemetry and intentionally has no backfill: a source
-- revoked before this contract was installed remains withdrawn.
CREATE TABLE accountless_public_history_retention (
  participant_id TEXT PRIMARY KEY NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  enrollment_device_id TEXT NOT NULL UNIQUE,
  device_credential_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  retained_at TEXT NOT NULL,
  CHECK (retained_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z')
) STRICT;

-- Only a currently eligible, exact accepted head may be marked. The runtime
-- inserts this row in the same D1 batch before revoking upload authority.
CREATE TRIGGER accountless_public_history_retention_insert
BEFORE INSERT ON accountless_public_history_retention
WHEN NOT EXISTS (
  SELECT 1
    FROM community_public_source_owners public_owner
    JOIN accountless_upload_owners owner
      ON owner.participant_id = public_owner.participant_id
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
   WHERE public_owner.owner_kind = 'accountless'
     AND public_owner.participant_id = NEW.participant_id
     AND public_owner.device_id = NEW.device_credential_id
     AND owner.enrollment_device_id = NEW.enrollment_device_id
     AND owner.device_credential_id = NEW.device_credential_id
     AND ledger.state = 'active' AND owner.state = 'active'
     AND device.state = 'active' AND grant_row.state = 'active'
     AND head.generation_id = NEW.generation_id
     AND head.revision = NEW.head_revision
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_retention_unavailable'); END;

CREATE TRIGGER accountless_public_history_retention_immutable
BEFORE UPDATE ON accountless_public_history_retention
BEGIN SELECT RAISE(ABORT, 'accountless_history_retention_immutable'); END;
