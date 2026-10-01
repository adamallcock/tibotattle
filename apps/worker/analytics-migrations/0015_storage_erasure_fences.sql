-- Source-proven terminal erasure is prioritized independently of the ordered
-- delivery cursor. This fence never acknowledges or skips a journal event.
CREATE TABLE analytics_storage_erasure_fences (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 terminal_event_digest TEXT NOT NULL CHECK(length(terminal_event_digest)=64),
 terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence>0),terminal_revision INTEGER NOT NULL CHECK(terminal_revision>0),
 authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch>0),
 PRIMARY KEY(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_storage_erasure_public_epoch ON analytics_storage_erasure_fences(source_id,public_authority_epoch DESC);
CREATE TRIGGER analytics_storage_erasure_fence_immutable BEFORE UPDATE ON analytics_storage_erasure_fences
WHEN OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.terminal_event_digest IS NOT NEW.terminal_event_digest OR OLD.terminal_sequence IS NOT NEW.terminal_sequence
 OR OLD.terminal_revision IS NOT NEW.terminal_revision OR OLD.authority_epoch IS NOT NEW.authority_epoch
 OR OLD.public_authority_epoch IS NOT NEW.public_authority_epoch
BEGIN SELECT RAISE(ABORT,'storage_erasure_fence_conflict'); END;
CREATE TRIGGER analytics_storage_erasure_fence_retained BEFORE DELETE ON analytics_storage_erasure_fences
BEGIN SELECT RAISE(ABORT,'storage_erasure_fence_retained'); END;
CREATE TABLE analytics_storage_erasure_receipts (
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,terminal_event_digest TEXT NOT NULL,
 payload_contract INTEGER NOT NULL CHECK(payload_contract=1),
 PRIMARY KEY(source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_storage_erasure_fences(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_storage_erasure_receipt_immutable BEFORE UPDATE ON analytics_storage_erasure_receipts
BEGIN SELECT RAISE(ABORT,'storage_erasure_receipt_immutable'); END;
CREATE TRIGGER analytics_v1_chunk_values_terminal_insert BEFORE INSERT ON analytics_v1_chunk_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v1_chunk_values_terminal_update BEFORE UPDATE ON analytics_v1_chunk_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_projection_work_terminal_insert BEFORE INSERT ON analytics_v11_projection_work
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_projection_work_terminal_update BEFORE UPDATE ON analytics_v11_projection_work
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest) AND NEW.phase!='retiring'
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_reusable_values_terminal_insert BEFORE INSERT ON analytics_v11_reusable_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_reusable_values_terminal_update BEFORE UPDATE ON analytics_v11_reusable_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_value_pages_terminal_insert BEFORE INSERT ON analytics_v11_value_pages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_value_pages_terminal_update BEFORE UPDATE ON analytics_v11_value_pages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_results_terminal_insert BEFORE INSERT ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_results_terminal_update BEFORE UPDATE ON analytics_community_graph_results
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_execution_terminal_insert BEFORE INSERT ON analytics_community_graph_execution
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_community_graph_execution_terminal_update BEFORE UPDATE ON analytics_community_graph_execution
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_history_checkpoint_stages_terminal_insert BEFORE INSERT ON analytics_history_checkpoint_stages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_history_checkpoint_stages_terminal_update BEFORE UPDATE ON analytics_history_checkpoint_stages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_history_part_terminal BEFORE INSERT ON analytics_history_checkpoint_parts
WHEN EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages s JOIN analytics_storage_erasure_fences f
 ON f.source_id=s.source_id AND f.owner_digest=s.owner_digest WHERE s.key_digest=NEW.key_digest AND s.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_history_head_terminal_insert BEFORE INSERT ON analytics_history_checkpoint_heads
WHEN NEW.retired=0 AND EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages s JOIN analytics_storage_erasure_fences f
 ON f.source_id=s.source_id AND f.owner_digest=s.owner_digest WHERE s.key_digest=NEW.key_digest AND s.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_history_head_terminal_update BEFORE UPDATE ON analytics_history_checkpoint_heads
WHEN NEW.retired=0 AND EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages s JOIN analytics_storage_erasure_fences f
 ON f.source_id=s.source_id AND f.owner_digest=s.owner_digest WHERE s.key_digest=NEW.key_digest AND s.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_v11_legacy_terminal BEFORE INSERT ON analytics_v11_legacy_day_values
WHEN EXISTS(SELECT 1 FROM analytics_v11_projection_work w JOIN analytics_storage_erasure_fences f
 ON f.source_id=w.source_id AND f.owner_digest=w.owner_digest WHERE w.source_id=NEW.source_id AND w.event_digest=NEW.event_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
