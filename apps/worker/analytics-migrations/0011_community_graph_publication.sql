-- Derived public aggregates only. Exact calculation results stay private in
-- 0008; these rows contain the maintained aggregate DTOs, never owner payloads.
CREATE TABLE analytics_community_model_publications (
 source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 method TEXT NOT NULL,cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=16384),
 payload_sha256 TEXT NOT NULL,computed_ms INTEGER NOT NULL,
 PRIMARY KEY(source_id,day)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_community_graph_publication_state (
 source_id TEXT PRIMARY KEY,model_revision INTEGER NOT NULL CHECK(model_revision>0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_community_model_published_insert AFTER INSERT ON analytics_community_model_publications
BEGIN
 INSERT INTO analytics_community_graph_publication_state VALUES(NEW.source_id,1)
 ON CONFLICT(source_id) DO UPDATE SET model_revision=model_revision+1;
END;
CREATE TRIGGER analytics_community_model_published_update AFTER UPDATE ON analytics_community_model_publications
BEGIN
 INSERT INTO analytics_community_graph_publication_state VALUES(NEW.source_id,1)
 ON CONFLICT(source_id) DO UPDATE SET model_revision=model_revision+1;
END;
CREATE TRIGGER analytics_community_model_published_delete AFTER DELETE ON analytics_community_model_publications
BEGIN
 INSERT INTO analytics_community_graph_publication_state VALUES(OLD.source_id,1)
 ON CONFLICT(source_id) DO UPDATE SET model_revision=model_revision+1;
END;
 -- This is a completed-result snapshot, not a claim that every owner was
 -- recalculated at publication time. Keep freshness separate from public DTOs.
CREATE TABLE analytics_community_graph_previews (
 source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),method TEXT NOT NULL,
 cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
 model_revision INTEGER NOT NULL CHECK(model_revision>=0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=262144),
 payload_sha256 TEXT NOT NULL,generated_at TEXT NOT NULL,


 snapshot_source_epoch INTEGER NOT NULL CHECK(snapshot_source_epoch>=0),
 inputs_current INTEGER NOT NULL CHECK(inputs_current IN(0,1)),
 oldest_computed_ms INTEGER,newest_computed_ms INTEGER,
 CHECK((oldest_computed_ms IS NULL AND newest_computed_ms IS NULL) OR
   (oldest_computed_ms IS NOT NULL AND newest_computed_ms IS NOT NULL
    AND oldest_computed_ms>=0 AND newest_computed_ms>=oldest_computed_ms))
) STRICT, WITHOUT ROWID;
