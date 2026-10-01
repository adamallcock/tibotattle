-- 0026: admit the version-neutral effective owner/day layout into the
-- cache-retention lane.
--
-- Why: the v1 and v1.1 lanes cannot independently represent a mixed owner once
-- a successor client is admitted. The effective owner/day reader reconciles
-- every admitted family by occurrence first, then feeds the unchanged
-- cache-retention-v2 reducer. This migration adds the closed layout token and
-- a bounded, replaceable reducer checkpoint for dense effective days; it does
-- not change the metric, bands, method version, or legacy rows.
--
-- What does NOT change: the METHOD. The v1 usage event carries every field the
-- measurement reads -- `sessionUuid`, `modelId`, `reasoningEffort`,
-- `speedMode`, `surface` and the three input token components -- under the
-- same names and the same closed validator as v1.1 (apps/worker/src/
-- telemetry-v1.ts `parseUsageEvent`). The one field v1 lacks is
-- `accountPlanAttribution`, which this measurement never reads. Same
-- population filter, same same-configuration fields, same bands, same order,
-- same lookback. `method_version` therefore stays 'cache-retention-v2' and the
-- pinned method digest is untouched: a wider input is not a different
-- measurement, and bumping the version would have retired every row already
-- computed for no reason a reader could point at.
--
-- What changes: `source_layout` gains 'effective'. It is in the mark identity
-- and in the table's UNIQUE, so one reconciled owner/day cannot collide with
-- either legacy layout. The device and manifest fields are closed constants;
-- the effective manifest digest is the lowercase SHA-256 dependency digest
-- embedded in the completed daily projection cursor. It intentionally does
-- not use the owner-wide revision: an upload for an unrelated day must not
-- invalidate a closed day or restart its durable cache reducer.
--
-- Two of the key's columns have no delivered v1 value, and this migration
-- pins them as layout constants rather than inventing per-day values:
-- a v1 day is delivered as a VECTOR of chunks rather than one manifest, and
-- its device is ELECTED from the source chunk headers at read time
-- (`selectV1WinningDevices`) rather than pinned by the delivery. Both are a
-- function of the day's chunk vector, which the day's `manifest_digest`
-- covers. Recording a per-device digest instead would make one owner-day
-- several candidates, and the pooled community merge would then count that
-- day once per device.
--
-- The v1 `manifest_digest` is DERIVED, not delivered: it is the fixed-width
-- hex encoding of `COUNT(*)` and `MAX(owner_revision)` over that (owner, day)
-- in `analytics_v1_chunk_values`. `owner_revision` is the owner's journal
-- revision of the change that wrote the row, revisions are per-owner
-- monotonic, and `analytics_v1_chunk_forward` requires a strictly increasing
-- one on every update, so any write to any chunk of a day carries a revision
-- greater than every row that owner already holds. The value therefore changes
-- exactly when that day's chunk set changes -- restated, extended, or
-- delivered for the first time -- and never when another day's does, which is
-- the property v1.1 gets from its delivered manifest digest.
--
-- Forward-only and row-preserving. SQLite cannot widen a CHECK constraint in
-- place, so the marks table is rebuilt and its rows are carried across
-- unchanged; the existing legacy marks stay valid under the unchanged method
-- and are not recomputed. The other three published-value tables carry no
-- `source_layout` and are not touched at all. The seven triggers that name the
-- marks table are dropped before the rebuild and recreated after it, because
-- `ALTER TABLE ... RENAME` rewrites a trigger body that references the renamed
-- table. The checkpoint table and its terminal fences are created after that
-- forward-only rebuild.
--
-- ORDER OF OPERATIONS: apply before enabling the effective retention worker.
-- The worker remains safe while this migration is absent because effective
-- candidates are refused and the frozen legacy layouts remain readable.
DROP TRIGGER analytics_cache_retention_day_marks_immutable;
DROP TRIGGER analytics_cache_retention_day_values_complete;
DROP TRIGGER analytics_cache_retention_day_marks_terminal_insert;
DROP TRIGGER analytics_cache_retention_day_carry_immutable;
DROP TRIGGER analytics_cache_retention_day_carry_retained;
DROP TRIGGER analytics_cache_retention_day_values_immutable;
DROP TRIGGER analytics_cache_retention_day_values_retained;
ALTER TABLE analytics_cache_retention_day_marks RENAME TO analytics_cache_retention_day_marks_0026;

-- The DAY record, and the unit the lane selects on. A day that produced no
-- qualifying adjacency is a real, common outcome (a quota-only day, a day of
-- single-request sessions), and without a day record the oldest-day-first
-- selection would re-select it every pass forever.
-- Field notes for the statement below. They sit ABOVE it, never inside it:
-- D1 applies a migration one statement at a time and its splitter drops a
-- comment from within one, so an inline note makes the applied DDL differ
-- from the same file imported whole. `npm run scripts:check` fails that.
-- `source_layout`:
-- The delivery layout the day was read from. In the identity and in the
-- UNIQUE, so all layouts coexist per (owner, day) without collision.
-- `device_id`:
-- The typed device surrogate the delivered day carries, for 'typed-v11'.
-- For 'typed-v1' there is none to carry: the device is elected from the
-- source chunk headers at read time, so the constant below is recorded and
-- the CHECK holds it there. For 'effective', the source families are already
-- reconciled, so `effective-owner` keeps exactly one candidate per owner-day.
-- `manifest_id`:
-- The delivered day manifest, for 'typed-v11'. v1 delivers no manifest, so
-- the constant below names what its identity actually is: a chunk vector. The
-- effective layout similarly uses `effective-owner-day`.
-- `manifest_digest`:
-- The delivered day manifest digest for 'typed-v11'; for 'typed-v1' the
-- derived day revision; for 'effective' the completed daily projection's
-- closed-window dependency digest. The effective value changes when that
-- day's selected source inputs change, while unrelated owner uploads leave it
-- stable so a resumable cache build can continue.
--
CREATE TABLE analytics_cache_retention_day_marks (
  mark_key TEXT PRIMARY KEY CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('typed-v11','typed-v1','effective')),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
  manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method_version TEXT NOT NULL CHECK(method_version IN ('cache-retention-v2','cache-retention-v3')),
  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),
  carry_days INTEGER NOT NULL CHECK(carry_days>=0 AND carry_days<=31),
  value_count INTEGER NOT NULL CHECK(value_count>=0 AND value_count<=4096),
  events_read INTEGER NOT NULL CHECK(events_read>=0),
  unreadable_events INTEGER NOT NULL CHECK(unreadable_events>=0 AND unreadable_events<=events_read),
  values_digest TEXT NOT NULL CHECK(length(values_digest)=64 AND values_digest NOT GLOB '*[^0-9a-f]*'),
  refusal TEXT CHECK(refusal IS NULL OR refusal IN ('group_limit_exceeded',
    'session_limit_exceeded','usage_row_refused','day_page_limit_exceeded',
    'checkpoint_size_exceeded')),
  CHECK(refusal IS NULL OR (value_count=0 AND events_read=0 AND unreadable_events=0)),
  CHECK(source_layout!='typed-v1' OR (device_id='v1-elected-at-read' AND manifest_id='v1-chunk-vector')),
  CHECK(source_layout!='effective' OR (device_id='effective-owner' AND manifest_id='effective-owner-day')),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
    manifest_digest,day,method_version,carry_digest),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
INSERT INTO analytics_cache_retention_day_marks SELECT mark_key,source_id,source_layout,
  source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,method_version,
  carry_digest,carry_days,value_count,events_read,unreadable_events,values_digest,refusal
  FROM analytics_cache_retention_day_marks_0026;
DROP TABLE analytics_cache_retention_day_marks_0026;

-- Selected by (owner, day) oldest-first and swept by (method_version) for
-- retirement. Both are covered prefixes.
CREATE INDEX analytics_cache_retention_day_owner
  ON analytics_cache_retention_day_marks(source_id,owner_digest,day,method_version);
CREATE INDEX analytics_cache_retention_day_retirement
  ON analytics_cache_retention_day_marks(source_id,method_version,owner_digest,day);

-- A promoted row is immutable at every tier. A staged row is replaceable only
-- while nothing above it authorizes it, which is what lets an interrupted
-- write retry without ever mutating promoted evidence.
CREATE TRIGGER analytics_cache_retention_day_marks_immutable
BEFORE UPDATE ON analytics_cache_retention_day_marks
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_mark_conflict'); END;
CREATE TRIGGER analytics_cache_retention_day_carry_immutable
BEFORE UPDATE ON analytics_cache_retention_day_carry
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.mark_key)
 OR OLD.mark_key IS NOT NEW.mark_key OR OLD.day IS NOT NEW.day
 OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.device_id IS NOT NEW.device_id
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_carry_retained'); END;
CREATE TRIGGER analytics_cache_retention_day_carry_retained
BEFORE DELETE ON analytics_cache_retention_day_carry
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.mark_key)
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_carry_retained'); END;
CREATE TRIGGER analytics_cache_retention_day_values_immutable
BEFORE UPDATE ON analytics_cache_retention_day_values
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.mark_key)
 OR OLD.value_key IS NOT NEW.value_key OR OLD.mark_key IS NOT NEW.mark_key
 OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.day IS NOT NEW.day OR OLD.method_version IS NOT NEW.method_version
 OR OLD.carry_digest IS NOT NEW.carry_digest OR OLD.model IS NOT NEW.model OR OLD.effort IS NOT NEW.effort
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_value_retained'); END;
CREATE TRIGGER analytics_cache_retention_day_values_retained
BEFORE DELETE ON analytics_cache_retention_day_values
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.mark_key)
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_value_retained'); END;

-- A day mark is admitted only once every values row it claims exists and
-- agrees on scope, so a partly written day is never readable as a whole one.
CREATE TRIGGER analytics_cache_retention_day_values_complete
BEFORE INSERT ON analytics_cache_retention_day_marks
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_cache_retention_day_values
      WHERE mark_key=NEW.mark_key)!=NEW.value_count
    OR (SELECT COUNT(*) FROM analytics_cache_retention_day_carry
      WHERE mark_key=NEW.mark_key)!=NEW.carry_days
    OR EXISTS(SELECT 1 FROM analytics_cache_retention_day_values v WHERE v.mark_key=NEW.mark_key
      AND (v.source_id!=NEW.source_id OR v.owner_digest!=NEW.owner_digest OR v.day!=NEW.day
        OR v.method_version!=NEW.method_version OR v.carry_digest!=NEW.carry_digest))
    OR EXISTS(SELECT 1 FROM analytics_cache_retention_day_carry c WHERE c.mark_key=NEW.mark_key
      AND (c.source_id!=NEW.source_id OR c.owner_digest!=NEW.owner_digest
        OR c.device_id!=NEW.device_id OR c.day>=NEW.day))
    THEN RAISE(ABORT,'analytics_cache_retention_day_values_incomplete') END;
END;

-- Terminal erasure fences every tier. Without this a delayed builder could
-- recreate an erased owner's aggregate, which is a privacy failure rather than
-- a stale cache.
CREATE TRIGGER analytics_cache_retention_day_marks_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_marks
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;

-- A dense effective day can span several Worker invocations. This is a
-- replaceable, target-side cursor, not another published evidence table: it
-- contains only opaque session digests, reducer counters and the next source
-- cursor. The source identity is repeated so a stale checkpoint cannot be
-- replayed under another owner/day, and the mark guard prevents a late retry
-- from mutating a promoted day.
-- D1's single TEXT/BLOB value limit is 2,000,000 bytes.  The runtime keeps a
-- 100,000-session reducer bound, but refuses a serialized checkpoint before
-- binding if this smaller physical value bound would be exceeded.
CREATE TABLE analytics_cache_retention_day_progress (
  progress_key TEXT PRIMARY KEY CHECK(length(progress_key)=64 AND progress_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout='effective'),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(device_id='effective-owner'),
  manifest_id TEXT NOT NULL CHECK(manifest_id='effective-owner-day'),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method_version TEXT NOT NULL CHECK(method_version='cache-retention-v2'),
  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),
  progress_revision INTEGER NOT NULL CHECK(progress_revision>=1),
  state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=1900000),
  state_digest TEXT NOT NULL CHECK(length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
    manifest_digest,day,method_version,carry_digest)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_cache_retention_day_progress_owner
  ON analytics_cache_retention_day_progress(source_id,owner_digest,day,progress_revision);
CREATE TRIGGER analytics_cache_retention_day_progress_promoted
BEFORE UPDATE ON analytics_cache_retention_day_progress
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.progress_key)
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_progress_promoted'); END;
CREATE TRIGGER analytics_cache_retention_day_progress_promoted_delete
BEFORE DELETE ON analytics_cache_retention_day_progress
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.progress_key)
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_progress_promoted'); END;
CREATE TRIGGER analytics_cache_retention_day_progress_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_progress
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_progress_terminal_update
BEFORE UPDATE ON analytics_cache_retention_day_progress
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
 OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=OLD.source_id AND f.owner_digest=OLD.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
