-- Durable work is private scheduling metadata. Its completion is never source
-- authority or public publication proof. No participant IDs or fact payloads.
CREATE TABLE analytics_partition_work (
 work_key TEXT PRIMARY KEY CHECK(length(work_key)=64 AND work_key NOT GLOB '*[^0-9a-f]*'),
 head_key TEXT NOT NULL CHECK(length(head_key)=64 AND head_key NOT GLOB '*[^0-9a-f]*'),
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 owner_digest TEXT CHECK(owner_digest IS NULL OR length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
 partition_key TEXT NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 256),
 input_revision TEXT NOT NULL CHECK(length(input_revision)=64 AND input_revision NOT GLOB '*[^0-9a-f]*'),
 policy_revision TEXT NOT NULL CHECK(length(policy_revision)=64 AND policy_revision NOT GLOB '*[^0-9a-f]*'),
 stage TEXT NOT NULL CHECK(stage IN('canonical','features','activity','fits','cache','publication','cleanup')),
 lane TEXT NOT NULL CHECK(lane IN('withdrawal','new','recovery','history')),
 day TEXT CHECK(day IS NULL OR length(day)=10),
 stream TEXT CHECK(stream IS NULL OR stream IN('usage','quota','session')),
 selection_method TEXT CHECK(selection_method IS NULL OR selection_method IN('effective-union-v1','legacy-selected-v1')),
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN('ready','leased','complete','refused')),
 resident_bytes INTEGER NOT NULL CHECK(resident_bytes BETWEEN 0 AND 67108864),
 admission_queries INTEGER NOT NULL CHECK(admission_queries BETWEEN 1 AND 900),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990),
 claim_token TEXT,
 claim_expires_ms INTEGER NOT NULL DEFAULT 0 CHECK(claim_expires_ms>=0),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_claimed INTEGER NOT NULL DEFAULT 0 CHECK(last_claimed>=0),
 ready_ms INTEGER NOT NULL CHECK(ready_ms>=0),
 created_ms INTEGER NOT NULL CHECK(created_ms>=0),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),
 CHECK((state='leased' AND length(claim_token)=36 AND claim_expires_ms>0) OR (state!='leased' AND claim_token IS NULL AND claim_expires_ms=0))
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_work_ready ON analytics_partition_work(source_id,state,lane,ready_ms,last_claimed,work_key);
CREATE INDEX analytics_partition_work_head ON analytics_partition_work(head_key,state,claim_expires_ms);
-- Current head recency is metadata. This covering order lets MAX seek the last
-- value in the exact head/source/anonymous range instead of reading revisions.
CREATE INDEX analytics_partition_work_head_recency ON analytics_partition_work(head_key,source_id,owner_digest,last_claimed);
CREATE INDEX analytics_partition_work_subject ON analytics_partition_work(source_id,owner_digest);
-- Coverage proofs first select the exact manifest revision, then its producer.
CREATE INDEX analytics_partition_work_producer ON analytics_partition_work(source_id,stage,input_revision,partition_key);
CREATE TABLE analytics_partition_schedule (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id),
 turn INTEGER NOT NULL DEFAULT 0 CHECK(turn BETWEEN 0 AND 9007199254740980)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_partition_subject_schedule (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 owner_digest TEXT NOT NULL CHECK(owner_digest='' OR length(owner_digest)=64),
 last_claimed INTEGER NOT NULL DEFAULT 0 CHECK(last_claimed>=0),
 PRIMARY KEY(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_partition_canonical_effects (
 effect_key TEXT PRIMARY KEY REFERENCES analytics_canonical_effects(effect_key) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','accepted'))
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_effect_pending ON analytics_partition_canonical_effects(state,effect_key);
CREATE TABLE analytics_partition_reconciliation (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id),
 after_effect_key TEXT NOT NULL DEFAULT '' CHECK(after_effect_key='' OR length(after_effect_key)=64),
 complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1))
) STRICT, WITHOUT ROWID;
-- The exact source effect stays in its source database until a target receipt
-- and bounded range expansion cursor are committed. Retries repeat exact ACKs.
CREATE TABLE analytics_partition_ranges (
 effect_key TEXT PRIMARY KEY CHECK(length(effect_key)=64),
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 from_day TEXT NOT NULL CHECK(length(from_day)=10),
 through_day TEXT NOT NULL CHECK(length(through_day)=10 AND through_day>=from_day),
 next_day TEXT NOT NULL CHECK(length(next_day)=10),
 stream TEXT NOT NULL CHECK(stream IN('all','usage','quota','session')),
 selection_method TEXT NOT NULL CHECK(selection_method IN('effective-union-v1','legacy-selected-v1')),
 source_stamp INTEGER NOT NULL CHECK(source_stamp>=0),
 source_from_day TEXT,
 source_through_day TEXT,
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)),
 invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN(0,1)),
 lane TEXT NOT NULL CHECK(lane IN('withdrawal','new','recovery','history')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_range_ready ON analytics_partition_ranges(source_id,state,updated_ms,effect_key);
CREATE TABLE analytics_partition_global_changes (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 source_stamp INTEGER NOT NULL CHECK(source_stamp>=0),
 after_owner_digest TEXT NOT NULL DEFAULT '' CHECK(after_owner_digest='' OR length(after_owner_digest)=64),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 PRIMARY KEY(source_id,source_stamp)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_partition_canonical_outbox AFTER INSERT ON analytics_canonical_effects
BEGIN INSERT INTO analytics_partition_canonical_effects(effect_key) VALUES(NEW.effect_key); END;
CREATE TRIGGER analytics_partition_work_admit BEFORE INSERT ON analytics_partition_work
WHEN NOT EXISTS(SELECT 1 FROM analytics_runtime_sources r WHERE r.source_id=NEW.source_id AND r.contract_version=1)
 OR (NEW.owner_digest IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)))
BEGIN SELECT RAISE(ABORT,'analytics_partition_work_ineligible'); END;
CREATE TRIGGER analytics_partition_work_immutable BEFORE UPDATE ON analytics_partition_work
WHEN NEW.work_key!=OLD.work_key OR NEW.head_key!=OLD.head_key OR NEW.source_id!=OLD.source_id
 OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.partition_key!=OLD.partition_key
 OR NEW.input_revision!=OLD.input_revision OR NEW.policy_revision!=OLD.policy_revision OR NEW.stage!=OLD.stage
 OR NEW.day IS NOT OLD.day OR NEW.stream IS NOT OLD.stream OR NEW.selection_method IS NOT OLD.selection_method
 OR NEW.resident_bytes!=OLD.resident_bytes OR NEW.admission_queries!=OLD.admission_queries
 OR NEW.revision!=OLD.revision+1 OR NEW.created_ms!=OLD.created_ms OR NEW.updated_ms<OLD.updated_ms
BEGIN SELECT RAISE(ABORT,'analytics_partition_work_conflict'); END;
CREATE TRIGGER analytics_partition_range_admit BEFORE INSERT ON analytics_partition_ranges
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r USING(source_id)
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active' AND r.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_partition_range_ineligible'); END;
CREATE TRIGGER analytics_partition_owner_terminal AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_partition_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_subject_schedule WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_partition_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_partition_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_subject_schedule WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_partition_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN
 DELETE FROM analytics_partition_work WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
 DELETE FROM analytics_partition_ranges WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
 DELETE FROM analytics_partition_subject_schedule WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
END;
-- P1 invalidates dirty partitions BEFORE deleting a fact. At that point its
-- source reference is still present, so terminal erasure can journal a rebuild
-- without retaining an erased owner or any immutable fact revision.
CREATE TABLE analytics_partition_dirty_work (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 partition_key TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 admitted_generation INTEGER NOT NULL DEFAULT 0 CHECK(admitted_generation>=0 AND admitted_generation<=generation),
 PRIMARY KEY(source_id,partition_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_dirty_pending ON analytics_partition_dirty_work(source_id,admitted_generation,generation);
CREATE TRIGGER analytics_partition_dirty_insert AFTER INSERT ON analytics_canonical_dirty_partitions
BEGIN
 INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation)
 SELECT DISTINCT source_id,NEW.partition_key,NEW.generation FROM analytics_canonical_facts WHERE partition_key=NEW.partition_key
 ON CONFLICT(source_id,partition_key) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER analytics_partition_dirty_update AFTER UPDATE OF generation ON analytics_canonical_dirty_partitions
BEGIN
 INSERT INTO analytics_partition_dirty_work(source_id,partition_key,generation)
 SELECT DISTINCT source_id,NEW.partition_key,NEW.generation FROM analytics_canonical_facts WHERE partition_key=NEW.partition_key
 ON CONFLICT(source_id,partition_key) DO UPDATE SET generation=excluded.generation;
END;
CREATE TABLE analytics_partition_effect_refs (
 work_key TEXT NOT NULL REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE,
 effect_key TEXT NOT NULL REFERENCES analytics_canonical_effects(effect_key) ON DELETE CASCADE,
 PRIMARY KEY(work_key,effect_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_effect_reference ON analytics_partition_effect_refs(effect_key,work_key);
CREATE TABLE analytics_partition_work_links (
 parent_work_key TEXT NOT NULL REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE,
 child_work_key TEXT NOT NULL REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE,
 PRIMARY KEY(parent_work_key,child_work_key),CHECK(parent_work_key!=child_work_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_work_parent ON analytics_partition_work_links(child_work_key,parent_work_key);
CREATE TRIGGER analytics_partition_work_link_acyclic BEFORE INSERT ON analytics_partition_work_links
WHEN EXISTS(WITH RECURSIVE descendants(key) AS (
 SELECT child_work_key FROM analytics_partition_work_links WHERE parent_work_key=NEW.child_work_key
 UNION SELECT link.child_work_key FROM analytics_partition_work_links link JOIN descendants ON link.parent_work_key=descendants.key
) SELECT 1 FROM descendants WHERE key=NEW.parent_work_key)
BEGIN SELECT RAISE(ABORT,'analytics_partition_work_cycle'); END;
-- A downstream immutable manifest reference retains its exact subject index
-- only for erasure, never for source authority or scheduling hierarchy.
CREATE TABLE analytics_partition_work_subjects (
 work_key TEXT NOT NULL REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 PRIMARY KEY(work_key,source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_subject_reference ON analytics_partition_work_subjects(source_id,owner_digest,work_key);
CREATE TRIGGER analytics_partition_manifest_admit BEFORE INSERT ON analytics_partition_work
WHEN NEW.stage IN('activity','cache') AND (NEW.partition_key LIKE 'effective-union-v1/%' OR NEW.partition_key LIKE 'legacy-selected-v1/%')
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
  WHERE h.partition_key=NEW.partition_key AND h.content_revision=NEW.input_revision AND m.state='complete'
  AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0))
BEGIN SELECT RAISE(ABORT,'analytics_partition_manifest_changed'); END;
CREATE TRIGGER analytics_partition_manifest_subjects AFTER INSERT ON analytics_partition_work
WHEN NEW.stage IN('activity','cache')
BEGIN
 INSERT INTO analytics_partition_work_subjects(work_key,source_id,owner_digest)
 SELECT DISTINCT NEW.work_key,f.source_id,f.owner_digest FROM analytics_canonical_manifest_rows r
 JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=NEW.input_revision;
END;
CREATE TRIGGER analytics_partition_subject_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_partition_work WHERE work_key IN(SELECT work_key FROM analytics_partition_work_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); UPDATE analytics_partition_global_changes SET after_owner_digest='',version=version+1
 WHERE source_id=NEW.source_id AND after_owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_subject_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_partition_work WHERE work_key IN(SELECT work_key FROM analytics_partition_work_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); UPDATE analytics_partition_global_changes SET after_owner_digest='',version=version+1
 WHERE source_id=NEW.source_id AND after_owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_subject_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_partition_work WHERE work_key IN(SELECT work_key FROM analytics_partition_work_subjects
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest); UPDATE analytics_partition_global_changes SET after_owner_digest='',version=version+1
 WHERE source_id=OLD.source_id AND after_owner_digest=OLD.owner_digest; END;
