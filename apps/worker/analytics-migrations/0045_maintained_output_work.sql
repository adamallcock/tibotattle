-- Output-date work is maintained with native result adoption, including every
-- date adopted from a model block. No owner, payload or source identity is kept.
CREATE TABLE analytics_partition_graph_dirty (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 metric TEXT NOT NULL CHECK(metric IN('fits','model')),day TEXT NOT NULL CHECK(length(day)=10),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740989),
 admitted_generation INTEGER NOT NULL DEFAULT 0 CHECK(admitted_generation BETWEEN 0 AND generation),
 PRIMARY KEY(source_id,metric,day)
) STRICT, WITHOUT ROWID;
INSERT INTO analytics_partition_graph_dirty(source_id,metric,day,generation)
 SELECT source_id,metric,day,1 FROM analytics_community_graph_results GROUP BY source_id,metric,day;
CREATE TRIGGER analytics_partition_graph_insert AFTER INSERT ON analytics_community_graph_results BEGIN
 INSERT INTO analytics_partition_graph_dirty(source_id,metric,day,generation) VALUES(NEW.source_id,NEW.metric,NEW.day,1)
 ON CONFLICT(source_id,metric,day) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER analytics_partition_graph_update AFTER UPDATE ON analytics_community_graph_results
 WHEN NEW.method IS NOT OLD.method OR NEW.dependency_digest IS NOT OLD.dependency_digest
 OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.authority_json IS NOT OLD.authority_json BEGIN
 INSERT INTO analytics_partition_graph_dirty(source_id,metric,day,generation) VALUES(NEW.source_id,NEW.metric,NEW.day,1)
 ON CONFLICT(source_id,metric,day) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER analytics_partition_graph_delete AFTER DELETE ON analytics_community_graph_results BEGIN
 INSERT INTO analytics_partition_graph_dirty(source_id,metric,day,generation) VALUES(OLD.source_id,OLD.metric,OLD.day,1)
 ON CONFLICT(source_id,metric,day) DO UPDATE SET generation=generation+1; END;
-- Code/price policy changes re-admit compact partition work in bounded keyset
-- pages. They neither mutate quantities nor reread accepted telemetry.
CREATE TABLE analytics_partition_policy_work (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 policy_revision TEXT NOT NULL CHECK(length(policy_revision)=64 AND policy_revision NOT GLOB '*[^a-f0-9]*'),
 after_partition_key TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),updated_ms INTEGER NOT NULL CHECK(updated_ms>=0)
) STRICT, WITHOUT ROWID;

-- Sealing a native input records its exact changed scope in the same native
-- transaction, including acquisitions by B02 and rolling consumers directly.
CREATE TABLE analytics_partition_graph_subjects (
 subject_key TEXT PRIMARY KEY,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,
 selection_method TEXT NOT NULL CHECK(selection_method IN('effective-union-v1','legacy-selected-v1')),
 policy_revision TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK(length(policy_revision)=64),
 clock_day TEXT NOT NULL DEFAULT '1970-01-01' CHECK(length(clock_day)=10),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 UNIQUE(source_id,owner_digest,selection_method),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_graph_subject_source ON analytics_partition_graph_subjects(source_id,subject_key);
CREATE TABLE analytics_partition_graph_input_refs (
 scope_key TEXT PRIMARY KEY REFERENCES analytics_canonical_input_work(scope_key) ON DELETE CASCADE,
 subject_key TEXT NOT NULL REFERENCES analytics_partition_graph_subjects(subject_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,
 source_day TEXT NOT NULL CHECK(length(source_day)=10),
 source_stamp TEXT NOT NULL CHECK(length(source_stamp)=64),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 applied_generation INTEGER NOT NULL DEFAULT 0 CHECK(applied_generation BETWEEN 0 AND generation),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_graph_input_pending ON analytics_partition_graph_input_refs(source_id,scope_key) WHERE generation>applied_generation;
CREATE INDEX analytics_partition_graph_input_subject ON analytics_partition_graph_input_refs(subject_key,source_day);
CREATE TABLE analytics_partition_graph_demands (
 subject_key TEXT NOT NULL REFERENCES analytics_partition_graph_subjects(subject_key) ON DELETE CASCADE,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,
 metric TEXT NOT NULL CHECK(metric IN('fits','model')),day TEXT NOT NULL CHECK(length(day)=10),
 input_revision TEXT NOT NULL CHECK(length(input_revision)=64),
 policy_revision TEXT NOT NULL CHECK(length(policy_revision)=64),
 generation INTEGER NOT NULL CHECK(generation>0),
 admitted_generation INTEGER NOT NULL DEFAULT 0 CHECK(admitted_generation BETWEEN 0 AND generation),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 PRIMARY KEY(subject_key,metric,day),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_partition_graph_demand_pending ON analytics_partition_graph_demands(source_id,metric,updated_ms,day,subject_key) WHERE generation>admitted_generation;
CREATE TABLE analytics_partition_graph_control (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 policy_revision TEXT NOT NULL CHECK(length(policy_revision)=64),
 anchor_day TEXT NOT NULL CHECK(length(anchor_day)=10),
 after_subject_key TEXT REFERENCES analytics_partition_graph_subjects(subject_key) ON DELETE SET NULL,
 after_input_key TEXT REFERENCES analytics_partition_graph_input_refs(scope_key) ON DELETE SET NULL,
 scan_complete INTEGER NOT NULL DEFAULT 0 CHECK(scan_complete IN(0,1)),
 turn INTEGER NOT NULL DEFAULT 0 CHECK(turn BETWEEN 0 AND 2),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_partition_graph_subject_added AFTER INSERT ON analytics_partition_graph_subjects
BEGIN UPDATE analytics_partition_graph_control SET after_subject_key=NULL,scan_complete=0,version=version+1 WHERE source_id=NEW.source_id; END;
CREATE TRIGGER analytics_partition_graph_subject_admit BEFORE INSERT ON analytics_partition_graph_subjects
WHEN NEW.subject_key!=NEW.source_id||'/'||NEW.owner_digest||'/'||NEW.selection_method
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_graph_subject_changed'); END;
CREATE TRIGGER analytics_partition_graph_subject_update BEFORE UPDATE ON analytics_partition_graph_subjects
WHEN NEW.subject_key!=OLD.subject_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest OR NEW.selection_method!=OLD.selection_method
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_graph_subject_changed'); END;
CREATE TRIGGER analytics_partition_graph_ref_admit BEFORE INSERT ON analytics_partition_graph_input_refs
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work w JOIN analytics_partition_graph_subjects s
 ON s.source_id=w.source_id AND s.owner_digest=w.owner_digest AND s.selection_method=w.selection_method
 WHERE w.scope_key=NEW.scope_key AND w.state='sealed' AND w.source_stamp=NEW.source_stamp AND w.source_day=NEW.source_day
 AND s.subject_key=NEW.subject_key AND w.source_id=NEW.source_id AND w.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'analytics_graph_input_changed'); END;
CREATE TRIGGER analytics_partition_graph_ref_update BEFORE UPDATE ON analytics_partition_graph_input_refs
WHEN NEW.scope_key!=OLD.scope_key OR NEW.subject_key!=OLD.subject_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.source_day!=OLD.source_day OR NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work w
 WHERE w.scope_key=NEW.scope_key AND w.state='sealed' AND w.source_stamp=NEW.source_stamp)
BEGIN SELECT RAISE(ABORT,'analytics_graph_input_changed'); END;
CREATE TRIGGER analytics_partition_graph_demand_admit BEFORE INSERT ON analytics_partition_graph_demands
WHEN NOT EXISTS(SELECT 1 FROM analytics_partition_graph_subjects s JOIN analytics_owner_state o
 ON o.source_id=s.source_id AND o.owner_digest=s.owner_digest WHERE s.subject_key=NEW.subject_key
 AND s.source_id=NEW.source_id AND s.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_graph_subject_changed'); END;
CREATE TRIGGER analytics_partition_graph_demand_update BEFORE UPDATE ON analytics_partition_graph_demands
WHEN NEW.subject_key!=OLD.subject_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest OR NEW.metric!=OLD.metric OR NEW.day!=OLD.day
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_graph_subject_changed'); END;
CREATE TRIGGER analytics_partition_graph_input_sealed AFTER UPDATE ON analytics_canonical_input_work WHEN NEW.state='sealed'
BEGIN
 INSERT INTO analytics_partition_graph_subjects(subject_key,source_id,owner_digest,selection_method)
 VALUES(NEW.source_id||'/'||NEW.owner_digest||'/'||NEW.selection_method,NEW.source_id,NEW.owner_digest,NEW.selection_method) ON CONFLICT DO NOTHING;
 INSERT INTO analytics_partition_graph_input_refs(scope_key,subject_key,source_id,owner_digest,source_day,source_stamp)
 VALUES(NEW.scope_key,NEW.source_id||'/'||NEW.owner_digest||'/'||NEW.selection_method,NEW.source_id,NEW.owner_digest,NEW.source_day,NEW.source_stamp)
 ON CONFLICT(scope_key) DO UPDATE SET source_stamp=excluded.source_stamp,generation=generation+1 WHERE source_stamp!=excluded.source_stamp;
END;
CREATE TRIGGER analytics_partition_graph_input_insert AFTER INSERT ON analytics_canonical_input_work WHEN NEW.state='sealed'
BEGIN
 INSERT INTO analytics_partition_graph_subjects(subject_key,source_id,owner_digest,selection_method)
 VALUES(NEW.source_id||'/'||NEW.owner_digest||'/'||NEW.selection_method,NEW.source_id,NEW.owner_digest,NEW.selection_method) ON CONFLICT DO NOTHING;
 INSERT INTO analytics_partition_graph_input_refs(scope_key,subject_key,source_id,owner_digest,source_day,source_stamp)
 VALUES(NEW.scope_key,NEW.source_id||'/'||NEW.owner_digest||'/'||NEW.selection_method,NEW.source_id,NEW.owner_digest,NEW.source_day,NEW.source_stamp)
 ON CONFLICT(scope_key) DO UPDATE SET source_stamp=excluded.source_stamp,generation=generation+1 WHERE source_stamp!=excluded.source_stamp;
END;
INSERT INTO analytics_partition_graph_subjects(subject_key,source_id,owner_digest,selection_method)
 SELECT source_id||'/'||owner_digest||'/'||selection_method,source_id,owner_digest,selection_method
 FROM analytics_canonical_input_work WHERE state='sealed' GROUP BY source_id,owner_digest,selection_method;
INSERT INTO analytics_partition_graph_input_refs(scope_key,subject_key,source_id,owner_digest,source_day,source_stamp)
 SELECT scope_key,source_id||'/'||owner_digest||'/'||selection_method,source_id,owner_digest,source_day,source_stamp
 FROM analytics_canonical_input_work WHERE state='sealed';
CREATE TRIGGER analytics_partition_graph_subject_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_partition_graph_subjects WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_graph_subject_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_partition_graph_subjects WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_graph_subject_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_partition_graph_subjects WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_partition_graph_subject_delete BEFORE DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_partition_graph_subjects WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
