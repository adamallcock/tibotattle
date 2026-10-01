-- A v1.1 day manifest may carry zero chunks: an idle day inside the client's
-- contiguous planned range. v1.2 required at least one, so an idle day could
-- never be registered, the storage error surfaced as a retryable 503, and the
-- whole pass failed on every retry. Recreate the v1.2 manifest table with the
-- v1.1 bound; only that lower bound moves from 1 to 0.
--
-- The domain, domain-day and head tables are recreated after it, in 0008's
-- original order, so every cascading delete from a participant or device runs
-- in the same sequence as before (domain days restrict manifest deletion and
-- heads restrict domain deletion). Every index and trigger attached to the
-- four tables is recreated from its canonical stored definition.
--
-- It also re-issues, unchanged in meaning, the eligibility view and two v1.2
-- bridge triggers from 0011 in their canonical text: a raw-file application
-- kept comments inside those statements, which made the stored schema differ
-- from the one the migration chain derives.
--
-- Every deployed role holds no v1.2 manifest, domain or head yet. The guard
-- aborts the whole migration otherwise, so no drop can remove data. Statements
-- carry no inline comments, so remote and derived schemas stay byte-identical.

CREATE TABLE telemetry_v12_manifest_rebuild_guard (empty INTEGER NOT NULL CHECK (empty = 1)) STRICT;

INSERT INTO telemetry_v12_manifest_rebuild_guard (empty) SELECT CASE WHEN EXISTS (SELECT 1 FROM telemetry_v12_day_manifests) OR EXISTS (SELECT 1 FROM telemetry_v12_domains) OR EXISTS (SELECT 1 FROM telemetry_v12_domain_days) OR EXISTS (SELECT 1 FROM telemetry_v12_domain_heads) THEN 0 ELSE 1 END;

DROP TABLE telemetry_v12_manifest_rebuild_guard;

DROP TABLE telemetry_v12_domain_heads;

DROP TABLE telemetry_v12_domain_days;

DROP TABLE telemetry_v12_domains;

DROP TABLE telemetry_v12_day_manifests;

CREATE TABLE telemetry_v12_day_manifests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day TEXT NOT NULL CHECK (length(chunk_day) = 10),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND length(manifest_json) <= 1250000),
  expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count BETWEEN 0 AND 4096),
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'ready')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  UNIQUE (participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
) STRICT;

CREATE INDEX telemetry_v12_manifests_device_day
  ON telemetry_v12_day_manifests(participant_id, device_id, chunk_day, created_at, id);

CREATE TRIGGER telemetry_v12_manifest_admission
BEFORE INSERT ON telemetry_v12_day_manifests
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v12_active_authorizations auth
     WHERE auth.participant_id = NEW.participant_id
       AND auth.device_id = NEW.device_id
  ) THEN RAISE(ABORT, 'telemetry_v12_transport_blocked') END;
  SELECT CASE WHEN NEW.state != 'staged'
    OR NEW.expected_chunk_count != json_array_length(NEW.manifest_json, '$.chunks')
    OR json_extract(NEW.manifest_json, '$.schemaVersion') != 'telemetry-day-manifest-v1.2'
    OR json_extract(NEW.manifest_json, '$.day') != NEW.chunk_day
    THEN RAISE(ABORT, 'telemetry_v12_manifest_invalid') END;
END;

CREATE TRIGGER telemetry_v12_manifest_immutable
BEFORE UPDATE OF id, participant_id, device_id, chunk_day, manifest_digest,
  parser_version, manifest_json, expected_chunk_count, created_at
ON telemetry_v12_day_manifests
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_manifest_immutable'); END;

CREATE TRIGGER telemetry_v12_manifest_ready
BEFORE UPDATE OF state ON telemetry_v12_day_manifests
WHEN NEW.state = 'ready'
BEGIN
  SELECT CASE WHEN OLD.state != 'staged'
    OR NEW.ready_at IS NULL
    OR NEW.expected_chunk_count != (SELECT count(*) FROM telemetry_v12_chunks c WHERE c.manifest_id = NEW.id)
    OR EXISTS (SELECT 1 FROM telemetry_v12_chunks c WHERE c.manifest_id = NEW.id
      AND c.record_count != (SELECT count(*) FROM telemetry_v12_records r WHERE r.chunk_id = c.id))
    THEN RAISE(ABORT, 'telemetry_v12_manifest_incomplete') END;
END;

CREATE TABLE telemetry_v12_domains (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  predecessor_token_hash TEXT NOT NULL REFERENCES telemetry_v12_domain_predecessors(token_hash),
  previous_generation_id TEXT,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  legacy_fingerprint TEXT NOT NULL CHECK (length(legacy_fingerprint) = 64 AND legacy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0),
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  through_day TEXT NOT NULL CHECK (length(through_day) = 10),
  days_json TEXT NOT NULL CHECK (json_valid(days_json) AND length(days_json) <= 1250000),
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, manifest_digest)
) STRICT;

CREATE TRIGGER telemetry_v12_domain_admission
BEFORE INSERT ON telemetry_v12_domains
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v12_domain_predecessors predecessor
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id = predecessor.participant_id
     AND auth.device_id = predecessor.device_id
   WHERE predecessor.token_hash = NEW.predecessor_token_hash
     AND predecessor.participant_id = NEW.participant_id
     AND predecessor.device_id = NEW.device_id
     AND predecessor.consumed_at IS NULL
     AND predecessor.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND predecessor.previous_generation_id IS NEW.previous_generation_id
     AND predecessor.legacy_fingerprint = NEW.legacy_fingerprint
     AND predecessor.input_revision = NEW.input_revision
)
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_transport_blocked'); END;

CREATE TABLE telemetry_v12_domain_days (
  generation_id TEXT NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  observed_day TEXT NOT NULL CHECK (length(observed_day) = 10),
  manifest_id TEXT NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (generation_id, observed_day),
  UNIQUE (generation_id, manifest_id)
) STRICT;

CREATE INDEX telemetry_v12_domain_days_manifest ON telemetry_v12_domain_days(manifest_id);

CREATE TRIGGER telemetry_v12_domain_day_admission
BEFORE INSERT ON telemetry_v12_domain_days
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_v12_domains d
    JOIN telemetry_v12_active_authorizations auth
      ON auth.participant_id = d.participant_id AND auth.device_id = d.device_id
    JOIN telemetry_v12_day_manifests m
      ON m.participant_id = d.participant_id AND m.device_id = d.device_id
   WHERE d.id = NEW.generation_id
     AND m.id = NEW.manifest_id AND m.manifest_digest = NEW.manifest_digest
     AND m.chunk_day = NEW.observed_day AND m.state = 'ready'
)
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_manifest_incomplete'); END;

CREATE TABLE telemetry_v12_domain_heads (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER telemetry_v12_domain_head_immutable
BEFORE UPDATE ON telemetry_v12_domain_heads
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR OLD.revision < 1 OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'telemetry_v12_domain_revision_conflict'); END;

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

DROP TRIGGER storage_v12_head_request_apply;

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
  
  
  UPDATE storage_v11_owner_links SET state='active'
    WHERE participant_id=NEW.participant_id AND state='withdrawn';
  DELETE FROM storage_v12_head_requests WHERE participant_id=NEW.participant_id;
END;

DROP TRIGGER storage_v12_event_publish;

CREATE TRIGGER storage_v12_event_publish AFTER INSERT ON storage_v12_event_sources
BEGIN
  INSERT INTO storage_ingestion_changes(event_digest,owner_digest,revision,kind,object_digest,content_digest,
    authority_epoch,public_authority_epoch,recorded_ms)
  VALUES(NEW.event_digest,NEW.owner_digest,
    COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    'owner-active',NEW.event_digest,NEW.manifest_digest,
    COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1,
    (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)+1,NEW.recorded_ms);
  
  
  UPDATE storage_v11_owner_links SET object_digest=NEW.event_digest,manifest_digest=NEW.manifest_digest
    WHERE participant_id=NEW.participant_id AND generation_id IS NULL;
END;
