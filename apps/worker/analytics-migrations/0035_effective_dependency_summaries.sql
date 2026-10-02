-- Optional exact native dependency identities. This is a memo, never authority
-- or a public result. Source-owned mutation stamps fence reuse independently.
CREATE TABLE analytics_effective_dependency_summaries (
  scope_key TEXT PRIMARY KEY CHECK(length(scope_key)=64 AND scope_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  from_day TEXT NOT NULL CHECK(length(from_day)=10),
  through_day TEXT NOT NULL CHECK(length(through_day)=10 AND through_day>=from_day),
  include_sessions INTEGER NOT NULL CHECK(include_sessions IN (0,1)),
  mutation_stamp TEXT NOT NULL CHECK(length(mutation_stamp)=64 AND mutation_stamp NOT GLOB '*[^0-9a-f]*'),
  dependency_digest TEXT NOT NULL CHECK(length(dependency_digest)=64 AND dependency_digest NOT GLOB '*[^0-9a-f]*'),
  payload TEXT CHECK(payload IS NULL OR length(CAST(payload AS BLOB)) BETWEEN 1 AND 262144),
  owner_revision INTEGER NOT NULL CHECK(owner_revision BETWEEN 1 AND 9007199254740991),
  authority_epoch INTEGER NOT NULL CHECK(authority_epoch BETWEEN 1 AND 9007199254740991),
  updated_ms INTEGER NOT NULL CHECK(updated_ms BETWEEN 0 AND 9007199254740991),
  valid_until_ms INTEGER NOT NULL CHECK(valid_until_ms>updated_ms AND valid_until_ms<=9007199254740991)
) STRICT;
CREATE INDEX analytics_effective_dependency_owner ON analytics_effective_dependency_summaries
  (source_id,owner_digest,updated_ms,scope_key);

CREATE TRIGGER analytics_effective_dependency_insert BEFORE INSERT ON analytics_effective_dependency_summaries
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o
    JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
      AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch
      AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    OR (NOT EXISTS(SELECT 1 FROM analytics_effective_dependency_summaries h WHERE h.scope_key=NEW.scope_key)
      AND (SELECT count(*) FROM analytics_effective_dependency_summaries h
        WHERE h.source_id=NEW.source_id AND h.owner_digest=NEW.owner_digest)>=1024)
    THEN RAISE(ABORT,'analytics_effective_dependency_ineligible') END;
END;
CREATE TRIGGER analytics_effective_dependency_update BEFORE UPDATE ON analytics_effective_dependency_summaries
BEGIN
  SELECT CASE WHEN NEW.scope_key!=OLD.scope_key OR NEW.source_id!=OLD.source_id
    OR NEW.source_namespace!=OLD.source_namespace OR NEW.owner_digest!=OLD.owner_digest
    OR NEW.from_day!=OLD.from_day OR NEW.through_day!=OLD.through_day OR NEW.include_sessions!=OLD.include_sessions
    OR NEW.owner_revision<OLD.owner_revision OR NEW.authority_epoch<OLD.authority_epoch
    OR NEW.updated_ms<OLD.updated_ms
    OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
      JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
        AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch
        AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    THEN RAISE(ABORT,'analytics_effective_dependency_conflict') END;
END;
CREATE TRIGGER analytics_effective_dependency_owner_update AFTER UPDATE OF state,authority_epoch ON analytics_owner_state
WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_effective_dependency_summaries
  WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_effective_dependency_owner_delete AFTER DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_effective_dependency_summaries
  WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
CREATE TRIGGER analytics_effective_dependency_runtime_update AFTER UPDATE OF source_id,source_namespace,contract_version
ON analytics_runtime_sources
WHEN NEW.source_id!=OLD.source_id OR NEW.source_namespace!=OLD.source_namespace OR NEW.contract_version!=1
BEGIN DELETE FROM analytics_effective_dependency_summaries WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_effective_dependency_runtime_delete AFTER DELETE ON analytics_runtime_sources
BEGIN DELETE FROM analytics_effective_dependency_summaries WHERE source_id=OLD.source_id; END;
CREATE TRIGGER analytics_effective_dependency_terminal_insert AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_effective_dependency_summaries
  WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_effective_dependency_terminal_update AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_effective_dependency_summaries
  WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_effective_dependency_contract_v1 BEFORE UPDATE ON analytics_effective_dependency_summaries WHEN 0
BEGIN SELECT RAISE(ABORT,'analytics_effective_dependency_contract_v1'); END;
