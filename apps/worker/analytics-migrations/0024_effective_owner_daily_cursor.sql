-- The version-neutral daily reader stores a resumable cursor alongside the
-- existing folded values. This forward-only rebuild widens the source marker;
-- it does not alter any value, pricing, cache-retention, or publication math.
PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS analytics_daily_owner_erased_insert;
DROP TRIGGER IF EXISTS analytics_daily_owner_erased_update;
DROP TRIGGER IF EXISTS analytics_community_daily_owner_terminal;
DROP TRIGGER IF EXISTS analytics_daily_containment_delivered;
DROP TRIGGER IF EXISTS analytics_daily_containment_inserted;
DROP TRIGGER IF EXISTS analytics_daily_containment_fenced;
ALTER TABLE analytics_community_daily_owners RENAME TO analytics_community_daily_owners_v1;

CREATE TABLE analytics_community_daily_owners (
 source_id TEXT NOT NULL,day TEXT NOT NULL,owner_digest TEXT NOT NULL,
 input_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,
 source_format TEXT NOT NULL CHECK(source_format IN ('v1','v11','effective')),
 method TEXT NOT NULL,progress_revision INTEGER NOT NULL CHECK(progress_revision>0),
 next_index INTEGER NOT NULL CHECK(next_index>=0),fingerprint TEXT,
 complete INTEGER NOT NULL CHECK(complete IN (0,1)),
 values_json TEXT NOT NULL CHECK(json_valid(values_json)),
 PRIMARY KEY(source_id,day,owner_digest)
) STRICT, WITHOUT ROWID;
INSERT INTO analytics_community_daily_owners
  (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,
   progress_revision,next_index,fingerprint,complete,values_json)
SELECT source_id,day,owner_digest,input_revision,owner_revision,source_format,method,
       progress_revision,next_index,fingerprint,complete,values_json
  FROM analytics_community_daily_owners_v1;
DROP TABLE analytics_community_daily_owners_v1;
CREATE INDEX analytics_community_daily_owner_cleanup
 ON analytics_community_daily_owners(source_id,owner_digest,day);

CREATE TRIGGER analytics_daily_owner_erased_insert BEFORE INSERT ON analytics_community_daily_owners
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
 OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_erased'); END;
CREATE TRIGGER analytics_daily_owner_erased_update BEFORE UPDATE ON analytics_community_daily_owners
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
 OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_erased'); END;

CREATE TRIGGER analytics_community_daily_owner_terminal AFTER UPDATE ON analytics_owner_state
WHEN NEW.state IN ('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_queue
 SELECT source_id,day,1 FROM analytics_community_daily_owners
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER analytics_daily_containment_delivered AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state IN('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,COALESCE(
  (SELECT MAX(e.public_authority_epoch) FROM analytics_applied_events e
   WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest AND e.kind IN('owner-withdrawn','owner-erased')),
  (SELECT s.authority_epoch+1 FROM analytics_source_cursors s WHERE s.source_id=NEW.source_id),1)
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;

CREATE TRIGGER analytics_daily_containment_inserted AFTER INSERT ON analytics_owner_state
WHEN NEW.state IN('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,COALESCE(
  (SELECT MAX(e.public_authority_epoch) FROM analytics_applied_events e
   WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest AND e.kind IN('owner-withdrawn','owner-erased')),
  (SELECT s.authority_epoch+1 FROM analytics_source_cursors s WHERE s.source_id=NEW.source_id),1)
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;

CREATE TRIGGER analytics_daily_containment_fenced AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 INSERT INTO analytics_community_daily_containment(source_id,day,owner_digest,terminal_public_authority_epoch)
 SELECT c.source_id,c.day,c.owner_digest,NEW.public_authority_epoch
 FROM analytics_community_daily_owners c WHERE c.source_id=NEW.source_id AND c.owner_digest=NEW.owner_digest
  AND (CASE WHEN json_valid(c.values_json) THEN COALESCE(json_extract(c.values_json,'$.counts.usage'),1)
   +COALESCE(json_extract(c.values_json,'$.counts.quota'),1)+COALESCE(json_extract(c.values_json,'$.counts.session'),1) ELSE 1 END)>0
 ON CONFLICT(source_id,day,owner_digest) DO UPDATE SET
  terminal_public_authority_epoch=max(terminal_public_authority_epoch,excluded.terminal_public_authority_epoch);
END;

PRAGMA foreign_keys = ON;
