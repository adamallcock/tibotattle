-- Maintained cache-retention-v2 neighbors, reversible pairs and exact counters.
-- Every subject-bearing row owns a canonical/owner FK; zero-key clock survives erasure.
CREATE TABLE analytics_canonical_cache_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,
 expected_revision INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO analytics_canonical_cache_clock(id) VALUES(1);
CREATE TRIGGER analytics_canonical_cache_clock_cas BEFORE UPDATE OF expected_revision ON analytics_canonical_cache_clock
WHEN NEW.expected_revision!=OLD.revision BEGIN SELECT RAISE(ABORT,'canonical_cache_changed'); END;
CREATE INDEX analytics_canonical_cache_fact_logical ON analytics_canonical_facts(selection_method,erasure_key,observed_day,native_logical_occurrence_key,observed_at_ms,native_order);
CREATE TABLE analytics_canonical_cache_logical_work(
 logical_key TEXT PRIMARY KEY,source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,day TEXT NOT NULL,
 selection_method TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_logical_subject ON analytics_canonical_cache_logical_work(source_id,owner_digest,selection_method,day);
CREATE INDEX analytics_canonical_cache_logical_page ON analytics_canonical_cache_logical_work(source_id,owner_digest,selection_method,logical_key);
CREATE TABLE analytics_canonical_cache_pair_work(
 node_key TEXT PRIMARY KEY,source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,day TEXT NOT NULL,
 selection_method TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_pair_work_subject ON analytics_canonical_cache_pair_work(source_id,owner_digest,selection_method,day);
CREATE INDEX analytics_canonical_cache_pair_page ON analytics_canonical_cache_pair_work(source_id,owner_digest,selection_method,node_key);
CREATE TABLE analytics_canonical_cache_slots(
 slot_key TEXT PRIMARY KEY,fact_revision TEXT NOT NULL UNIQUE REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 occurrence_key TEXT NOT NULL,root_partition_key TEXT NOT NULL,logical_key TEXT NOT NULL,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,
 observed_ms INTEGER NOT NULL,native_order INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<4096),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_slots_subject ON analytics_canonical_cache_slots(source_id,owner_digest,selection_method,day);
CREATE INDEX analytics_canonical_cache_slots_partition ON analytics_canonical_cache_slots(root_partition_key,occurrence_key);
CREATE INDEX analytics_canonical_cache_slots_logical ON analytics_canonical_cache_slots(logical_key,observed_ms,native_order,slot_key);
CREATE TABLE analytics_canonical_cache_nodes(
 node_key TEXT PRIMARY KEY,fact_revision TEXT NOT NULL UNIQUE REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,
 session_digest TEXT,observed_ms INTEGER NOT NULL,order_key TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<4096),
 unreadable INTEGER NOT NULL CHECK(unreadable IN(0,1)),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_neighbors ON analytics_canonical_cache_nodes(source_id,owner_digest,selection_method,session_digest,observed_ms,order_key,node_key);
CREATE TABLE analytics_canonical_cache_days(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),events_read INTEGER NOT NULL DEFAULT 0 CHECK(events_read>=0),unreadable_events INTEGER NOT NULL DEFAULT 0 CHECK(unreadable_events>=0),group_count INTEGER NOT NULL DEFAULT 0 CHECK(group_count>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,day),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_cache_session_proofs(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,
 day_revision INTEGER NOT NULL CHECK(day_revision>=0),peak INTEGER NOT NULL CHECK(peak>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,day),
 FOREIGN KEY(source_id,owner_digest,selection_method,day) REFERENCES analytics_canonical_cache_days(source_id,owner_digest,selection_method,day) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_cache_groups(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,refs INTEGER NOT NULL CHECK(refs>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,day,model,effort),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_cache_group_insert AFTER INSERT ON analytics_canonical_cache_groups BEGIN
 UPDATE analytics_canonical_cache_days SET group_count=group_count+1 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND selection_method=NEW.selection_method AND day=NEW.day;
END;
CREATE TRIGGER analytics_canonical_cache_group_delete AFTER DELETE ON analytics_canonical_cache_groups BEGIN
 UPDATE analytics_canonical_cache_days SET group_count=group_count-1 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day;
END;
CREATE TABLE analytics_canonical_cache_pairs(
 later_key TEXT PRIMARY KEY REFERENCES analytics_canonical_cache_nodes(node_key) ON DELETE CASCADE,
 prior_key TEXT NOT NULL REFERENCES analytics_canonical_cache_nodes(node_key) ON DELETE CASCADE,
 pair_revision TEXT NOT NULL CHECK(length(pair_revision)=64),method TEXT NOT NULL CHECK(method='cache-retention-v2'),
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,
 model TEXT NOT NULL,effort TEXT NOT NULL,band TEXT NOT NULL,session_digest TEXT NOT NULL,
 adjacencies INTEGER NOT NULL CHECK(adjacencies IN(0,1)),reused INTEGER NOT NULL CHECK(reused IN(0,1)),matched INTEGER NOT NULL CHECK(matched IN(0,1)),
 ties INTEGER NOT NULL CHECK(ties IN(0,1)),insufficient INTEGER NOT NULL CHECK(insufficient IN(0,1)),contracted INTEGER NOT NULL CHECK(contracted IN(0,1)),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_pair_subject ON analytics_canonical_cache_pairs(source_id,owner_digest,selection_method,day);
CREATE INDEX analytics_canonical_cache_pair_prior ON analytics_canonical_cache_pairs(prior_key);
CREATE TABLE analytics_canonical_cache_counters(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,band TEXT NOT NULL,
 adjacencies INTEGER NOT NULL CHECK(adjacencies>=0),reused INTEGER NOT NULL CHECK(reused>=0),matched INTEGER NOT NULL CHECK(matched>=0),
 ties INTEGER NOT NULL CHECK(ties>=0),insufficient INTEGER NOT NULL CHECK(insufficient>=0),contracted INTEGER NOT NULL CHECK(contracted>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,day,model,effort,band),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_cache_sessions(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,band TEXT NOT NULL,
 session_digest TEXT NOT NULL,refs INTEGER NOT NULL CHECK(refs>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,day,model,effort,band,session_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_cache_partitions(
 partition_key TEXT PRIMARY KEY,content_revision TEXT NOT NULL REFERENCES analytics_canonical_manifests(content_revision) ON DELETE CASCADE,
 method TEXT NOT NULL CHECK(method='cache-retention-v2')
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_cache_partition_revision ON analytics_canonical_cache_partitions(content_revision);
-- Four current calendar windows, projected from exact per-day products. A
-- calendar rollover replaces only these aggregate rows under the CAS.
CREATE TABLE analytics_canonical_cache_window_heads(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,anchor_day TEXT NOT NULL,
 PRIMARY KEY(source_id,owner_digest,selection_method),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_cache_windows(
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,selection_method TEXT NOT NULL,window TEXT NOT NULL CHECK(window IN('day','week','month','all')),
 model TEXT NOT NULL,effort TEXT NOT NULL,band TEXT NOT NULL,
 adjacencies INTEGER NOT NULL CHECK(adjacencies>=0),reused INTEGER NOT NULL CHECK(reused>=0),matched INTEGER NOT NULL CHECK(matched>=0),
 ties INTEGER NOT NULL CHECK(ties>=0),insufficient INTEGER NOT NULL CHECK(insufficient>=0),contracted INTEGER NOT NULL CHECK(contracted>=0),
 sessions INTEGER NOT NULL CHECK(sessions>=0),
 PRIMARY KEY(source_id,owner_digest,selection_method,window,model,effort,band),
 FOREIGN KEY(source_id,owner_digest,selection_method) REFERENCES analytics_canonical_cache_window_heads(source_id,owner_digest,selection_method) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_cache_effect AFTER INSERT ON analytics_canonical_effects WHEN NEW.kind!='noop' BEGIN
 DELETE FROM analytics_canonical_cache_partitions WHERE EXISTS(SELECT 1 FROM analytics_canonical_facts f
  WHERE f.revision IN(NEW.old_revision,NEW.new_revision) AND substr(analytics_canonical_cache_partitions.partition_key,1,length(f.partition_key))=f.partition_key);
 INSERT INTO analytics_canonical_cache_logical_work(logical_key,source_id,owner_digest,day,selection_method)
 SELECT f.selection_method||'/'||f.erasure_key||'/'||f.observed_day||'/'||f.native_logical_occurrence_key,f.source_id,f.owner_digest,f.observed_day,f.selection_method FROM analytics_canonical_facts f
 WHERE f.revision IN(NEW.old_revision,NEW.new_revision) AND f.stream='usage' AND f.observed_day IS NOT NULL
 GROUP BY 1 ON CONFLICT(logical_key) DO UPDATE SET generation=generation+1;
 UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER analytics_canonical_cache_slot_insert AFTER INSERT ON analytics_canonical_cache_slots BEGIN
 INSERT INTO analytics_canonical_cache_logical_work(logical_key,source_id,owner_digest,day,selection_method)
 VALUES(NEW.logical_key,NEW.source_id,NEW.owner_digest,NEW.day,NEW.selection_method)
 ON CONFLICT(logical_key) DO UPDATE SET generation=generation+1;
 INSERT INTO analytics_canonical_cache_days(source_id,owner_digest,selection_method,day,events_read)
 VALUES(NEW.source_id,NEW.owner_digest,NEW.selection_method,NEW.day,1)
 ON CONFLICT(source_id,owner_digest,selection_method,day) DO UPDATE SET events_read=events_read+1,revision=revision+1;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_node_insert AFTER INSERT ON analytics_canonical_cache_nodes BEGIN
 INSERT INTO analytics_canonical_cache_pair_work(node_key,source_id,owner_digest,day,selection_method)
 VALUES(NEW.node_key,NEW.source_id,NEW.owner_digest,NEW.day,NEW.selection_method)
 ON CONFLICT(node_key) DO UPDATE SET generation=generation+1;
 INSERT INTO analytics_canonical_cache_pair_work(node_key,source_id,owner_digest,day,selection_method)
 SELECT node_key,source_id,owner_digest,day,selection_method FROM analytics_canonical_cache_nodes n
 WHERE n.source_id=NEW.source_id AND n.owner_digest=NEW.owner_digest AND n.selection_method=NEW.selection_method AND n.session_digest=NEW.session_digest
 AND (n.observed_ms,n.order_key,n.node_key)>(NEW.observed_ms,NEW.order_key,NEW.node_key)
 ORDER BY n.observed_ms,n.order_key,n.node_key LIMIT 1
 ON CONFLICT(node_key) DO UPDATE SET generation=generation+1;
 UPDATE analytics_canonical_cache_days SET unreadable_events=unreadable_events+NEW.unreadable,revision=revision+1
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND selection_method=NEW.selection_method AND day=NEW.day;
 -- A carry change can alter a dense future day's native session-map peak.
 UPDATE analytics_canonical_cache_days SET revision=revision+1 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest
 AND selection_method=NEW.selection_method AND day>NEW.day AND day<=date(NEW.day,'+7 days') AND events_read>100000;
 UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_slot_delete AFTER DELETE ON analytics_canonical_cache_slots BEGIN
 INSERT INTO analytics_canonical_cache_logical_work(logical_key,source_id,owner_digest,day,selection_method)
 VALUES(OLD.logical_key,OLD.source_id,OLD.owner_digest,OLD.day,OLD.selection_method)
 ON CONFLICT(logical_key) DO UPDATE SET generation=generation+1;
 UPDATE analytics_canonical_cache_days SET events_read=events_read-1,revision=revision+1 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_node_delete BEFORE DELETE ON analytics_canonical_cache_nodes BEGIN
 INSERT INTO analytics_canonical_cache_pair_work(node_key,source_id,owner_digest,day,selection_method)
 VALUES(OLD.node_key,OLD.source_id,OLD.owner_digest,OLD.day,OLD.selection_method)
 ON CONFLICT(node_key) DO UPDATE SET generation=generation+1;
 INSERT INTO analytics_canonical_cache_pair_work(node_key,source_id,owner_digest,day,selection_method)
 SELECT node_key,source_id,owner_digest,day,selection_method FROM analytics_canonical_cache_nodes n
 WHERE n.source_id=OLD.source_id AND n.owner_digest=OLD.owner_digest AND n.selection_method=OLD.selection_method AND n.session_digest=OLD.session_digest
 AND (n.observed_ms,n.order_key,n.node_key)>(OLD.observed_ms,OLD.order_key,OLD.node_key)
 ORDER BY n.observed_ms,n.order_key,n.node_key LIMIT 1
 ON CONFLICT(node_key) DO UPDATE SET generation=generation+1;
 UPDATE analytics_canonical_cache_days SET unreadable_events=unreadable_events-OLD.unreadable,revision=revision+1
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day;
 -- A carry change can alter a dense future day's native session-map peak.
 UPDATE analytics_canonical_cache_days SET revision=revision+1 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest
 AND selection_method=OLD.selection_method AND day>OLD.day AND day<=date(OLD.day,'+7 days') AND events_read>100000;
 UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_pair_insert AFTER INSERT ON analytics_canonical_cache_pairs BEGIN
 INSERT INTO analytics_canonical_cache_groups(source_id,owner_digest,selection_method,day,model,effort,refs)
 VALUES(NEW.source_id,NEW.owner_digest,NEW.selection_method,NEW.day,NEW.model,NEW.effort,1)
 ON CONFLICT(source_id,owner_digest,selection_method,day,model,effort) DO UPDATE SET refs=refs+1;
 INSERT INTO analytics_canonical_cache_counters(source_id,owner_digest,selection_method,day,model,effort,band,adjacencies,reused,matched,ties,insufficient,contracted) VALUES(NEW.source_id,NEW.owner_digest,NEW.selection_method,NEW.day,NEW.model,NEW.effort,NEW.band,NEW.adjacencies,NEW.reused,NEW.matched,NEW.ties,NEW.insufficient,NEW.contracted)
 ON CONFLICT(source_id,owner_digest,selection_method,day,model,effort,band) DO UPDATE SET adjacencies=adjacencies+NEW.adjacencies,reused=reused+NEW.reused,matched=matched+NEW.matched,ties=ties+NEW.ties,insufficient=insufficient+NEW.insufficient,contracted=contracted+NEW.contracted;
 INSERT INTO analytics_canonical_cache_sessions(source_id,owner_digest,selection_method,day,model,effort,band,session_digest,refs)
 SELECT NEW.source_id,NEW.owner_digest,NEW.selection_method,NEW.day,NEW.model,NEW.effort,NEW.band,NEW.session_digest,1 WHERE NEW.adjacencies=1
 ON CONFLICT(source_id,owner_digest,selection_method,day,model,effort,band,session_digest) DO UPDATE SET refs=refs+1;
 INSERT INTO analytics_canonical_cache_windows(source_id,owner_digest,selection_method,window,model,effort,band,adjacencies,reused,matched,ties,insufficient,contracted,sessions)
 SELECT NEW.source_id,NEW.owner_digest,NEW.selection_method,w.value,NEW.model,NEW.effort,NEW.band,NEW.adjacencies,NEW.reused,NEW.matched,NEW.ties,NEW.insufficient,NEW.contracted,(NEW.adjacencies=1 AND (SELECT refs FROM analytics_canonical_cache_sessions WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest AND selection_method=NEW.selection_method AND day=NEW.day AND model=NEW.model AND effort=NEW.effort AND band=NEW.band AND session_digest=NEW.session_digest)=1)
 FROM analytics_canonical_cache_window_heads h,json_each('["day","week","month","all"]') w
 WHERE h.source_id=NEW.source_id AND h.owner_digest=NEW.owner_digest AND h.selection_method=NEW.selection_method AND (w.value='all' OR w.value='day' AND NEW.day>=h.anchor_day OR w.value='week' AND NEW.day>=date(h.anchor_day,'-6 days') OR w.value='month' AND NEW.day>=date(h.anchor_day,'-29 days'))
 ON CONFLICT(source_id,owner_digest,selection_method,window,model,effort,band) DO UPDATE SET adjacencies=adjacencies+excluded.adjacencies,reused=reused+excluded.reused,matched=matched+excluded.matched,ties=ties+excluded.ties,insufficient=insufficient+excluded.insufficient,contracted=contracted+excluded.contracted,sessions=sessions+excluded.sessions;
 UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER analytics_canonical_cache_pair_delete AFTER DELETE ON analytics_canonical_cache_pairs BEGIN
 UPDATE analytics_canonical_cache_groups SET refs=refs-1 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort;
 DELETE FROM analytics_canonical_cache_groups WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND refs=0;
 UPDATE analytics_canonical_cache_counters SET adjacencies=adjacencies-OLD.adjacencies,reused=reused-OLD.reused,matched=matched-OLD.matched,ties=ties-OLD.ties,insufficient=insufficient-OLD.insufficient,contracted=contracted-OLD.contracted WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND band=OLD.band;
 DELETE FROM analytics_canonical_cache_counters WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND band=OLD.band AND adjacencies=0 AND insufficient=0 AND contracted=0;
 UPDATE analytics_canonical_cache_sessions SET refs=refs-OLD.adjacencies WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND band=OLD.band AND session_digest=OLD.session_digest;
 DELETE FROM analytics_canonical_cache_sessions WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND band=OLD.band AND session_digest=OLD.session_digest AND refs=0;
 UPDATE analytics_canonical_cache_windows SET adjacencies=adjacencies-OLD.adjacencies,reused=reused-OLD.reused,matched=matched-OLD.matched,ties=ties-OLD.ties,insufficient=insufficient-OLD.insufficient,contracted=contracted-OLD.contracted,sessions=sessions-((OLD.adjacencies=1 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_sessions WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND day=OLD.day AND model=OLD.model AND effort=OLD.effort AND band=OLD.band AND session_digest=OLD.session_digest)))
 WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND model=OLD.model AND effort=OLD.effort AND band=OLD.band
 AND (window='all' OR window='day' AND OLD.day>=(SELECT anchor_day FROM analytics_canonical_cache_window_heads WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method) OR window='week' AND OLD.day>=date((SELECT anchor_day FROM analytics_canonical_cache_window_heads WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method),'-6 days') OR window='month' AND OLD.day>=date((SELECT anchor_day FROM analytics_canonical_cache_window_heads WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method),'-29 days'));
 DELETE FROM analytics_canonical_cache_windows WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest AND selection_method=OLD.selection_method AND adjacencies=0 AND insufficient=0 AND contracted=0 AND sessions=0;
 UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER analytics_canonical_cache_slot_admit BEFORE INSERT ON analytics_canonical_cache_slots
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
 JOIN analytics_owner_state o ON o.source_id=f.source_id AND o.owner_digest=f.owner_digest AND o.state='active'
 WHERE f.revision=NEW.fact_revision AND f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest AND f.stream='usage'
 AND f.selection_method=NEW.selection_method AND f.observed_day=NEW.day AND f.occurrence_key=NEW.occurrence_key
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=f.source_id AND e.owner_digest=f.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_cache_authority'); END;
CREATE TRIGGER analytics_canonical_cache_node_admit BEFORE INSERT ON analytics_canonical_cache_nodes
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_slots s JOIN analytics_canonical_heads h ON h.revision=s.fact_revision
 WHERE s.fact_revision=NEW.fact_revision AND s.logical_key=NEW.node_key AND s.source_id=NEW.source_id AND s.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'canonical_cache_authority'); END;
CREATE TRIGGER analytics_canonical_cache_pair_admit BEFORE INSERT ON analytics_canonical_cache_pairs
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_nodes p JOIN analytics_canonical_cache_nodes n
 ON p.node_key=NEW.prior_key AND n.node_key=NEW.later_key AND p.selection_method=n.selection_method AND p.session_digest=n.session_digest
 AND p.source_id=n.source_id AND p.owner_digest=n.owner_digest
 AND (p.observed_ms,p.order_key,p.node_key)<(n.observed_ms,n.order_key,n.node_key)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_nodes x WHERE x.source_id=n.source_id AND x.owner_digest=n.owner_digest AND x.selection_method=n.selection_method AND x.session_digest=n.session_digest
 AND (x.observed_ms,x.order_key,x.node_key)>(p.observed_ms,p.order_key,p.node_key) AND (x.observed_ms,x.order_key,x.node_key)<(n.observed_ms,n.order_key,n.node_key))
 JOIN analytics_owner_state o ON o.source_id=n.source_id AND o.owner_digest=n.owner_digest AND o.state='active'
 WHERE n.source_id=NEW.source_id AND n.owner_digest=NEW.owner_digest AND n.day=NEW.day AND n.selection_method=NEW.selection_method
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=n.source_id AND e.owner_digest=n.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_cache_authority'); END;
CREATE TRIGGER analytics_canonical_cache_slots_immutable BEFORE UPDATE ON analytics_canonical_cache_slots
BEGIN SELECT RAISE(ABORT,'canonical_cache_immutable'); END;
CREATE TRIGGER analytics_canonical_cache_nodes_immutable BEFORE UPDATE ON analytics_canonical_cache_nodes
BEGIN SELECT RAISE(ABORT,'canonical_cache_immutable'); END;
CREATE TRIGGER analytics_canonical_cache_pairs_immutable BEFORE UPDATE ON analytics_canonical_cache_pairs
BEGIN SELECT RAISE(ABORT,'canonical_cache_immutable'); END;
CREATE TRIGGER analytics_canonical_cache_owner_terminal AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active' BEGIN
DELETE FROM analytics_canonical_cache_slots WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_nodes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pairs WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_counters WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_sessions WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_groups WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_days WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_window_heads WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_logical_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pair_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_erasure AFTER INSERT ON analytics_storage_erasure_fences BEGIN
DELETE FROM analytics_canonical_cache_slots WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_nodes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pairs WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_counters WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_sessions WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_groups WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_days WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_window_heads WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_logical_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pair_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_erasure_update AFTER UPDATE ON analytics_storage_erasure_fences BEGIN
DELETE FROM analytics_canonical_cache_slots WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_nodes WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pairs WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_counters WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_sessions WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_groups WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_days WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_window_heads WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_logical_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
DELETE FROM analytics_canonical_cache_pair_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER analytics_canonical_cache_owner_delete BEFORE DELETE ON analytics_owner_state BEGIN
DELETE FROM analytics_canonical_cache_slots WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_nodes WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_pairs WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_counters WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_sessions WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_groups WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_days WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_window_heads WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_logical_work WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
DELETE FROM analytics_canonical_cache_pair_work WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
UPDATE analytics_canonical_cache_clock SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER analytics_canonical_cache_fact_remove BEFORE DELETE ON analytics_canonical_facts BEGIN
 DELETE FROM analytics_canonical_cache_partitions WHERE content_revision IN(
  SELECT content_revision FROM analytics_canonical_manifest_rows WHERE revision=OLD.revision);
END;
