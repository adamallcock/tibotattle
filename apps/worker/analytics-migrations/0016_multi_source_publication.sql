-- Complete-set publication receipts. Required generations advance separately
-- from publication so routing lag can keep the last complete result while an
-- erasure generation immediately makes every older result unservable.
CREATE TABLE analytics_multi_source_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 routing_generation INTEGER NOT NULL CHECK(routing_generation>=0),
 erasure_generation INTEGER NOT NULL CHECK(erasure_generation>=0),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0)
) STRICT;
INSERT INTO analytics_multi_source_control VALUES(1,0,0,0);

CREATE TRIGGER analytics_multi_source_control_monotonic BEFORE UPDATE ON analytics_multi_source_control
WHEN NEW.singleton!=OLD.singleton OR NEW.routing_generation<OLD.routing_generation
 OR NEW.erasure_generation<OLD.erasure_generation OR NEW.updated_ms<OLD.updated_ms
BEGIN SELECT RAISE(ABORT,'analytics_multi_source_generation_conflict'); END;

CREATE TABLE analytics_multi_source_publications (
 kind TEXT NOT NULL CHECK(kind IN ('daily','allowance')),
 publication_key TEXT NOT NULL CHECK(length(publication_key) BETWEEN 1 AND 64),
 revision INTEGER NOT NULL CHECK(revision>0),
 routing_generation INTEGER NOT NULL CHECK(routing_generation>=0),
 erasure_generation INTEGER NOT NULL CHECK(erasure_generation>=0),
 checkpoints_json TEXT NOT NULL CHECK(json_valid(checkpoints_json)),
 checkpoints_sha256 TEXT NOT NULL CHECK(length(checkpoints_sha256)=64),
 cohort_digest TEXT NOT NULL CHECK(length(cohort_digest)=64),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 released_at TEXT NOT NULL,
 PRIMARY KEY(kind,publication_key,revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE analytics_multi_source_heads (
 kind TEXT NOT NULL CHECK(kind IN ('daily','allowance')),
 publication_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(kind,publication_key),
 FOREIGN KEY(kind,publication_key,revision)
  REFERENCES analytics_multi_source_publications(kind,publication_key,revision)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER analytics_multi_source_revision_order BEFORE INSERT ON analytics_multi_source_publications
BEGIN
 SELECT CASE WHEN NEW.revision!=COALESCE((SELECT revision FROM analytics_multi_source_heads
   WHERE kind=NEW.kind AND publication_key=NEW.publication_key),0)+1
  THEN RAISE(ABORT,'analytics_multi_source_revision_conflict') END;
 SELECT CASE WHEN NEW.routing_generation!=(SELECT routing_generation FROM analytics_multi_source_control WHERE singleton=1)
   OR NEW.erasure_generation!=(SELECT erasure_generation FROM analytics_multi_source_control WHERE singleton=1)
  THEN RAISE(ABORT,'analytics_multi_source_generation_stale') END;
END;

CREATE TRIGGER analytics_multi_source_head_advance AFTER INSERT ON analytics_multi_source_publications
BEGIN
 INSERT INTO analytics_multi_source_heads(kind,publication_key,revision)
 VALUES(NEW.kind,NEW.publication_key,NEW.revision)
 ON CONFLICT(kind,publication_key) DO UPDATE SET revision=excluded.revision;
END;

CREATE TRIGGER analytics_multi_source_publication_immutable BEFORE UPDATE ON analytics_multi_source_publications
BEGIN SELECT RAISE(ABORT,'analytics_multi_source_publication_immutable'); END;
