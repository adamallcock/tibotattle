-- Private analytical work only. No ingestion authority or source records are
-- copied. Every stage is immutable; promotion changes one exact head by CAS.
CREATE TABLE analytics_history_checkpoint_stages (
 key_digest TEXT NOT NULL, generation TEXT NOT NULL, source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL, day TEXT NOT NULL, dependency_digest TEXT NOT NULL,
 source_namespace TEXT NOT NULL, method TEXT NOT NULL, expected_head TEXT,
 owner_revision INTEGER NOT NULL, authority_epoch INTEGER NOT NULL,
 control_json TEXT NOT NULL CHECK(length(CAST(control_json AS BLOB))<=16384),
 manifest_json TEXT NOT NULL CHECK(length(CAST(manifest_json AS BLOB))<=131072),
 part_count INTEGER NOT NULL CHECK(part_count BETWEEN 0 AND 1024),
 PRIMARY KEY(key_digest,generation)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_history_checkpoint_heads (
 key_digest TEXT PRIMARY KEY, generation TEXT, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN(0,1))
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_history_checkpoint_parts (
 key_digest TEXT NOT NULL,generation TEXT NOT NULL,part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 1023),
 sha256 TEXT NOT NULL,payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 2 AND 131072),
 payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))=payload_bytes),
 PRIMARY KEY(key_digest,generation,part_index),
 FOREIGN KEY(key_digest,generation) REFERENCES analytics_history_checkpoint_stages(key_digest,generation)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_history_checkpoint_stage_immutable BEFORE UPDATE ON analytics_history_checkpoint_stages
BEGIN SELECT RAISE(ABORT,'history_checkpoint_immutable'); END;
CREATE TRIGGER analytics_history_checkpoint_part_immutable BEFORE UPDATE ON analytics_history_checkpoint_parts
BEGIN SELECT RAISE(ABORT,'history_checkpoint_immutable'); END;
CREATE TRIGGER analytics_history_checkpoint_part_guard BEFORE INSERT ON analytics_history_checkpoint_parts
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages s
 JOIN analytics_owner_state o ON o.source_id=s.source_id AND o.owner_digest=s.owner_digest
 WHERE s.key_digest=NEW.key_digest AND s.generation=NEW.generation AND NEW.part_index<s.part_count
 AND o.state='active' AND o.authority_epoch=s.authority_epoch
 AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=s.key_digest
  AND (h.retired=1 OR h.generation IS NOT s.expected_head))) THEN RAISE(ABORT,'history_checkpoint_source_conflict') END;
END;
CREATE TRIGGER analytics_history_checkpoint_live_part_delete BEFORE DELETE ON analytics_history_checkpoint_parts
WHEN EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=OLD.key_digest AND h.generation=OLD.generation AND h.retired=0)
BEGIN SELECT RAISE(ABORT,'history_checkpoint_live'); END;
CREATE TRIGGER analytics_history_checkpoint_live_stage_delete BEFORE DELETE ON analytics_history_checkpoint_stages
WHEN EXISTS(SELECT 1 FROM analytics_history_checkpoint_heads h WHERE h.key_digest=OLD.key_digest AND h.generation=OLD.generation AND h.retired=0)
BEGIN SELECT RAISE(ABORT,'history_checkpoint_live'); END;
