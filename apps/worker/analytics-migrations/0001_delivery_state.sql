-- An empty analytics target is deliberately unavailable until its ingestion
-- authority epoch is matched. Projection tables are separate from this journal.
CREATE TABLE analytics_source_cursors (
  source_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch>=0)
) STRICT;
CREATE TABLE analytics_owner_state (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
  state TEXT NOT NULL CHECK(state IN ('active','withdrawn','erased')),
  PRIMARY KEY(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_applied_events (
  source_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_digest TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  object_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL,
  public_authority_epoch INTEGER NOT NULL,
  recorded_ms INTEGER NOT NULL,
  PRIMARY KEY(source_id,sequence),
  UNIQUE(source_id,event_digest)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER analytics_delivery_validate BEFORE INSERT ON analytics_applied_events
BEGIN
  SELECT CASE WHEN NEW.sequence!=COALESCE((SELECT sequence FROM analytics_source_cursors WHERE source_id=NEW.source_id),0)+1
    THEN RAISE(ABORT,'analytics_sequence_conflict') END;
  SELECT CASE WHEN NEW.revision!=COALESCE((SELECT revision FROM analytics_owner_state
      WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest),0)+1
    THEN RAISE(ABORT,'analytics_owner_revision_conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM analytics_owner_state
      WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
    THEN RAISE(ABORT,'analytics_owner_erased') END;
  SELECT CASE WHEN NEW.kind NOT IN ('source-updated','owner-active','owner-withdrawn','owner-erased')
    OR (NEW.kind='source-updated' AND NOT EXISTS(SELECT 1 FROM analytics_owner_state
      WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='active'))
    THEN RAISE(ABORT,'analytics_owner_ineligible') END;
  SELECT CASE WHEN NEW.kind!='owner-active' AND NOT EXISTS(SELECT 1 FROM analytics_owner_state
      WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
    THEN RAISE(ABORT,'analytics_owner_uninitialized') END;
  SELECT CASE WHEN NEW.authority_epoch!=COALESCE((SELECT authority_epoch FROM analytics_owner_state
      WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest),0)
      + CASE WHEN NEW.kind='source-updated' THEN 0 ELSE 1 END
    THEN RAISE(ABORT,'analytics_authority_conflict') END;
  SELECT CASE WHEN NEW.public_authority_epoch!=COALESCE((SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=NEW.source_id),0)
      + CASE WHEN NEW.kind='source-updated' THEN 0 ELSE 1 END
    THEN RAISE(ABORT,'analytics_public_authority_conflict') END;
END;
CREATE TRIGGER analytics_delivery_commit AFTER INSERT ON analytics_applied_events
BEGIN
  INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES(NEW.source_id,NEW.owner_digest,NEW.revision,NEW.authority_epoch,
      CASE NEW.kind WHEN 'owner-withdrawn' THEN 'withdrawn' WHEN 'owner-erased' THEN 'erased' ELSE 'active' END)
    ON CONFLICT(source_id,owner_digest) DO UPDATE SET revision=excluded.revision,
      authority_epoch=excluded.authority_epoch,state=excluded.state;
  INSERT INTO analytics_source_cursors(source_id,sequence,authority_epoch)
    VALUES(NEW.source_id,NEW.sequence,NEW.public_authority_epoch)
    ON CONFLICT(source_id) DO UPDATE SET sequence=excluded.sequence,authority_epoch=excluded.authority_epoch;
END;
CREATE TRIGGER analytics_delivery_immutable BEFORE UPDATE ON analytics_applied_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;
