-- An analytics database may consume several explicitly registered sources.
-- A registration does not grant ingestion or participant authority.
CREATE TABLE analytics_runtime_sources (
 source_id TEXT PRIMARY KEY,
 source_namespace TEXT NOT NULL,
 contract_version INTEGER NOT NULL CHECK(contract_version=1)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_runtime_source_immutable BEFORE UPDATE ON analytics_runtime_sources
BEGIN SELECT RAISE(ABORT,'analytics_runtime_source_immutable'); END;
CREATE TRIGGER analytics_runtime_source_retained BEFORE DELETE ON analytics_runtime_sources
BEGIN SELECT RAISE(ABORT,'analytics_runtime_source_retained'); END;
