-- Prepared per-(owner, UTC day) graph projection: the reusable INPUT layer the
-- graph acquisition folds, not a per-owner result cache. Forward-only: this
-- migration creates new tables and touches no existing row.
--
-- Identity follows 0004: the day manifest identity IS the owner's per-day input
-- revision, so a re-upload that restates one day changes only that day's
-- `manifest_digest` and only that day's `value_key`. `acquisition_version`
-- carries the kernel contract, so a method change retires these rows rather
-- than silently reusing them. Payload lives only in the bounded pages; the
-- values row is the manifest that authorizes them.
--
-- No participant, device original id, session, path or prompt value is stored:
-- `device_id` is the typed device surrogate the delivered day already carries,
-- and the only owner-scoped key is the existing owner digest.
CREATE TABLE analytics_graph_day_values (
  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('json-v11','typed-v11')),
  source_namespace TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  acquisition_version TEXT NOT NULL CHECK(acquisition_version IN ('graph-day-projection-v1')),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  part_count INTEGER NOT NULL CHECK(part_count>=1 AND part_count<=4096),
  values_digest TEXT NOT NULL CHECK(length(values_digest)=64 AND values_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK((source_layout='json-v11' AND source_namespace='') OR (source_layout='typed-v11' AND length(source_namespace)>0)),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,acquisition_version),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
-- 975 owner-days in the measured window, read by (owner, day) for the fold and
-- swept by (acquisition_version) for retirement. Both are covered prefixes.
CREATE INDEX analytics_graph_day_owner
  ON analytics_graph_day_values(source_id,owner_digest,day,acquisition_version);
CREATE INDEX analytics_graph_day_retirement
  ON analytics_graph_day_values(source_id,acquisition_version,owner_digest,day);

-- Bounded payload pages. The dominant owner carries ~1,150 endpoint tuples and
-- ~170 KB per day, so a normal day is one or two pages; the part scheme exists
-- for the days that exceed one row rather than as the usual case.
CREATE TABLE analytics_graph_day_pages (
  value_key TEXT NOT NULL CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  part_index INTEGER NOT NULL CHECK(part_index>=0 AND part_index<4096),
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  acquisition_version TEXT NOT NULL CHECK(acquisition_version IN ('graph-day-projection-v1')),
  component TEXT NOT NULL CHECK(component IN ('planAnchors','fitFragments','runEndpoints',
    'usageCells','usageOpeners','usageSessions','usageRowsRead')),
  entry_count INTEGER NOT NULL CHECK(entry_count>=0),
  part_digest TEXT NOT NULL CHECK(length(part_digest)=64 AND part_digest NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'
    AND length(CAST(payload_json AS BLOB))<=262144),
  PRIMARY KEY(value_key,part_index),
  CHECK(json_extract(payload_json,'$.component')=component
    AND json_array_length(json_extract(payload_json,'$.entries'))=entry_count)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_graph_day_pages_owner
  ON analytics_graph_day_pages(source_id,owner_digest,day,value_key,part_index);

-- A promoted values row is immutable; a staged page is replaceable only while
-- no values row authorizes it, which is what lets an interrupted write retry
-- without ever mutating a promoted projection.
CREATE TRIGGER analytics_graph_day_values_immutable BEFORE UPDATE ON analytics_graph_day_values
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_value_conflict'); END;
CREATE TRIGGER analytics_graph_day_page_immutable BEFORE UPDATE ON analytics_graph_day_pages
WHEN EXISTS(SELECT 1 FROM analytics_graph_day_values v WHERE v.value_key=OLD.value_key)
 OR OLD.value_key IS NOT NEW.value_key OR OLD.part_index IS NOT NEW.part_index
 OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.day IS NOT NEW.day OR OLD.acquisition_version IS NOT NEW.acquisition_version
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_page_retained'); END;
CREATE TRIGGER analytics_graph_day_page_retained BEFORE DELETE ON analytics_graph_day_pages
WHEN EXISTS(SELECT 1 FROM analytics_graph_day_values v WHERE v.value_key=OLD.value_key)
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_page_retained'); END;

-- A values row is admitted only once its whole framed payload exists and every
-- page agrees with its scope, mirroring analytics_v11_summary_pages_complete.
CREATE TRIGGER analytics_graph_day_pages_complete BEFORE INSERT ON analytics_graph_day_values
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_graph_day_pages WHERE value_key=NEW.value_key)!=NEW.part_count
    OR COALESCE((SELECT SUM(entry_count) FROM analytics_graph_day_pages WHERE value_key=NEW.value_key),0)!=NEW.record_count
    OR EXISTS(SELECT 1 FROM analytics_graph_day_pages p WHERE p.value_key=NEW.value_key
      AND (p.source_id!=NEW.source_id OR p.owner_digest!=NEW.owner_digest OR p.day!=NEW.day
        OR p.acquisition_version!=NEW.acquisition_version OR p.part_index>=NEW.part_count))
    THEN RAISE(ABORT,'analytics_graph_day_pages_incomplete') END;
END;

-- Terminal erasure fences both payload tables. Without these a delayed builder
-- could recreate prepared graph payload for an owner whose erasure receipt was
-- already written, which is a privacy failure rather than a stale cache.
CREATE TRIGGER analytics_graph_day_values_terminal_insert BEFORE INSERT ON analytics_graph_day_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_graph_day_pages_terminal_insert BEFORE INSERT ON analytics_graph_day_pages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_graph_day_pages_terminal_update BEFORE UPDATE ON analytics_graph_day_pages
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;

-- A day that cannot be prepared is permanently unpreparable under the SAME
-- inputs, so the refusal is recorded rather than rediscovered. Without this the
-- oldest-first candidate query re-selects it every pass, and once `maxDays`
-- unpreparable days accumulate at the earliest dates the lane never advances
-- again while reporting itself complete.
--
-- The key carries the day manifest digest and the acquisition version, so a
-- re-upload of that day or a kernel bump retries it automatically; nothing else
-- does, which is the point. No reason text beyond the closed vocabulary and no
-- owner-scoped value beyond the existing owner digest is stored.
CREATE TABLE analytics_graph_day_refusals (
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  acquisition_version TEXT NOT NULL CHECK(acquisition_version IN ('graph-day-projection-v1')),
  reason TEXT NOT NULL CHECK(reason IN ('plan_anchor_limit_exceeded','run_endpoint_limit_exceeded',
    'usage_cost_limit_exceeded','usage_cell_limit_exceeded','usage_session_limit_exceeded',
    'usage_row_refused','owner_source_unavailable')),
  refused_ms INTEGER NOT NULL CHECK(refused_ms>=0),
  PRIMARY KEY(source_id,owner_digest,day,manifest_digest,acquisition_version)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_graph_day_refusals_source
  ON analytics_graph_day_refusals(source_id,acquisition_version,day,owner_digest);
-- Owner erasure removes the marker with everything else owner-scoped; it is
-- selection state, like the graph work selection, not retained payload.
CREATE TRIGGER analytics_graph_day_refusal_erasure_fence
AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
  DELETE FROM analytics_graph_day_refusals
   WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;
