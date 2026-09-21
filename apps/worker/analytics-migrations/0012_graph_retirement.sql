CREATE INDEX analytics_history_checkpoint_owner
 ON analytics_history_checkpoint_stages(source_id,owner_digest,day,key_digest,generation);
CREATE INDEX analytics_owner_retirement ON analytics_owner_state(source_id,state,owner_digest);
ALTER TABLE analytics_community_graph_scan ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;

-- A receipt concerns only this payload family; it never substitutes for the
-- independent deletion ledger or the other projection retirement receipts.
CREATE TABLE analytics_graph_erasure_receipts (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,terminal_revision INTEGER NOT NULL,
 PRIMARY KEY(source_id,owner_digest)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER analytics_graph_result_erased_insert BEFORE INSERT ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
CREATE TRIGGER analytics_graph_result_erased_update BEFORE UPDATE ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
CREATE TRIGGER analytics_graph_execution_erased_insert BEFORE INSERT ON analytics_community_graph_execution
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
CREATE TRIGGER analytics_graph_execution_erased_update BEFORE UPDATE ON analytics_community_graph_execution
WHEN EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND state='erased')
BEGIN SELECT RAISE(ABORT,'analytics_graph_owner_erased'); END;
