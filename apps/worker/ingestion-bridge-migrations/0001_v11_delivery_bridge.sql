-- OPTIONAL NEW-TARGET / LOCAL bridge over complete baseline 0001--0060 and
-- storage journal 0002. No existing admission or analytics trigger is replaced.
-- This covers accepted v1.1 heads and their owner withdrawal, not all public
-- policy/exclusion changes. It does not activate a public read or a split.
CREATE TABLE storage_v11_owner_links (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  owner_digest TEXT NOT NULL UNIQUE CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('active','withdrawn','erased')),
  generation_id TEXT,
  head_revision INTEGER,
  object_digest TEXT,
  manifest_digest TEXT
) STRICT;
CREATE TABLE storage_v11_event_sources (
  event_digest TEXT PRIMARY KEY CHECK(length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  owner_digest TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  generation_id TEXT NOT NULL REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
  from_day TEXT NOT NULL,
  through_day TEXT NOT NULL,
  head_revision INTEGER NOT NULL CHECK(head_revision>0),
  input_revision INTEGER NOT NULL CHECK(input_revision>=0),
  recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
) STRICT;
CREATE INDEX storage_v11_event_owner ON storage_v11_event_sources(owner_digest,event_digest);
CREATE INDEX storage_v11_event_generation ON storage_v11_event_sources(generation_id,owner_digest);
-- One bounded command row, consumed synchronously by the trigger. This is an
-- internal bridge command, not an upload or authorization API.
CREATE TABLE storage_v11_head_requests (
  participant_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  head_revision INTEGER NOT NULL
) STRICT;

CREATE TRIGGER storage_v11_event_publish AFTER INSERT ON storage_v11_event_sources
BEGIN
  INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
    authority_epoch,public_authority_epoch,recorded_ms)
  VALUES(NEW.event_digest,NEW.owner_digest,
    COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    'owner-active',NEW.event_digest,NEW.manifest_digest,
    COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+1,NEW.recorded_ms);
END;
CREATE TRIGGER storage_v11_head_request_apply AFTER INSERT ON storage_v11_head_requests
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h
    JOIN telemetry_v11_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
    JOIN community_public_source_owners p ON p.participant_id=h.participant_id
      AND (p.device_id IS NULL OR p.device_id=d.device_id)
    WHERE h.participant_id=NEW.participant_id AND h.generation_id=NEW.generation_id AND h.revision=NEW.head_revision)
    THEN RAISE(ABORT,'storage_v11_head_ineligible') END;
  INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
    VALUES(NEW.participant_id,lower(hex(randomblob(32))),'active') ON CONFLICT(participant_id) DO NOTHING;
  INSERT INTO storage_v11_event_sources(event_digest,owner_digest,participant_id,device_id,generation_id,
    manifest_digest,from_day,through_day,head_revision,input_revision,recorded_ms)
    SELECT lower(hex(randomblob(32))),link.owner_digest,d.participant_id,d.device_id,d.id,
      d.manifest_digest,d.from_day,d.through_day,NEW.head_revision,d.input_revision,
      CAST(strftime('%s','now') AS INTEGER)*1000
    FROM storage_v11_owner_links link JOIN telemetry_v11_domains d ON d.id=NEW.generation_id
    WHERE link.participant_id=NEW.participant_id
      AND (link.generation_id IS NOT NEW.generation_id OR link.head_revision IS NOT NEW.head_revision OR link.state!='active');
  UPDATE storage_v11_owner_links SET state='active',generation_id=NEW.generation_id,head_revision=NEW.head_revision,
    object_digest=(SELECT event_digest FROM storage_ingestion_changes c WHERE c.owner_digest=storage_v11_owner_links.owner_digest
      AND c.revision=(SELECT revision FROM storage_owner_revisions WHERE owner_digest=storage_v11_owner_links.owner_digest)),
    manifest_digest=(SELECT manifest_digest FROM telemetry_v11_domains WHERE id=NEW.generation_id)
    WHERE participant_id=NEW.participant_id;
  DELETE FROM storage_v11_head_requests WHERE participant_id=NEW.participant_id;
END;
CREATE TRIGGER storage_v11_head_insert AFTER INSERT ON telemetry_v11_domain_heads
BEGIN
  INSERT INTO storage_v11_head_requests SELECT NEW.participant_id,NEW.generation_id,NEW.revision
    FROM community_public_source_owners p JOIN telemetry_v11_domains d ON d.id=NEW.generation_id
    WHERE p.participant_id=NEW.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id);
END;
CREATE TRIGGER storage_v11_head_update AFTER UPDATE ON telemetry_v11_domain_heads
WHEN OLD.generation_id IS NOT NEW.generation_id OR OLD.revision IS NOT NEW.revision
BEGIN
  INSERT INTO storage_v11_head_requests SELECT NEW.participant_id,NEW.generation_id,NEW.revision
    FROM community_public_source_owners p JOIN telemetry_v11_domains d ON d.id=NEW.generation_id
    WHERE p.participant_id=NEW.participant_id AND (p.device_id IS NULL OR p.device_id=d.device_id);
END;
CREATE TRIGGER storage_v11_owner_terminal AFTER UPDATE OF state ON storage_v11_owner_links
WHEN OLD.state IS NOT NEW.state AND NEW.state IN ('withdrawn','erased')
BEGIN
  INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
    authority_epoch,public_authority_epoch,recorded_ms)
  VALUES(lower(hex(randomblob(32))),OLD.owner_digest,
    (SELECT revision FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest)+1,
    CASE NEW.state WHEN 'erased' THEN 'owner-erased' ELSE 'owner-withdrawn' END,
    OLD.object_digest,OLD.manifest_digest,
    (SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest)+1,
    (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+1,CAST(strftime('%s','now') AS INTEGER)*1000);
END;
CREATE TRIGGER storage_v11_owner_identity BEFORE UPDATE ON storage_v11_owner_links
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.owner_digest IS NOT NEW.owner_digest
  OR (OLD.state='erased' AND NEW.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_owner_immutable'); END;
CREATE TRIGGER storage_v11_owner_delete BEFORE DELETE ON storage_v11_owner_links
WHEN OLD.state!='erased'
BEGIN SELECT RAISE(ABORT,'storage_v11_terminal_required'); END;
CREATE TRIGGER storage_v11_event_immutable BEFORE UPDATE ON storage_v11_event_sources
BEGIN SELECT RAISE(ABORT,'storage_v11_event_immutable'); END;
CREATE TRIGGER storage_v11_event_delete BEFORE DELETE ON storage_v11_event_sources
WHEN NOT EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=OLD.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_terminal_required'); END;
-- Accepted source evidence remains pinned even after head replacement. A
-- qualified acknowledged-retirement protocol is not implemented by this slice;
-- only terminal owner erasure currently releases these retention fences.
CREATE TRIGGER storage_v11_domain_day_retained BEFORE DELETE ON telemetry_v11_domain_days
WHEN EXISTS(SELECT 1 FROM storage_v11_event_sources s
  JOIN storage_owner_revisions o ON o.owner_digest=s.owner_digest
  WHERE s.generation_id=OLD.generation_id AND o.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;
CREATE TRIGGER storage_v11_day_manifests_retained BEFORE DELETE ON telemetry_v11_day_manifests
WHEN EXISTS(SELECT 1 FROM telemetry_v11_domain_days d
  JOIN storage_v11_event_sources s ON s.generation_id=d.generation_id
  JOIN storage_owner_revisions o ON o.owner_digest=s.owner_digest
  WHERE d.manifest_id=OLD.id AND o.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;
CREATE TRIGGER storage_v11_chunks_retained BEFORE DELETE ON telemetry_v11_chunks
WHEN EXISTS(SELECT 1 FROM telemetry_v11_domain_days d
  JOIN storage_v11_event_sources s ON s.generation_id=d.generation_id
  JOIN storage_owner_revisions o ON o.owner_digest=s.owner_digest
  WHERE d.manifest_id=OLD.manifest_id AND o.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;
CREATE TRIGGER storage_v11_records_retained BEFORE DELETE ON telemetry_v11_records
WHEN EXISTS(SELECT 1 FROM telemetry_v11_domain_days d
  JOIN storage_v11_event_sources s ON s.generation_id=d.generation_id
  JOIN storage_owner_revisions o ON o.owner_digest=s.owner_digest
  WHERE d.manifest_id=OLD.manifest_id AND o.state!='erased')
BEGIN SELECT RAISE(ABORT,'storage_v11_source_retained'); END;
CREATE TRIGGER storage_v11_participant_erasure BEFORE DELETE ON participants
BEGIN UPDATE storage_v11_owner_links SET state='erased' WHERE participant_id=OLD.id AND state!='erased'; END;
CREATE TRIGGER storage_v11_participant_withdrawal BEFORE UPDATE OF state,owner_kind,id ON participants
WHEN OLD.state IS NOT NEW.state OR OLD.owner_kind IS NOT NEW.owner_kind OR OLD.id IS NOT NEW.id
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.id AND state='active'; END;
CREATE TRIGGER storage_v11_head_withdrawal BEFORE DELETE ON telemetry_v11_domain_heads
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;

CREATE TRIGGER storage_v11_ledger_withdraw_update BEFORE UPDATE OF state,revoked_at,revocation_reason,schema_version,policy_version,authorization_basis,device_secret_hash,device_id ON accountless_enrollment_ledger
WHEN (1) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.schema_version IS NOT NEW.schema_version OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis OR OLD.device_secret_hash IS NOT NEW.device_secret_hash OR OLD.device_id IS NOT NEW.device_id)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id)) AND state='active'; END;
CREATE TRIGGER storage_v11_ledger_withdraw_delete BEFORE DELETE ON accountless_enrollment_ledger
WHEN 1
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=COALESCE((SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=OLD.device_id),(SELECT participant_id FROM device_credentials WHERE accountless_enrollment_device_id=OLD.device_id)) AND state='active'; END;

CREATE TRIGGER storage_v11_owner_withdraw_update BEFORE UPDATE OF state,revoked_at,revocation_reason,enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis ON accountless_upload_owners
WHEN (1) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id OR OLD.policy_version IS NOT NEW.policy_version OR OLD.authorization_basis IS NOT NEW.authorization_basis)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;
CREATE TRIGGER storage_v11_owner_withdraw_delete BEFORE DELETE ON accountless_upload_owners
WHEN 1
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;

CREATE TRIGGER storage_v11_device_withdraw_update BEFORE UPDATE OF state,revoked_at,authority_kind,participant_id,id,accountless_enrollment_device_id,secret_hash,social_verified_at,paired_via_pairing_id ON device_credentials
WHEN (OLD.authority_kind='accountless') AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.authority_kind IS NOT NEW.authority_kind OR OLD.participant_id IS NOT NEW.participant_id OR OLD.id IS NOT NEW.id OR OLD.accountless_enrollment_device_id IS NOT NEW.accountless_enrollment_device_id OR OLD.secret_hash IS NOT NEW.secret_hash OR OLD.social_verified_at IS NOT NEW.social_verified_at OR OLD.paired_via_pairing_id IS NOT NEW.paired_via_pairing_id)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;
CREATE TRIGGER storage_v11_device_withdraw_delete BEFORE DELETE ON device_credentials
WHEN OLD.authority_kind='accountless'
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;

CREATE TRIGGER storage_v11_grant_withdraw_update BEFORE UPDATE OF state,revoked_at,revocation_reason,enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version ON accountless_v11_device_authorizations
WHEN (1) AND (OLD.state IS NOT NEW.state OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.revocation_reason IS NOT NEW.revocation_reason OR OLD.enrollment_device_id IS NOT NEW.enrollment_device_id OR OLD.participant_id IS NOT NEW.participant_id OR OLD.device_credential_id IS NOT NEW.device_credential_id OR OLD.telemetry_schema_version IS NOT NEW.telemetry_schema_version OR OLD.field_dictionary_version IS NOT NEW.field_dictionary_version OR OLD.privacy_contract_version IS NOT NEW.privacy_contract_version)
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;
CREATE TRIGGER storage_v11_grant_withdraw_delete BEFORE DELETE ON accountless_v11_device_authorizations
WHEN 1
BEGIN UPDATE storage_v11_owner_links SET state='withdrawn' WHERE participant_id=OLD.participant_id AND state='active'; END;
