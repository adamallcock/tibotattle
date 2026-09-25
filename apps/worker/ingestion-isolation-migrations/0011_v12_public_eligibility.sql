-- Owner decision 2026-09-25: accepted accountless v1.2 (successor) uploads are
-- public contribution sources on the same terms as v1.1, including ordinary
-- opt-out retention. Until now the eligibility view only admitted accountless
-- devices through a v1.1 grant and v1.1 head, and a v1.2 domain activation
-- journaled nothing, so a v1.2 upload never received an analytics owner
-- identity and never re-queued the public days it changed.
--
-- This forward-only migration (1) adds the v1.2 active and retained branches
-- to community_public_source_owners, (2) lets the prospective opt-out marker
-- name an accepted v1.2 head, and (3) adds the v1.2 delivery bridge: an
-- eligible v1.2 head mints the shared owner link when absent and journals one
-- ordered owner-active change, exactly like an accepted v1.1 head. No
-- telemetry is copied. Existing eligible v1.2 heads are bridged once below.

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
  AND grant_row.expires_at = ledger.expires_at
UNION ALL
-- Accountless v1.2 successor installs. The same active lease graph as the
-- v1.1 branch, proved by the separate v1.2 grant and an accepted v1.2 head for
-- this exact device. A device with any v1.1 domain stays on the branches
-- above, so no participant/device pair can match twice and no leftover v1.1
-- head becomes eligible through the successor grant.
SELECT p.id, p.owner_kind, device.id
FROM accountless_upload_owners owner
JOIN participants p ON p.id = owner.participant_id
JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
JOIN device_credentials device ON device.id = owner.device_credential_id
JOIN accountless_v12_device_authorizations successor
  ON successor.enrollment_device_id = owner.enrollment_device_id
 AND successor.participant_id = owner.participant_id
 AND successor.device_credential_id = owner.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
  AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
  AND device.state = 'active' AND device.revoked_at IS NULL
  AND successor.state = 'active' AND successor.revoked_at IS NULL AND successor.revocation_reason IS NULL
  AND device.participant_id = p.id AND device.authority_kind = 'accountless'
  AND device.id = ledger.device_id AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND successor.schema_version = 'accountless-upload-owner-v1.2'
  AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
  AND successor.authorization_basis = 'accountless-policy-v1.2'
  AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
  AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
  AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND successor.expires_at = ledger.expires_at
  AND EXISTS (SELECT 1 FROM telemetry_v12_domain_heads head
    JOIN telemetry_v12_domains domain ON domain.id = head.generation_id
    WHERE head.participant_id = p.id AND domain.participant_id = p.id
      AND domain.device_id = device.id)
  AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains legacy_domain
    WHERE legacy_domain.participant_id = p.id AND legacy_domain.device_id = device.id)
UNION ALL
-- The v1.2 counterpart of the retained-history branch: an ordinary opt-out
-- whose exact prospective marker names this device's accepted v1.2 head.
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
JOIN accountless_v12_device_authorizations successor
  ON successor.enrollment_device_id = retained.enrollment_device_id
 AND successor.participant_id = retained.participant_id
 AND successor.device_credential_id = retained.device_credential_id
JOIN telemetry_v12_domain_heads head
  ON head.participant_id = retained.participant_id
 AND head.generation_id = retained.generation_id
 AND head.revision = retained.head_revision
JOIN telemetry_v12_domains domain
  ON domain.id = retained.generation_id
 AND domain.participant_id = retained.participant_id
 AND domain.device_id = retained.device_credential_id
WHERE p.owner_kind = 'accountless' AND p.state = 'active'
  AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
  AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
  AND successor.state = 'revoked' AND successor.revocation_reason = 'user_opt_out'
  AND device.state = 'revoked' AND device.authority_kind = 'accountless'
  AND ledger.revoked_at = retained.retained_at
  AND owner.revoked_at = retained.retained_at
  AND successor.revoked_at = retained.retained_at
  AND device.revoked_at = retained.retained_at
  AND device.id = ledger.device_id
  AND device.accountless_enrollment_device_id = ledger.device_id
  AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
  AND device.secret_hash = ledger.device_secret_hash
  AND ledger.schema_version = 'accountless-enrollment-v0.1'
  AND ledger.policy_version = 'accountless-opt-out-v1'
  AND ledger.authorization_basis = 'accountless-policy-v1'
  AND owner.policy_version = ledger.policy_version AND owner.authorization_basis = ledger.authorization_basis
  AND successor.schema_version = 'accountless-upload-owner-v1.2'
  AND successor.policy_version = 'accountless-telemetry-v1.2-policy-v1'
  AND successor.authorization_basis = 'accountless-policy-v1.2'
  AND successor.telemetry_schema_version = 'telemetry-contribution-v1.2'
  AND successor.field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'
  AND successor.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'
  AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
  AND successor.expires_at = ledger.expires_at
  AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains legacy_domain
    WHERE legacy_domain.participant_id = p.id AND legacy_domain.device_id = device.id);


-- The prospective opt-out marker may name either an accepted v1.1 head (as
-- before) or, for a device without any v1.1 domain, its accepted v1.2 head.
DROP TRIGGER accountless_public_history_retention_insert;
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
) AND NOT EXISTS (
  SELECT 1
    FROM community_public_source_owners public_owner
    JOIN accountless_upload_owners owner
      ON owner.participant_id = public_owner.participant_id
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
     AND domain.participant_id = owner.participant_id
     AND domain.device_id = owner.device_credential_id
   WHERE public_owner.owner_kind = 'accountless'
     AND public_owner.participant_id = NEW.participant_id
     AND public_owner.device_id = NEW.device_credential_id
     AND owner.enrollment_device_id = NEW.enrollment_device_id
     AND owner.device_credential_id = NEW.device_credential_id
     AND ledger.state = 'active' AND owner.state = 'active'
     AND device.state = 'active' AND successor.state = 'active'
     AND head.generation_id = NEW.generation_id
     AND head.revision = NEW.head_revision
     AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains legacy_domain
       WHERE legacy_domain.participant_id = owner.participant_id
         AND legacy_domain.device_id = owner.device_credential_id)
)
BEGIN SELECT RAISE(ABORT, 'accountless_history_retention_unavailable'); END;

-- v1.2 delivery bridge. The owner link table is the shared, version-neutral
-- analytics identity (v1, v1.1 and legacy already mint into it); only its
-- v1.1 generation columns stay v1.1-specific and are never written here.
CREATE TABLE storage_v12_event_sources (
  event_digest TEXT PRIMARY KEY CHECK(length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  generation_id TEXT NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  previous_generation_id TEXT,
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  head_revision INTEGER NOT NULL CHECK(head_revision>0),
  recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0),
  UNIQUE(participant_id,generation_id,head_revision)
) STRICT;
CREATE INDEX storage_v12_event_owner ON storage_v12_event_sources(owner_digest,event_digest);
CREATE INDEX storage_v12_event_generation ON storage_v12_event_sources(generation_id,owner_digest);
-- One bounded command row, consumed synchronously by its trigger.
CREATE TABLE storage_v12_head_requests (
  participant_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  head_revision INTEGER NOT NULL
) STRICT;

CREATE TRIGGER storage_v12_head_request_apply AFTER INSERT ON storage_v12_head_requests
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM telemetry_v12_domain_heads h
    JOIN telemetry_v12_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
    JOIN community_public_source_owners p ON p.participant_id=h.participant_id
      AND (p.device_id IS NULL OR p.device_id=d.device_id)
    WHERE h.participant_id=NEW.participant_id AND h.generation_id=NEW.generation_id AND h.revision=NEW.head_revision)
    THEN RAISE(ABORT,'storage_v12_head_ineligible') END;
  INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
    VALUES(NEW.participant_id,lower(hex(randomblob(32))),'active') ON CONFLICT(participant_id) DO NOTHING;
  INSERT INTO storage_v12_event_sources(event_digest,owner_digest,participant_id,device_id,generation_id,
    previous_generation_id,manifest_digest,head_revision,recorded_ms)
    SELECT lower(hex(randomblob(32))),link.owner_digest,d.participant_id,d.device_id,d.id,
      d.previous_generation_id,d.manifest_digest,NEW.head_revision,CAST(strftime('%s','now') AS INTEGER)*1000
    FROM storage_v11_owner_links link JOIN telemetry_v12_domains d ON d.id=NEW.generation_id
    WHERE link.participant_id=NEW.participant_id AND link.state IN ('active','withdrawn')
    ON CONFLICT(participant_id,generation_id,head_revision) DO NOTHING;
  -- A later eligible upload re-activates a withdrawn (never an erased) owner,
  -- as an accepted v1.1 head does; the journal row above records owner-active.
  UPDATE storage_v11_owner_links SET state='active'
    WHERE participant_id=NEW.participant_id AND state='withdrawn';
  DELETE FROM storage_v12_head_requests WHERE participant_id=NEW.participant_id;
END;
CREATE TRIGGER storage_v12_event_publish AFTER INSERT ON storage_v12_event_sources
BEGIN
  INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
    authority_epoch,public_authority_epoch,recorded_ms)
  VALUES(NEW.event_digest,NEW.owner_digest,
    COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    'owner-active',NEW.event_digest,NEW.manifest_digest,
    COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+1,NEW.recorded_ms);
  -- An owner without a v1.1 generation carries this event as its terminal
  -- object, so a later withdrawal/erasure journal row has exact digests.
  UPDATE storage_v11_owner_links SET object_digest=NEW.event_digest,manifest_digest=NEW.manifest_digest
    WHERE participant_id=NEW.participant_id AND generation_id IS NULL;
END;
CREATE TRIGGER storage_v12_head_insert AFTER INSERT ON telemetry_v12_domain_heads
BEGIN
  INSERT INTO storage_v12_head_requests SELECT NEW.participant_id,NEW.generation_id,NEW.revision
    WHERE EXISTS(SELECT 1 FROM community_public_source_owners p JOIN telemetry_v12_domains d ON d.id=NEW.generation_id
      WHERE p.participant_id=NEW.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id));
END;
CREATE TRIGGER storage_v12_head_update AFTER UPDATE ON telemetry_v12_domain_heads
WHEN OLD.generation_id IS NOT NEW.generation_id OR OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO storage_v12_head_requests SELECT NEW.participant_id,NEW.generation_id,NEW.revision
    WHERE EXISTS(SELECT 1 FROM community_public_source_owners p JOIN telemetry_v12_domains d ON d.id=NEW.generation_id
      WHERE p.participant_id=NEW.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id));
END;
CREATE TRIGGER storage_v12_event_immutable BEFORE UPDATE ON storage_v12_event_sources
BEGIN SELECT RAISE(ABORT,'storage_v12_event_immutable'); END;
CREATE TRIGGER storage_v12_event_delete BEFORE DELETE ON storage_v12_event_sources
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'storage_v12_terminal_required'); END;

-- Bridge every currently eligible accepted v1.2 head once. Rows the source
-- journal already names are not repeated; nothing is bridged for an
-- ineligible, withdrawn-only or erased owner.
INSERT INTO storage_v12_head_requests(participant_id,generation_id,head_revision)
SELECT h.participant_id,h.generation_id,h.revision FROM telemetry_v12_domain_heads h
  JOIN telemetry_v12_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
 WHERE EXISTS(SELECT 1 FROM community_public_source_owners p
   WHERE p.participant_id=h.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id))
   AND NOT EXISTS(SELECT 1 FROM storage_owner_revisions o JOIN storage_v11_owner_links l ON l.owner_digest=o.owner_digest
   WHERE l.participant_id=h.participant_id AND o.state='erased');
