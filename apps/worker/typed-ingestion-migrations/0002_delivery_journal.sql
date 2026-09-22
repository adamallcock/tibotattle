-- New-target schema only. Admission integrates journal inserts into its own
-- batch; this migration does not attach triggers to an existing production DB.
CREATE TABLE storage_source_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  source_id TEXT NOT NULL UNIQUE,
  authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch >= 0)
) STRICT;

CREATE TABLE storage_owner_revisions (
  owner_digest TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','withdrawn','erased'))
) STRICT;
CREATE TRIGGER storage_source_identity_immutable BEFORE UPDATE OF source_id ON storage_source_state
BEGIN SELECT RAISE(ABORT,'storage_source_immutable'); END;

CREATE TABLE storage_ingestion_changes (
  sequence INTEGER PRIMARY KEY,
  event_digest TEXT NOT NULL UNIQUE,
  owner_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(kind IN ('source-updated','owner-active','owner-withdrawn','owner-erased')),
  object_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
  public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch > 0),
  recorded_ms INTEGER NOT NULL CHECK(recorded_ms >= 0),
  UNIQUE(owner_digest, revision)
) STRICT;
CREATE INDEX storage_ingestion_owner_cursor ON storage_ingestion_changes(owner_digest,sequence);

CREATE TRIGGER storage_ingestion_change_validate BEFORE INSERT ON storage_ingestion_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_source_state WHERE singleton=1)
    THEN RAISE(ABORT,'storage_source_uninitialized') END;
  SELECT CASE WHEN NEW.revision != COALESCE((SELECT revision FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)+1
    THEN RAISE(ABORT,'storage_owner_revision_conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest AND state='erased')
    THEN RAISE(ABORT,'storage_owner_erased') END;
  SELECT CASE WHEN NEW.kind='source-updated' AND NOT EXISTS(
      SELECT 1 FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest AND state='active')
    THEN RAISE(ABORT,'storage_owner_ineligible') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest)
      AND NEW.kind!='owner-active'
    THEN RAISE(ABORT,'storage_owner_uninitialized') END;
  SELECT CASE WHEN NEW.authority_epoch != COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=NEW.owner_digest),0)
      + CASE WHEN NEW.kind='source-updated' THEN 0 ELSE 1 END
    THEN RAISE(ABORT,'storage_authority_conflict') END;
  SELECT CASE WHEN NEW.public_authority_epoch != (SELECT authority_epoch FROM storage_source_state WHERE singleton=1)
      + CASE WHEN NEW.kind='source-updated' THEN 0 ELSE 1 END
    THEN RAISE(ABORT,'storage_public_authority_conflict') END;
END;

CREATE TRIGGER storage_ingestion_change_commit AFTER INSERT ON storage_ingestion_changes
BEGIN
  INSERT INTO storage_owner_revisions(owner_digest,revision,authority_epoch,state)
    VALUES(NEW.owner_digest,NEW.revision,NEW.authority_epoch,
      CASE NEW.kind WHEN 'owner-withdrawn' THEN 'withdrawn' WHEN 'owner-erased' THEN 'erased' ELSE 'active' END)
    ON CONFLICT(owner_digest) DO UPDATE SET revision=excluded.revision,
      authority_epoch=excluded.authority_epoch,state=excluded.state;
  UPDATE storage_source_state SET authority_epoch=NEW.public_authority_epoch WHERE singleton=1;
END;

CREATE TRIGGER storage_ingestion_change_immutable BEFORE UPDATE ON storage_ingestion_changes
BEGIN SELECT RAISE(ABORT,'storage_event_immutable'); END;
-- Pruning requires a separately qualified checkpoint/archive protocol. It must
-- not silently create holes beneath a consumer's last committed sequence.
CREATE TRIGGER storage_ingestion_change_retained BEFORE DELETE ON storage_ingestion_changes
BEGIN SELECT RAISE(ABORT,'storage_event_retained'); END;
