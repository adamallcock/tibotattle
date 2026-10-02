-- Closed native inputs are ordered within a sealed canonical stream/day.
-- Native integer endpoint IDs are allocated in that order, independently of
-- raw storage IDs. Corrections create a new generation; old frames cannot mix.
CREATE TABLE analytics_canonical_rolling_segments (
 segment_key TEXT PRIMARY KEY CHECK(length(segment_key)=64),
 source_id TEXT NOT NULL, owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 scope_key TEXT NOT NULL REFERENCES analytics_canonical_input_work(scope_key) ON DELETE CASCADE,
 source_stamp TEXT NOT NULL CHECK(length(source_stamp)=64),
 selection_method TEXT NOT NULL CHECK(selection_method IN('effective-union-v1','legacy-selected-v1')),
 day TEXT NOT NULL CHECK(length(day)=10), stream TEXT NOT NULL CHECK(stream IN('usage','quota')),
 method_digest TEXT NOT NULL CHECK(length(method_digest)=64),
 state TEXT NOT NULL CHECK(state IN('building','complete','dirty')),
 row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count>=0),
 cursor_ms INTEGER NOT NULL DEFAULT -8640000000000000, cursor_order INTEGER NOT NULL DEFAULT -1,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_rolling_segment_scope ON analytics_canonical_rolling_segments(source_id,owner_digest,day,stream);
CREATE TABLE analytics_canonical_rolling_rows (
 native_id INTEGER PRIMARY KEY AUTOINCREMENT,
 segment_key TEXT NOT NULL REFERENCES analytics_canonical_rolling_segments(segment_key) ON DELETE CASCADE,
 fact_revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 observed_ms INTEGER NOT NULL, native_order INTEGER NOT NULL CHECK(native_order>=0),
 resets_at TEXT,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=16384),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
 UNIQUE(segment_key,fact_revision), UNIQUE(segment_key,observed_ms,native_order)
) STRICT;
CREATE INDEX analytics_canonical_rolling_time ON analytics_canonical_rolling_rows(segment_key,observed_ms,native_id);
CREATE INDEX analytics_canonical_rolling_reset ON analytics_canonical_rolling_rows(segment_key,resets_at,observed_ms,native_id);
CREATE TABLE analytics_canonical_rolling_windows (
 window_key TEXT PRIMARY KEY CHECK(length(window_key)=64),
 source_id TEXT NOT NULL, owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 kind TEXT NOT NULL CHECK(kind IN('legacy-scalar','legacy-model','effective-model','effective-scalar')),
 from_ms INTEGER NOT NULL, through_ms INTEGER,
 native_dependency TEXT NOT NULL CHECK(length(native_dependency)=64),
 method_digest TEXT NOT NULL CHECK(length(method_digest)=64),
 state TEXT NOT NULL CHECK(state IN('building','complete','dirty')),
 member_count INTEGER NOT NULL CHECK(member_count>=0),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE,
 CHECK(through_ms IS NULL OR through_ms>from_ms)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_rolling_window_scope ON analytics_canonical_rolling_windows(source_id,owner_digest,from_ms,through_ms);
CREATE TABLE analytics_canonical_rolling_members (
 window_key TEXT NOT NULL REFERENCES analytics_canonical_rolling_windows(window_key) ON DELETE CASCADE,
 segment_key TEXT NOT NULL REFERENCES analytics_canonical_rolling_segments(segment_key) ON DELETE CASCADE,
 PRIMARY KEY(window_key,segment_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_rolling_segment_admit BEFORE INSERT ON analytics_canonical_rolling_segments
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work w JOIN analytics_owner_state o
 ON o.source_id=w.source_id AND o.owner_digest=w.owner_digest AND o.state='active'
 JOIN analytics_runtime_sources r ON r.source_id=o.source_id AND r.contract_version=1
 WHERE w.scope_key=NEW.scope_key AND w.source_stamp=NEW.source_stamp AND w.state='sealed'
 AND w.source_id=NEW.source_id AND w.owner_digest=NEW.owner_digest AND w.source_day=NEW.day
 AND w.stream=NEW.stream AND w.selection_method=NEW.selection_method
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_authority'); END;
CREATE TRIGGER analytics_canonical_rolling_segment_update BEFORE UPDATE ON analytics_canonical_rolling_segments
WHEN NEW.segment_key!=OLD.segment_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.scope_key!=OLD.scope_key OR NEW.source_stamp!=OLD.source_stamp OR NEW.selection_method!=OLD.selection_method
 OR NEW.day!=OLD.day OR NEW.stream!=OLD.stream OR NEW.method_digest!=OLD.method_digest
 OR OLD.state='dirty' AND NEW.state!='dirty'
 OR NEW.state!='dirty' AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work w JOIN analytics_owner_state o
 ON o.source_id=w.source_id AND o.owner_digest=w.owner_digest AND o.state='active'
 WHERE w.scope_key=NEW.scope_key AND w.source_stamp=NEW.source_stamp AND w.state='sealed'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest))
 OR NEW.state='complete' AND (NEW.row_count!=(SELECT count(*) FROM analytics_canonical_rolling_rows x WHERE x.segment_key=NEW.segment_key)
 OR NEW.row_count!=(SELECT seen_count FROM analytics_canonical_input_work WHERE scope_key=NEW.scope_key))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_transition'); END;
CREATE TRIGGER analytics_canonical_rolling_row_admit BEFORE INSERT ON analytics_canonical_rolling_rows
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_segments s JOIN analytics_canonical_input_work w ON w.scope_key=s.scope_key
 JOIN analytics_canonical_facts f ON f.revision=NEW.fact_revision JOIN analytics_canonical_heads h ON h.revision=f.revision
 JOIN analytics_owner_state o ON o.source_id=s.source_id AND o.owner_digest=s.owner_digest AND o.state='active'
 WHERE s.segment_key=NEW.segment_key AND s.state='building' AND w.state='sealed' AND w.source_stamp=s.source_stamp
 AND f.source_id=s.source_id AND f.owner_digest=s.owner_digest AND f.observed_day=s.day AND f.stream=s.stream
 AND f.selection_method=s.selection_method AND f.status='compatible' AND f.coverage='complete'
 AND f.observed_at_ms=NEW.observed_ms AND f.native_order=NEW.native_order
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=s.source_id AND e.owner_digest=s.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_row_authority'); END;
CREATE TRIGGER analytics_canonical_rolling_row_immutable BEFORE UPDATE ON analytics_canonical_rolling_rows
BEGIN SELECT RAISE(ABORT,'canonical_rolling_immutable'); END;
CREATE TRIGGER analytics_canonical_rolling_window_admit BEFORE INSERT ON analytics_canonical_rolling_windows
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id AND r.contract_version=1
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_authority'); END;
CREATE TRIGGER analytics_canonical_rolling_window_update BEFORE UPDATE ON analytics_canonical_rolling_windows
WHEN NEW.window_key!=OLD.window_key OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.kind!=OLD.kind OR NEW.from_ms!=OLD.from_ms OR NEW.through_ms IS NOT OLD.through_ms
 OR NEW.native_dependency!=OLD.native_dependency OR NEW.method_digest!=OLD.method_digest OR NEW.member_count!=OLD.member_count
 OR OLD.state='dirty' AND NEW.state!='dirty'
 OR NEW.state!='dirty' AND NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id
 AND o.owner_digest=NEW.owner_digest AND o.state='active' AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e
 WHERE e.source_id=NEW.source_id AND e.owner_digest=NEW.owner_digest))
 OR NEW.state='complete' AND (NEW.member_count!=(SELECT count(*) FROM analytics_canonical_rolling_members WHERE window_key=NEW.window_key)
 OR EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
 WHERE m.window_key=NEW.window_key AND s.state!='complete'))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_window_transition'); END;
CREATE TRIGGER analytics_canonical_rolling_member_admit BEFORE INSERT ON analytics_canonical_rolling_members
WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_windows w JOIN analytics_canonical_rolling_segments s
 ON s.source_id=w.source_id AND s.owner_digest=w.owner_digest AND s.state='complete' AND s.method_digest=w.method_digest
 WHERE w.window_key=NEW.window_key AND s.segment_key=NEW.segment_key AND w.state='building'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=w.source_id AND e.owner_digest=w.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_rolling_member_authority'); END;
CREATE TRIGGER analytics_canonical_rolling_member_immutable BEFORE UPDATE ON analytics_canonical_rolling_members
BEGIN SELECT RAISE(ABORT,'canonical_rolling_immutable'); END;
-- New/withdrawn rows invalidate old and new date memberships, including an
-- arrival into a formerly empty range. The native source proof remains final.
CREATE TRIGGER analytics_canonical_rolling_head_insert AFTER INSERT ON analytics_canonical_heads
BEGIN
 UPDATE analytics_canonical_rolling_segments SET state='dirty' WHERE (source_id,owner_digest,day,stream,selection_method)
 IN(SELECT source_id,owner_digest,observed_day,stream,selection_method FROM analytics_canonical_facts WHERE revision=NEW.revision);
 UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE (state='complete' OR EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m
 JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
 WHERE m.window_key=analytics_canonical_rolling_windows.window_key AND s.state='dirty'))
 AND EXISTS(SELECT 1 FROM analytics_canonical_facts f
 WHERE f.revision=NEW.revision AND f.source_id=analytics_canonical_rolling_windows.source_id AND f.owner_digest=analytics_canonical_rolling_windows.owner_digest
 AND f.stream IN('usage','quota') AND ((kind LIKE 'legacy-%' AND f.selection_method='legacy-selected-v1') OR (kind LIKE 'effective-%' AND f.selection_method='effective-union-v1'))
 AND (f.observed_at_ms IS NULL OR f.observed_at_ms>=from_ms AND (through_ms IS NULL OR f.observed_at_ms<through_ms)));
END;
CREATE TRIGGER analytics_canonical_rolling_head_update AFTER UPDATE ON analytics_canonical_heads
BEGIN
 UPDATE analytics_canonical_rolling_segments SET state='dirty' WHERE (source_id,owner_digest,day,stream,selection_method)
 IN(SELECT source_id,owner_digest,observed_day,stream,selection_method FROM analytics_canonical_facts WHERE revision IN(OLD.revision,NEW.revision));
 UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE (state='complete' OR EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m
 JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
 WHERE m.window_key=analytics_canonical_rolling_windows.window_key AND s.state='dirty'))
 AND EXISTS(SELECT 1 FROM analytics_canonical_facts f
 WHERE f.revision IN(OLD.revision,NEW.revision) AND f.source_id=analytics_canonical_rolling_windows.source_id
 AND f.owner_digest=analytics_canonical_rolling_windows.owner_digest
 AND f.stream IN('usage','quota') AND ((kind LIKE 'legacy-%' AND f.selection_method='legacy-selected-v1') OR (kind LIKE 'effective-%' AND f.selection_method='effective-union-v1'))
 AND (f.observed_at_ms IS NULL OR f.observed_at_ms>=from_ms AND (through_ms IS NULL OR f.observed_at_ms<through_ms)));
END;
CREATE TRIGGER analytics_canonical_rolling_head_delete AFTER DELETE ON analytics_canonical_heads
BEGIN
 UPDATE analytics_canonical_rolling_segments SET state='dirty' WHERE (source_id,owner_digest,day,stream,selection_method)
 IN(SELECT source_id,owner_digest,observed_day,stream,selection_method FROM analytics_canonical_facts WHERE revision=OLD.revision);
 UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE (state='complete' OR EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m
 JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
 WHERE m.window_key=analytics_canonical_rolling_windows.window_key AND s.state='dirty'))
 AND EXISTS(SELECT 1 FROM analytics_canonical_facts f
 WHERE f.revision=OLD.revision AND f.source_id=analytics_canonical_rolling_windows.source_id
 AND f.owner_digest=analytics_canonical_rolling_windows.owner_digest
 AND f.stream IN('usage','quota') AND ((kind LIKE 'legacy-%' AND f.selection_method='legacy-selected-v1') OR (kind LIKE 'effective-%' AND f.selection_method='effective-union-v1'))
 AND (f.observed_at_ms IS NULL OR f.observed_at_ms>=from_ms AND (through_ms IS NULL OR f.observed_at_ms<through_ms)));
END;
CREATE TRIGGER analytics_canonical_rolling_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_rolling_windows WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_rolling_segments WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_canonical_rolling_owner_terminal AFTER UPDATE ON analytics_owner_state WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_canonical_rolling_windows WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_rolling_segments WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_canonical_rolling_row_remove AFTER DELETE ON analytics_canonical_rolling_rows
BEGIN
 UPDATE analytics_canonical_rolling_segments SET state='dirty' WHERE segment_key=OLD.segment_key;
 UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE window_key IN(
 SELECT window_key FROM analytics_canonical_rolling_members WHERE segment_key=OLD.segment_key);
END;
