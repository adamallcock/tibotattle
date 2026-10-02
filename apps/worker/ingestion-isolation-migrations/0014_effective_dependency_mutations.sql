-- Local/source-side optional exact-dependency cache token. Native dependency
-- bytes and analytical authority remain unchanged. Counters are participant-
-- wide, including metadata outside any requested range, plus a global runtime
-- /namespace revision. No independent day-counter MAX is used.
--
-- Typed v1 event admission seals complete proofs before publication. Typed
-- v1.1 ready transitions seal compact proofs, and retained proof deletion is
-- guarded. V1.2 staged records become eligible at ready/domain metadata. Thus
-- no per-record/proof INSERT trigger is added. Exceptional DELETE paths need
-- coverage because a deleted v1.2 record can alter completeness by itself.
-- Correction history auto-inserts its fact atomically even for direct SQL;
-- fact INSERT is its enforced seal, including unchanged owner revision/CAS.
--
-- BEFORE DELETE resolves participant scope before FK cascades; when a parent
-- has already disappeared, the global counter conservatively invalidates all.
-- Auth expiry is a clock event, handled by the token reader's earliest future
-- lease boundary and expired-grant phase rather than a nonexistent SQL write.
-- Source-ahead terminal containment must not scan the nonterminal journal.
-- The unchanged native MAX predicate matches this partial index exactly;
-- SQLite can read its greatest terminal epoch directly. Terminal history and
-- ordered delivery receipts remain retained.
CREATE INDEX storage_ingestion_terminal_epoch
  ON storage_ingestion_changes(public_authority_epoch)
  WHERE kind IN('owner-withdrawn','owner-erased');

CREATE TABLE storage_effective_dependency_mutation_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  method TEXT NOT NULL CHECK(method='effective-dependency-mutation-v1'),
  global_revision INTEGER NOT NULL CHECK(global_revision BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE storage_effective_dependency_owner_mutations (
  participant_id TEXT PRIMARY KEY CHECK(length(participant_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER storage_effective_mutation_runtime_guard BEFORE UPDATE ON storage_effective_dependency_mutation_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.method IS NOT OLD.method OR NEW.global_revision!=OLD.global_revision+1
BEGIN SELECT RAISE(ABORT,'storage_effective_mutation_runtime_invalid'); END;
CREATE TRIGGER storage_effective_mutation_runtime_retained BEFORE DELETE ON storage_effective_dependency_mutation_runtime
BEGIN SELECT RAISE(ABORT,'storage_effective_mutation_runtime_retained'); END;
CREATE TRIGGER storage_effective_mutation_owner_insert_guard BEFORE INSERT ON storage_effective_dependency_owner_mutations
WHEN NEW.revision!=1 OR NOT (EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased')))
BEGIN SELECT RAISE(ABORT,'storage_effective_mutation_owner_invalid'); END;
CREATE TRIGGER storage_effective_mutation_owner_guard BEFORE UPDATE ON storage_effective_dependency_owner_mutations
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'storage_effective_mutation_owner_invalid'); END;
CREATE TRIGGER storage_effective_mutation_owner_retained BEFORE DELETE ON storage_effective_dependency_owner_mutations
WHEN EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
BEGIN SELECT RAISE(ABORT,'storage_effective_mutation_owner_retained'); END;
CREATE TRIGGER storage_effective_mutation_participants_insert AFTER INSERT ON participants
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.id,1 WHERE (1 AND NEW.id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_participants_update BEFORE UPDATE ON participants
WHEN NEW.id IS NOT OLD.id OR NEW.state IS NOT OLD.state OR NEW.consent_version IS NOT OLD.consent_version OR NEW.owner_kind IS NOT OLD.owner_kind
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.id,1 WHERE (1 AND OLD.id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.id,1 WHERE (NEW.id IS NOT OLD.id AND NEW.id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.id IS NOT OLD.id AND NEW.id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_participants_delete BEFORE DELETE ON participants
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.id,1 WHERE (1 AND OLD.id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_device_credentials_insert AFTER INSERT ON device_credentials
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_device_credentials_update BEFORE UPDATE ON device_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.state IS NOT OLD.state OR NEW.authority_kind IS NOT OLD.authority_kind OR NEW.accountless_enrollment_device_id IS NOT OLD.accountless_enrollment_device_id OR ((OLD.authority_kind='accountless' OR NEW.authority_kind='accountless') AND NEW.expires_at IS NOT OLD.expires_at)
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_device_credentials_delete BEFORE DELETE ON device_credentials
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_owner_links_insert AFTER INSERT ON storage_v11_owner_links
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_owner_links_update BEFORE UPDATE ON storage_v11_owner_links
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.state IS NOT OLD.state
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_owner_links_delete BEFORE DELETE ON storage_v11_owner_links
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_owner_revisions_insert AFTER INSERT ON storage_owner_revisions
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest),1 WHERE (1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_owner_revisions_update BEFORE UPDATE ON storage_owner_revisions
WHEN NEW.owner_digest IS NOT OLD.owner_digest OR NEW.state IS NOT OLD.state OR NEW.authority_epoch IS NOT OLD.authority_epoch
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest),1 WHERE (1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest),1 WHERE ((SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NOT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_owner_revisions_delete BEFORE DELETE ON storage_owner_revisions
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest),1 WHERE (1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=OLD.owner_digest) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v1_chunks_insert AFTER INSERT ON telemetry_v1_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v1_chunks_update BEFORE UPDATE ON telemetry_v1_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.revision IS NOT OLD.revision OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.accepted_record_count IS NOT OLD.accepted_record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.superseded_at IS NOT OLD.superseded_at OR NEW.quarantine_deleted_at IS NOT OLD.quarantine_deleted_at OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v1_chunks_delete BEFORE DELETE ON telemetry_v1_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_event_sources_insert AFTER INSERT ON typed_v1_event_sources
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_event_sources_update BEFORE UPDATE ON typed_v1_event_sources
WHEN NEW.event_digest IS NOT OLD.event_digest OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.participant_id IS NOT OLD.participant_id OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.source_namespace IS NOT OLD.source_namespace
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_event_sources_delete BEFORE DELETE ON typed_v1_event_sources
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_owner_memberships_insert AFTER INSERT ON typed_v1_owner_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_owner_memberships_update BEFORE UPDATE ON typed_v1_owner_memberships
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.typed_owner_id IS NOT OLD.typed_owner_id
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_owner_memberships_delete BEFORE DELETE ON typed_v1_owner_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_chunk_allocations_insert AFTER INSERT ON typed_v1_chunk_allocations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_chunk_allocations_update BEFORE UPDATE ON typed_v1_chunk_allocations
WHEN NEW.chunk_id IS NOT OLD.chunk_id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.chunk_original IS NOT OLD.chunk_original OR NEW.first_source_row_id IS NOT OLD.first_source_row_id OR NEW.record_count IS NOT OLD.record_count
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id),1 WHERE ((SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NOT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_chunk_allocations_delete BEFORE DELETE ON typed_v1_chunk_allocations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_day_manifests_insert AFTER INSERT ON telemetry_v11_day_manifests
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_day_manifests_update BEFORE UPDATE ON telemetry_v11_day_manifests
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.expected_chunk_count IS NOT OLD.expected_chunk_count OR NEW.state IS NOT OLD.state OR NEW.created_at IS NOT OLD.created_at OR NEW.ready_at IS NOT OLD.ready_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_day_manifests_delete BEFORE DELETE ON telemetry_v11_day_manifests
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_chunks_insert AFTER INSERT ON telemetry_v11_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_chunks_update BEFORE UPDATE ON telemetry_v11_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.quarantine_deleted_at IS NOT OLD.quarantine_deleted_at OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_chunks_delete BEFORE DELETE ON telemetry_v11_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domains_insert AFTER INSERT ON telemetry_v11_domains
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domains_update BEFORE UPDATE ON telemetry_v11_domains
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.predecessor_token_hash IS NOT OLD.predecessor_token_hash OR NEW.previous_generation_id IS NOT OLD.previous_generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.days_json IS NOT OLD.days_json OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domains_delete BEFORE DELETE ON telemetry_v11_domains
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domain_days_insert AFTER INSERT ON telemetry_v11_domain_days
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domain_days_update BEFORE UPDATE ON telemetry_v11_domain_days
WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.observed_day IS NOT OLD.observed_day OR NEW.manifest_id IS NOT OLD.manifest_id
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id),1 WHERE ((SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NOT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_domain_days_delete BEFORE DELETE ON telemetry_v11_domain_days
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_domains WHERE id=OLD.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_event_sources_insert AFTER INSERT ON storage_v11_event_sources
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_event_sources_update BEFORE UPDATE ON storage_v11_event_sources
WHEN NEW.event_digest IS NOT OLD.event_digest OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.generation_id IS NOT OLD.generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.head_revision IS NOT OLD.head_revision OR NEW.input_revision IS NOT OLD.input_revision OR NEW.recorded_ms IS NOT OLD.recorded_ms
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_v11_event_sources_delete BEFORE DELETE ON storage_v11_event_sources
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_owner_memberships_insert AFTER INSERT ON typed_v11_owner_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_owner_memberships_update BEFORE UPDATE ON typed_v11_owner_memberships
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.typed_owner_id IS NOT OLD.typed_owner_id
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_owner_memberships_delete BEFORE DELETE ON typed_v11_owner_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_manifest_memberships_insert AFTER INSERT ON typed_v11_manifest_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_manifest_memberships_update BEFORE UPDATE ON typed_v11_manifest_memberships
WHEN NEW.manifest_id IS NOT OLD.manifest_id OR NEW.typed_manifest_id IS NOT OLD.typed_manifest_id
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id),1 WHERE ((SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NOT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=NEW.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_manifest_memberships_delete BEFORE DELETE ON typed_v11_manifest_memberships
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_day_manifests WHERE id=OLD.manifest_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_chunk_allocations_insert AFTER INSERT ON typed_v11_chunk_allocations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_chunk_allocations_update BEFORE UPDATE ON typed_v11_chunk_allocations
WHEN NEW.chunk_id IS NOT OLD.chunk_id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.chunk_original IS NOT OLD.chunk_original OR NEW.first_source_row_id IS NOT OLD.first_source_row_id OR NEW.record_count IS NOT OLD.record_count
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id),1 WHERE ((SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NOT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=NEW.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_chunk_allocations_delete BEFORE DELETE ON typed_v11_chunk_allocations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v11_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_day_manifests_insert AFTER INSERT ON telemetry_v12_day_manifests
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_day_manifests_update BEFORE UPDATE ON telemetry_v12_day_manifests
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.expected_chunk_count IS NOT OLD.expected_chunk_count OR NEW.state IS NOT OLD.state OR NEW.created_at IS NOT OLD.created_at OR NEW.ready_at IS NOT OLD.ready_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_day_manifests_delete BEFORE DELETE ON telemetry_v12_day_manifests
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_chunks_insert AFTER INSERT ON telemetry_v12_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_chunks_update BEFORE UPDATE ON telemetry_v12_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day OR NEW.chunk_seq IS NOT OLD.chunk_seq OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.chunk_digest IS NOT OLD.chunk_digest OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.parser_version IS NOT OLD.parser_version OR NEW.record_count IS NOT OLD.record_count OR NEW.r2_key IS NOT OLD.r2_key OR NEW.device_upload_authorization_id IS NOT OLD.device_upload_authorization_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_chunks_delete BEFORE DELETE ON telemetry_v12_chunks
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domains_insert AFTER INSERT ON telemetry_v12_domains
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domains_update BEFORE UPDATE ON telemetry_v12_domains
WHEN NEW.id IS NOT OLD.id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.predecessor_token_hash IS NOT OLD.predecessor_token_hash OR NEW.previous_generation_id IS NOT OLD.previous_generation_id OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.legacy_fingerprint IS NOT OLD.legacy_fingerprint OR NEW.input_revision IS NOT OLD.input_revision OR NEW.from_day IS NOT OLD.from_day OR NEW.through_day IS NOT OLD.through_day OR NEW.days_json IS NOT OLD.days_json OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domains_delete BEFORE DELETE ON telemetry_v12_domains
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_days_insert AFTER INSERT ON telemetry_v12_domain_days
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_days_update BEFORE UPDATE ON telemetry_v12_domain_days
WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.observed_day IS NOT OLD.observed_day OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.manifest_digest IS NOT OLD.manifest_digest
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id),1 WHERE ((SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NOT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=NEW.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_days_delete BEFORE DELETE ON telemetry_v12_domain_days
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v12_domains WHERE id=OLD.generation_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_heads_insert AFTER INSERT ON telemetry_v12_domain_heads
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_heads_update BEFORE UPDATE ON telemetry_v12_domain_heads
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.generation_id IS NOT OLD.generation_id OR NEW.revision IS NOT OLD.revision OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_domain_heads_delete BEFORE DELETE ON telemetry_v12_domain_heads
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_device_capabilities_insert AFTER INSERT ON telemetry_v12_device_capabilities
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_device_capabilities_update BEFORE UPDATE ON telemetry_v12_device_capabilities
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.state IS NOT OLD.state OR NEW.consented_at IS NOT OLD.consented_at OR NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_device_capabilities_delete BEFORE DELETE ON telemetry_v12_device_capabilities
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v12_device_authorizations_insert AFTER INSERT ON accountless_v12_device_authorizations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v12_device_authorizations_update BEFORE UPDATE ON accountless_v12_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v12_device_authorizations_delete BEFORE DELETE ON accountless_v12_device_authorizations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_upload_owners_insert AFTER INSERT ON accountless_upload_owners
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_upload_owners_update BEFORE UPDATE ON accountless_upload_owners
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_upload_owners_delete BEFORE DELETE ON accountless_upload_owners
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v11_device_authorizations_insert AFTER INSERT ON accountless_v11_device_authorizations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v11_device_authorizations_update BEFORE UPDATE ON accountless_v11_device_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id OR NEW.participant_id IS NOT OLD.participant_id OR NEW.device_credential_id IS NOT OLD.device_credential_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.authorized_at IS NOT OLD.authorized_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.state IS NOT OLD.state OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_accountless_v11_device_authorizations_delete BEFORE DELETE ON accountless_v11_device_authorizations
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_device_consents_insert AFTER INSERT ON telemetry_v11_device_consents
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (1 AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_device_consents_update BEFORE UPDATE ON telemetry_v11_device_consents
WHEN NEW.participant_id IS NOT OLD.participant_id OR NEW.device_id IS NOT OLD.device_id OR NEW.telemetry_schema_version IS NOT OLD.telemetry_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.consented_at IS NOT OLD.consented_at
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT NEW.participant_id,1 WHERE (NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=NEW.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=NEW.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND NEW.participant_id IS NOT OLD.participant_id AND NEW.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v11_device_consents_delete BEFORE DELETE ON telemetry_v11_device_consents
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT OLD.participant_id,1 WHERE (1 AND OLD.participant_id IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=OLD.participant_id AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND OLD.participant_id IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_storage_source_state_insert AFTER INSERT ON storage_source_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_storage_source_state_update BEFORE UPDATE ON storage_source_state
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.source_id IS NOT OLD.source_id OR NEW.authority_epoch IS NOT OLD.authority_epoch
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_storage_source_state_delete BEFORE DELETE ON storage_source_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_telemetry_schema_insert AFTER INSERT ON typed_telemetry_schema
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_telemetry_schema_update BEFORE UPDATE ON typed_telemetry_schema
WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_telemetry_schema_delete BEFORE DELETE ON typed_telemetry_schema
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_usage_correction_runtime_insert AFTER INSERT ON telemetry_usage_correction_runtime
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_usage_correction_runtime_update BEFORE UPDATE ON telemetry_usage_correction_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.method_version IS NOT OLD.method_version OR NEW.state IS NOT OLD.state OR NEW.max_capture_rows IS NOT OLD.max_capture_rows OR NEW.max_history_page IS NOT OLD.max_history_page
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_usage_correction_runtime_delete BEFORE DELETE ON telemetry_usage_correction_runtime
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_runtime_insert AFTER INSERT ON telemetry_v12_runtime
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_runtime_update BEFORE UPDATE ON telemetry_v12_runtime
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.envelope_schema_version IS NOT OLD.envelope_schema_version OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version OR NEW.state IS NOT OLD.state OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.max_day_chunks IS NOT OLD.max_day_chunks OR NEW.max_chunk_records IS NOT OLD.max_chunk_records OR NEW.max_day_bytes IS NOT OLD.max_day_bytes OR NEW.changed_at IS NOT OLD.changed_at
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_telemetry_v12_runtime_delete BEFORE DELETE ON telemetry_v12_runtime
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_ingestion_analytics_separation_insert AFTER INSERT ON ingestion_analytics_separation
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_ingestion_analytics_separation_update BEFORE UPDATE ON ingestion_analytics_separation
WHEN NEW.id IS NOT OLD.id OR NEW.phase IS NOT OLD.phase OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.empty_source_check IS NOT OLD.empty_source_check
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_ingestion_analytics_separation_delete BEFORE DELETE ON ingestion_analytics_separation
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_collection_controls_insert AFTER INSERT ON collection_controls
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_collection_controls_update BEFORE UPDATE ON collection_controls
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version OR NEW.enrollment_enabled IS NOT OLD.enrollment_enabled OR NEW.upload_registration_enabled IS NOT OLD.upload_registration_enabled OR NEW.processing_enabled IS NOT OLD.processing_enabled OR NEW.publication_enabled IS NOT OLD.publication_enabled OR NEW.control_state IS NOT OLD.control_state OR NEW.revision IS NOT OLD.revision OR NEW.reason_code IS NOT OLD.reason_code OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_collection_controls_delete BEFORE DELETE ON collection_controls
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_accountless_enrollment_ledger_insert AFTER INSERT ON accountless_enrollment_ledger
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_accountless_enrollment_ledger_update BEFORE UPDATE ON accountless_enrollment_ledger
WHEN NEW.device_id IS NOT OLD.device_id OR NEW.device_secret_hash IS NOT OLD.device_secret_hash OR NEW.installation_principal_id IS NOT OLD.installation_principal_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.policy_version IS NOT OLD.policy_version OR NEW.authorization_basis IS NOT OLD.authorization_basis OR NEW.state IS NOT OLD.state OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason OR NEW.renewal_generation IS NOT OLD.renewal_generation OR NEW.renewed_at IS NOT OLD.renewed_at
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_accountless_enrollment_ledger_delete BEFORE DELETE ON accountless_enrollment_ledger
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_admission_state_insert AFTER INSERT ON typed_v1_admission_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_admission_state_update BEFORE UPDATE ON typed_v1_admission_state
WHEN NEW.runtime_contract_version IS NOT OLD.runtime_contract_version OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.namespace_id IS NOT OLD.namespace_id
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_admission_state_delete BEFORE DELETE ON typed_v1_admission_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_admission_state_insert AFTER INSERT ON typed_v11_admission_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_admission_state_update BEFORE UPDATE ON typed_v11_admission_state
WHEN NEW.runtime_contract_version IS NOT OLD.runtime_contract_version OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.namespace_id IS NOT OLD.namespace_id
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_admission_state_delete BEFORE DELETE ON typed_v11_admission_state
BEGIN
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;

CREATE TRIGGER storage_effective_mutation_correction_fact_insert AFTER INSERT ON telemetry_usage_correction_facts
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=NEW.history_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_correction_fact_delete BEFORE DELETE ON telemetry_usage_correction_facts
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_usage_correction_history WHERE id=OLD.history_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_v12_record_delete BEFORE DELETE ON telemetry_v12_records
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v12_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v1_record_admissions_delete BEFORE DELETE ON typed_v1_record_admissions
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id),1 WHERE (1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM telemetry_v1_chunks WHERE id=OLD.chunk_id) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_v11_record_proofs_delete BEFORE DELETE ON typed_v11_record_proofs
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key),1 WHERE (1 AND (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT m.participant_id FROM typed_v11_manifest_memberships p JOIN telemetry_v11_day_manifests m ON m.id=p.manifest_id WHERE p.typed_manifest_id=OLD.manifest_key) IS NULL;
END;

CREATE TRIGGER storage_effective_mutation_typed_record_delete BEFORE DELETE ON typed_telemetry_records
BEGIN
  INSERT INTO storage_effective_dependency_owner_mutations(participant_id,revision)
    SELECT (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1),1 WHERE (1 AND (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) IS NOT NULL) AND EXISTS(SELECT 1 FROM participants WHERE id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1)) AND NOT EXISTS(SELECT 1 FROM storage_v11_owner_links l LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest WHERE l.participant_id=(SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) AND (l.state='erased' OR o.state='erased'))
    ON CONFLICT(participant_id) DO UPDATE SET revision=revision+1;
  UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1
    WHERE id=1 AND 1 AND (SELECT participant_id FROM typed_v1_owner_memberships WHERE typed_owner_id=OLD.owner_id UNION SELECT participant_id FROM typed_v11_owner_memberships WHERE typed_owner_id=OLD.owner_id LIMIT 1) IS NULL;
END;

-- Seal after the complete trigger inventory exists. Prior histories use revision zero.
INSERT INTO storage_effective_dependency_mutation_runtime(id,method,global_revision)
VALUES(1,'effective-dependency-mutation-v1',0);

-- Erasure is a physical fence. Routine opt-out/authorization expiry does not
-- enter these branches and cannot delete retained source metadata.
CREATE TRIGGER storage_effective_mutation_participant_erase AFTER DELETE ON participants
BEGIN
 DELETE FROM storage_effective_dependency_owner_mutations WHERE participant_id=OLD.id;
 UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;
CREATE TRIGGER storage_effective_mutation_owner_erase AFTER UPDATE ON storage_owner_revisions WHEN NEW.state='erased'
BEGIN
 DELETE FROM storage_effective_dependency_owner_mutations WHERE participant_id=(SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=NEW.owner_digest);
 UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;
CREATE TRIGGER storage_effective_mutation_link_erase AFTER UPDATE ON storage_v11_owner_links WHEN NEW.state='erased'
BEGIN
 DELETE FROM storage_effective_dependency_owner_mutations WHERE participant_id=NEW.participant_id;
 UPDATE storage_effective_dependency_mutation_runtime SET global_revision=global_revision+1 WHERE id=1;
END;
