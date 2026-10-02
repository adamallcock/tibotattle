-- Exact active-owner empty work outcomes, not public output or source authority.
-- Terminal ACKs reuse native applied-event/erasure receipts and retain no new
-- erased-subject row here. ACKed rows retire in bounded pages.
CREATE TABLE analytics_partition_empty_outcomes (
 effect_key TEXT PRIMARY KEY CHECK(length(effect_key)=64),
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,source_namespace TEXT NOT NULL,
 source_stamp INTEGER NOT NULL CHECK(source_stamp>=0),from_day TEXT,through_day TEXT,
 stream TEXT NOT NULL CHECK(stream IN('all','usage','quota','session')),
 global_change INTEGER NOT NULL CHECK(global_change IN(0,1)),
 proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),
 owner_revision INTEGER NOT NULL CHECK(owner_revision>0),authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
 source_generation INTEGER NOT NULL CHECK(source_generation>=0),
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)),updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE,
 CHECK((from_day IS NULL AND through_day IS NULL) OR (length(from_day)=10 AND length(through_day)=10 AND from_day<=through_day))
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_empty_pending ON analytics_partition_empty_outcomes(source_id,acknowledged,updated_ms,effect_key);
CREATE TRIGGER analytics_partition_empty_admit BEFORE INSERT ON analytics_partition_empty_outcomes
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r USING(source_id)
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
 OR EXISTS(SELECT 1 FROM analytics_canonical_input_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
 OR EXISTS(SELECT 1 FROM analytics_canonical_facts WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_empty_outcome_changed'); END;
CREATE TRIGGER analytics_partition_empty_update BEFORE UPDATE ON analytics_partition_empty_outcomes
WHEN NEW.effect_key!=OLD.effect_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.source_namespace!=OLD.source_namespace OR NEW.source_stamp!=OLD.source_stamp OR NEW.from_day IS NOT OLD.from_day
 OR NEW.through_day IS NOT OLD.through_day OR NEW.stream!=OLD.stream OR NEW.global_change!=OLD.global_change
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r USING(source_id)
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
 OR EXISTS(SELECT 1 FROM analytics_canonical_input_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
 OR EXISTS(SELECT 1 FROM analytics_canonical_facts WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_empty_outcome_changed'); END;
CREATE TRIGGER analytics_partition_empty_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_partition_empty_outcomes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_empty_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_partition_empty_outcomes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_empty_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_partition_empty_outcomes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
