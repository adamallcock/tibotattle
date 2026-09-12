-- Derived publication only. The source-owned privacy and policy stamp is
-- rechecked when building and serving; this DB never grants upload authority.
CREATE TABLE analytics_community_daily_owners (
 source_id TEXT NOT NULL,day TEXT NOT NULL,owner_digest TEXT NOT NULL,
 input_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,
 source_format TEXT NOT NULL CHECK(source_format IN ('v1','v11')),
 method TEXT NOT NULL,progress_revision INTEGER NOT NULL CHECK(progress_revision>0),
 next_index INTEGER NOT NULL CHECK(next_index>=0),fingerprint TEXT,
 complete INTEGER NOT NULL CHECK(complete IN (0,1)),
 values_json TEXT NOT NULL CHECK(json_valid(values_json)),
 PRIMARY KEY(source_id,day,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_community_daily_owner_cleanup
 ON analytics_community_daily_owners(source_id,owner_digest,day);

CREATE TABLE analytics_community_daily_queue (
 source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(source_id,day)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_community_daily_publications (
 source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),payload_sha256 TEXT NOT NULL,
 released_at TEXT NOT NULL,
 PRIMARY KEY(source_id,day,revision)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_community_daily_heads (
 source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 cohort_digest TEXT NOT NULL,PRIMARY KEY(source_id,day)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_community_daily_revision_order
 BEFORE INSERT ON analytics_community_daily_publications
BEGIN
 SELECT CASE WHEN NEW.revision!=COALESCE((SELECT revision FROM analytics_community_daily_heads
   WHERE source_id=NEW.source_id AND day=NEW.day),0)+1
   THEN RAISE(ABORT,'analytics_community_daily_revision_conflict') END;
END;
CREATE TRIGGER analytics_community_daily_head_advance
 AFTER INSERT ON analytics_community_daily_publications
BEGIN
 INSERT INTO analytics_community_daily_heads VALUES(NEW.source_id,NEW.day,NEW.revision,NEW.cohort_digest)
 ON CONFLICT(source_id,day) DO UPDATE SET revision=excluded.revision,cohort_digest=excluded.cohort_digest;
END;
CREATE TRIGGER analytics_community_daily_revision_immutable
 BEFORE UPDATE ON analytics_community_daily_publications
BEGIN SELECT RAISE(ABORT,'analytics_community_daily_revision_immutable'); END;

CREATE TRIGGER analytics_community_daily_v1_insert AFTER INSERT ON analytics_v1_chunk_values
BEGIN
 INSERT INTO analytics_community_daily_queue VALUES(NEW.source_id,NEW.observed_day,1)
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_v1_update AFTER UPDATE ON analytics_v1_chunk_values
BEGIN
 INSERT INTO analytics_community_daily_queue VALUES(NEW.source_id,NEW.observed_day,1)
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_v1_delete BEFORE DELETE ON analytics_v1_chunk_values
BEGIN
 INSERT INTO analytics_community_daily_queue VALUES(OLD.source_id,OLD.observed_day,1)
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_v11_insert AFTER INSERT ON analytics_v11_owner_heads
BEGIN
 INSERT INTO analytics_community_daily_queue
 SELECT NEW.source_id,d.day,1 FROM analytics_v11_day_values d
 WHERE d.source_id=NEW.source_id AND d.event_digest=NEW.event_digest
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_v11_update AFTER UPDATE ON analytics_v11_owner_heads
BEGIN
 INSERT INTO analytics_community_daily_queue
 SELECT NEW.source_id,d.day,1 FROM analytics_v11_day_values d
 WHERE d.source_id=NEW.source_id AND d.event_digest IN(NEW.event_digest,OLD.event_digest)
 GROUP BY d.day
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_v11_delete BEFORE DELETE ON analytics_v11_owner_heads
BEGIN
 INSERT INTO analytics_community_daily_queue
 SELECT OLD.source_id,d.day,1 FROM analytics_v11_day_values d
 WHERE d.source_id=OLD.source_id AND d.event_digest=OLD.event_digest
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER analytics_community_daily_owner_terminal AFTER UPDATE ON analytics_owner_state
WHEN NEW.state IN ('withdrawn','erased')
BEGIN
 INSERT INTO analytics_community_daily_queue
 SELECT source_id,day,1 FROM analytics_community_daily_owners
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest
 ON CONFLICT(source_id,day) DO UPDATE SET revision=revision+1;
END;
