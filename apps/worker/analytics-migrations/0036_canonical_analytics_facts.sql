-- Private closed canonical materialization. No source record JSON or raw session,
-- account, occurrence, participant or device identifiers are stored here.
CREATE TABLE analytics_canonical_facts (
 revision TEXT PRIMARY KEY CHECK(length(revision)=64),
 occurrence_key TEXT NOT NULL CHECK(length(occurrence_key)=64),
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 erasure_key TEXT NOT NULL CHECK(length(erasure_key)=64),
 stream TEXT NOT NULL CHECK(stream IN ('usage','quota','session')),
 selection_method TEXT NOT NULL CHECK(selection_method IN ('effective-union-v1','legacy-selected-v1')),
 status TEXT NOT NULL CHECK(status IN ('compatible','conflict','total_conflict','base_conflict')),
 partition_key TEXT NOT NULL,
 observed_day TEXT,
 observed_at_ms INTEGER,
 order_scope_key TEXT NOT NULL CHECK(length(order_scope_key)=64),
 native_order INTEGER NOT NULL CHECK(native_order>=0),
 provenance_digest TEXT NOT NULL CHECK(length(provenance_digest)=64),
 coverage TEXT NOT NULL CHECK(coverage IN ('complete','unknown')),
 reported_fields INTEGER NOT NULL CHECK(reported_fields BETWEEN 0 AND 134217727),
 conflicted_fields INTEGER NOT NULL CHECK(conflicted_fields BETWEEN 0 AND 134217727),
 account_basis TEXT NOT NULL,
 plan_basis TEXT NOT NULL,
 provider TEXT,
 model_id TEXT,
 session_key TEXT,
 speed_mode TEXT,
 api_service_tier TEXT,
 surface TEXT,
 billing_surface TEXT,
 reasoning_effort TEXT,
 agent_scope TEXT,
 outcome TEXT,
 total_input_context_tokens INTEGER,
 input_uncached_tokens INTEGER,
 input_cache_read_tokens INTEGER,
 input_cache_write_tokens INTEGER,
 output_text_tokens INTEGER,
 output_reasoning_tokens INTEGER,
 output_combined_tokens INTEGER,
 plan_type TEXT,
 plan_variant TEXT,
 limit_id TEXT,
 slot TEXT,
 used_percent REAL,
 window_duration_minutes INTEGER,
 resets_at_ms INTEGER,
 account_scope_key TEXT,
 plan_era_key TEXT,
 attribution_plan_type TEXT,
 native_source_family TEXT NOT NULL CHECK(native_source_family IN('effective','v1','v11')),
 native_selected_slot_key TEXT CHECK(native_selected_slot_key IS NULL OR (length(native_selected_slot_key)=64 AND native_selected_slot_key NOT GLOB '*[^a-f0-9]*')),
 native_logical_occurrence_key TEXT NOT NULL CHECK(length(native_logical_occurrence_key)=64 AND native_logical_occurrence_key NOT GLOB '*[^a-f0-9]*'),
 native_occurrence_tie_order INTEGER NOT NULL CHECK(native_occurrence_tie_order>=0),
 native_cache_session_digest TEXT CHECK(native_cache_session_digest IS NULL OR (length(native_cache_session_digest)=64 AND native_cache_session_digest NOT GLOB '*[^a-f0-9]*')),
 native_graph_session_digest TEXT CHECK(native_graph_session_digest IS NULL OR (length(native_graph_session_digest)=64 AND native_graph_session_digest NOT GLOB '*[^a-f0-9]*')),
 native_scalar_session_digest TEXT CHECK(native_scalar_session_digest IS NULL OR (length(native_scalar_session_digest)=64 AND native_scalar_session_digest NOT GLOB '*[^a-f0-9]*')),
 native_account_track_id TEXT CHECK(native_account_track_id IS NULL OR (substr(native_account_track_id,1,17)='account-track:v2:' AND length(native_account_track_id)=81 AND substr(native_account_track_id,18) NOT GLOB '*[^a-f0-9]*')),
 native_plan_era_id TEXT CHECK(native_plan_era_id IS NULL OR (substr(native_plan_era_id,1,12)='plan-era:v1:' AND length(native_plan_era_id)=76 AND substr(native_plan_era_id,13) NOT GLOB '*[^a-f0-9]*')),
 boundary_flags_presence TEXT NOT NULL CHECK(boundary_flags_presence IN ('unknown','reported','conflict')),
 boundary_flags INTEGER,
 tie_order_presence TEXT NOT NULL CHECK(tie_order_presence IN ('unknown','reported','conflict')),
 tie_order INTEGER,
 cache_write_five_minute_tokens_presence TEXT NOT NULL CHECK(cache_write_five_minute_tokens_presence IN ('unknown','reported','conflict')),
 cache_write_five_minute_tokens INTEGER,
 cache_write_one_hour_tokens_presence TEXT NOT NULL CHECK(cache_write_one_hour_tokens_presence IN ('unknown','reported','conflict')),
 cache_write_one_hour_tokens INTEGER,
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),
 CHECK((observed_day IS NULL)=(observed_at_ms IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_fact_subject ON analytics_canonical_facts(source_id,owner_digest);
CREATE TABLE analytics_canonical_variants (
 revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 variant_key TEXT NOT NULL CHECK(length(variant_key)=64),
 kind TEXT NOT NULL CHECK(kind IN ('typed','correction','v12')),
 format TEXT NOT NULL CHECK(format IN ('v1','v11','v12')),
 observed_at_ms INTEGER NOT NULL,
 PRIMARY KEY(revision,variant_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_variant_reverse ON analytics_canonical_variants(variant_key,revision);
CREATE TABLE analytics_canonical_days (
 revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 day TEXT NOT NULL CHECK(length(day)=10), PRIMARY KEY(revision,day)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_tools (
 revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 tool_class TEXT NOT NULL,
 count INTEGER NOT NULL CHECK(count>=0), PRIMARY KEY(revision,tool_class)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_heads (
 occurrence_key TEXT NOT NULL CHECK(length(occurrence_key)=64),
 selection_method TEXT NOT NULL CHECK(selection_method IN ('effective-union-v1','legacy-selected-v1')),
 revision TEXT NOT NULL UNIQUE REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 partition_key TEXT NOT NULL, PRIMARY KEY(occurrence_key,selection_method)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_head_partition ON analytics_canonical_heads(partition_key,occurrence_key);
CREATE TABLE analytics_canonical_pages (
 change_key TEXT PRIMARY KEY CHECK(length(change_key)=64),
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 owner_revision INTEGER NOT NULL CHECK(owner_revision>0),
 authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
 source_revision TEXT NOT NULL CHECK(length(source_revision)=64),
 effect_count INTEGER NOT NULL CHECK(effect_count BETWEEN 0 AND 16),
 state TEXT NOT NULL CHECK(state IN ('writing','complete')),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_page_subject ON analytics_canonical_pages(source_id,owner_digest);
CREATE TABLE analytics_canonical_effects (
 effect_key TEXT PRIMARY KEY CHECK(length(effect_key)=64),
 change_key TEXT NOT NULL REFERENCES analytics_canonical_pages(change_key) ON DELETE CASCADE,
 occurrence_key TEXT NOT NULL,
 selection_method TEXT NOT NULL CHECK(selection_method IN ('effective-union-v1','legacy-selected-v1')),
 stream TEXT NOT NULL CHECK(stream IN ('usage','quota','session')),
 erasure_key TEXT NOT NULL CHECK(length(erasure_key)=64),
 authority_revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('insert','replace','withdraw','noop')),
 old_revision TEXT REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 new_revision TEXT REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 UNIQUE(change_key,occurrence_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_dirty_partitions (
 partition_key TEXT PRIMARY KEY,
 generation INTEGER NOT NULL CHECK(generation>0)
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_manifests (
 content_revision TEXT PRIMARY KEY CHECK(length(content_revision)=64),
 partition_key TEXT NOT NULL,
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 root_partition_key TEXT NOT NULL,
 hash_prefix TEXT NOT NULL CHECK(length(hash_prefix) BETWEEN 2 AND 64),
 generation INTEGER NOT NULL CHECK(generation>=0),
 row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 128),
 min_observed_ms INTEGER,
 max_observed_ms INTEGER,
 state TEXT NOT NULL CHECK(state IN ('writing','complete'))
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_manifest_rows (
 content_revision TEXT NOT NULL REFERENCES analytics_canonical_manifests(content_revision) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 127),
 revision TEXT NOT NULL REFERENCES analytics_canonical_facts(revision) ON DELETE CASCADE,
 PRIMARY KEY(content_revision,ordinal), UNIQUE(content_revision,revision)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_manifest_fact ON analytics_canonical_manifest_rows(revision,content_revision);
CREATE TABLE analytics_canonical_partition_heads (
 partition_key TEXT PRIMARY KEY,
 content_revision TEXT NOT NULL REFERENCES analytics_canonical_manifests(content_revision) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TRIGGER analytics_canonical_fact_admit BEFORE INSERT ON analytics_canonical_facts
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources s ON s.source_id=o.source_id
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active' AND s.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_authority'); END;
CREATE TRIGGER analytics_canonical_fact_immutable BEFORE UPDATE ON analytics_canonical_facts
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;
CREATE TRIGGER analytics_canonical_page_admit BEFORE INSERT ON analytics_canonical_pages
WHEN NEW.state!='writing' OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND o.revision=NEW.owner_revision AND o.authority_epoch=NEW.authority_epoch
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_authority'); END;
CREATE TRIGGER analytics_canonical_page_seal BEFORE UPDATE ON analytics_canonical_pages
WHEN OLD.state!='writing' OR NEW.state!='complete' OR NEW.change_key!=OLD.change_key
 OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.owner_revision!=OLD.owner_revision OR NEW.authority_epoch!=OLD.authority_epoch
 OR NEW.source_revision!=OLD.source_revision OR NEW.effect_count!=OLD.effect_count
 OR NEW.effect_count!=(SELECT count(*) FROM analytics_canonical_effects WHERE change_key=NEW.change_key)
BEGIN SELECT RAISE(ABORT,'canonical_page_conflict'); END;
CREATE TRIGGER analytics_canonical_effect_admit BEFORE INSERT ON analytics_canonical_effects
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analytics_canonical_pages p WHERE p.change_key=NEW.change_key AND p.state='writing')
  OR (SELECT revision FROM analytics_canonical_heads WHERE occurrence_key=NEW.occurrence_key AND selection_method=NEW.selection_method) IS NOT NEW.old_revision
  OR (NEW.kind='noop')!=(NEW.old_revision IS NEW.new_revision)
  OR (NEW.kind='insert' AND (NEW.old_revision IS NOT NULL OR NEW.new_revision IS NULL))
  OR (NEW.kind='withdraw' AND (NEW.old_revision IS NULL OR NEW.new_revision IS NOT NULL))
  OR (NEW.kind='replace' AND (NEW.old_revision IS NULL OR NEW.new_revision IS NULL))
  THEN RAISE(ABORT,'canonical_head_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analytics_canonical_facts f JOIN analytics_canonical_pages p ON p.change_key=NEW.change_key
  WHERE f.revision IN (NEW.old_revision,NEW.new_revision) AND (f.source_id!=p.source_id OR f.owner_digest!=p.owner_digest
   OR f.occurrence_key!=NEW.occurrence_key OR f.selection_method!=NEW.selection_method OR f.erasure_key!=NEW.erasure_key OR f.stream!=NEW.stream))
  THEN RAISE(ABORT,'canonical_scope_conflict') END;
END;
CREATE TRIGGER analytics_canonical_effect_apply AFTER INSERT ON analytics_canonical_effects
WHEN NEW.kind!='noop'
BEGIN
 INSERT INTO analytics_canonical_dirty_partitions(partition_key,generation)
 SELECT partition_key,1 FROM analytics_canonical_facts WHERE revision IN(NEW.old_revision,NEW.new_revision) GROUP BY partition_key
 ON CONFLICT(partition_key) DO UPDATE SET generation=generation+1;
 DELETE FROM analytics_canonical_heads WHERE occurrence_key=NEW.occurrence_key AND selection_method=NEW.selection_method;
 INSERT INTO analytics_canonical_heads(occurrence_key,selection_method,revision,partition_key)
 SELECT occurrence_key,selection_method,revision,partition_key FROM analytics_canonical_facts WHERE revision=NEW.new_revision;
END;
CREATE TRIGGER analytics_canonical_effect_immutable BEFORE UPDATE ON analytics_canonical_effects
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;
CREATE TRIGGER analytics_canonical_manifest_seal BEFORE UPDATE ON analytics_canonical_manifests
WHEN OLD.state!='writing' OR NEW.state!='complete' OR NEW.content_revision!=OLD.content_revision
 OR NEW.partition_key!=OLD.partition_key OR NEW.content_digest!=OLD.content_digest
 OR NEW.root_partition_key!=OLD.root_partition_key OR NEW.hash_prefix!=OLD.hash_prefix
 OR NEW.generation!=OLD.generation OR NEW.row_count!=OLD.row_count
 OR NEW.generation!=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=NEW.root_partition_key),0)
 OR NEW.row_count!=(SELECT count(*) FROM analytics_canonical_heads WHERE partition_key=NEW.root_partition_key
  AND occurrence_key>=NEW.hash_prefix AND occurrence_key<NEW.hash_prefix||'g')
 OR NEW.min_observed_ms IS NOT OLD.min_observed_ms OR NEW.max_observed_ms IS NOT OLD.max_observed_ms
 OR NEW.row_count!=(SELECT count(*) FROM analytics_canonical_manifest_rows WHERE content_revision=NEW.content_revision)
 OR EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  LEFT JOIN analytics_canonical_heads h ON h.occurrence_key=f.occurrence_key AND h.selection_method=f.selection_method AND h.revision=f.revision
  WHERE r.content_revision=NEW.content_revision AND h.revision IS NULL)
BEGIN SELECT RAISE(ABORT,'canonical_manifest_conflict'); END;
CREATE TRIGGER analytics_canonical_fact_remove BEFORE DELETE ON analytics_canonical_facts
BEGIN
 INSERT INTO analytics_canonical_dirty_partitions(partition_key,generation) SELECT OLD.partition_key,1
 WHERE EXISTS(SELECT 1 FROM analytics_canonical_heads WHERE revision=OLD.revision)
  OR EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows WHERE revision=OLD.revision)
 ON CONFLICT(partition_key) DO UPDATE SET generation=generation+1;
 DELETE FROM analytics_canonical_manifests WHERE content_revision IN
  (SELECT content_revision FROM analytics_canonical_manifest_rows WHERE revision=OLD.revision);
END;
CREATE TRIGGER analytics_canonical_owner_terminal AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_canonical_pages WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_facts WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_canonical_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_pages WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_facts WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_canonical_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN
 DELETE FROM analytics_canonical_pages WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
 DELETE FROM analytics_canonical_facts WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
END;

CREATE TRIGGER analytics_canonical_variants_immutable BEFORE UPDATE ON analytics_canonical_variants
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;

CREATE TRIGGER analytics_canonical_days_immutable BEFORE UPDATE ON analytics_canonical_days
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;

CREATE TRIGGER analytics_canonical_tools_immutable BEFORE UPDATE ON analytics_canonical_tools
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;

CREATE TRIGGER analytics_canonical_manifest_rows_immutable BEFORE UPDATE ON analytics_canonical_manifest_rows
BEGIN SELECT RAISE(ABORT,'canonical_immutable'); END;

-- BEGIN P1 INPUT CHECKPOINTS
-- Acquisition is owner-scoped metadata. Canonical facts and downstream partitions
-- remain independent of this source-side owner and device selection boundary.
CREATE TABLE analytics_canonical_input_work (
 scope_key TEXT PRIMARY KEY CHECK(length(scope_key)=64),
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 selection_method TEXT NOT NULL CHECK(selection_method IN('effective-union-v1','legacy-selected-v1')),
 stream TEXT NOT NULL CHECK(stream IN ('usage','quota','session')),
 source_day TEXT NOT NULL CHECK(length(source_day)=10),
 source_stamp TEXT NOT NULL CHECK(length(source_stamp)=64),
 owner_revision INTEGER NOT NULL CHECK(owner_revision>0),
 authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
 state TEXT NOT NULL CHECK(state IN ('reading','draining','sealed')),
 cursor_key TEXT CHECK(cursor_key IS NULL OR length(cursor_key)=64),
 cursor_ms INTEGER,
 tie_rank INTEGER NOT NULL DEFAULT 0 CHECK(tie_rank>=0),
 page_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(page_ordinal>=0),
 seen_count INTEGER NOT NULL DEFAULT 0 CHECK(seen_count>=0),
 claim_token TEXT,
 claim_expires_ms INTEGER NOT NULL DEFAULT 0 CHECK(claim_expires_ms>=0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((cursor_key IS NULL)=(cursor_ms IS NULL)),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_canonical_input_owner ON analytics_canonical_input_work(source_id,owner_digest);
CREATE TABLE analytics_canonical_input_pending (
 scope_key TEXT PRIMARY KEY REFERENCES analytics_canonical_input_work(scope_key) ON DELETE CASCADE,
 source_stamp TEXT NOT NULL CHECK(length(source_stamp)=64),
 page_key TEXT NOT NULL CHECK(length(page_key)=64),
 source_revision TEXT NOT NULL CHECK(length(source_revision)=64),
 next_key TEXT CHECK(next_key IS NULL OR length(next_key)=64),
 next_ms INTEGER,
 next_tie_rank INTEGER NOT NULL CHECK(next_tie_rank>=0),
 seen_keys_json TEXT NOT NULL CHECK(json_valid(seen_keys_json) AND json_type(seen_keys_json)='array'),
 terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
 CHECK((next_key IS NULL)=(next_ms IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE analytics_canonical_input_seen (
 scope_key TEXT NOT NULL REFERENCES analytics_canonical_input_work(scope_key) ON DELETE CASCADE,
 occurrence_key TEXT NOT NULL CHECK(length(occurrence_key)=64),
 PRIMARY KEY(scope_key,occurrence_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER analytics_canonical_input_admit BEFORE INSERT ON analytics_canonical_input_work
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources s ON s.source_id=o.source_id
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.revision=NEW.owner_revision
 AND o.authority_epoch=NEW.authority_epoch AND o.state='active' AND s.source_namespace IS NOT NULL
 AND s.contract_version=1 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'canonical_input_authority'); END;
CREATE TRIGGER analytics_canonical_input_seal BEFORE UPDATE OF state ON analytics_canonical_input_work
WHEN NEW.state='sealed' AND (OLD.state!='draining' OR EXISTS(SELECT 1 FROM analytics_canonical_input_pending p
 WHERE p.scope_key=NEW.scope_key) OR EXISTS(
 SELECT 1 FROM analytics_canonical_heads h JOIN analytics_canonical_facts f ON f.revision=h.revision
 JOIN analytics_canonical_days d ON d.revision=f.revision AND d.day=NEW.source_day
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest AND f.selection_method=NEW.selection_method
 AND f.stream=NEW.stream AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_seen s
 WHERE s.scope_key=NEW.scope_key AND s.occurrence_key=h.occurrence_key)))
BEGIN SELECT RAISE(ABORT,'canonical_input_incomplete'); END;
CREATE TRIGGER analytics_canonical_input_owner_terminal AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state!='active' BEGIN
 DELETE FROM analytics_canonical_input_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_canonical_input_erasure AFTER INSERT ON analytics_storage_erasure_fences BEGIN
 DELETE FROM analytics_canonical_input_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
CREATE TRIGGER analytics_canonical_input_owner_delete BEFORE DELETE ON analytics_owner_state BEGIN
 DELETE FROM analytics_canonical_input_work WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
END;
-- END P1 INPUT CHECKPOINTS
