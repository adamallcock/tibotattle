-- Prepared per-(owner, UTC day) cache-retention aggregate: how long a cached
-- prefix survives a pause between consecutive same-configuration requests in
-- one session. Forward-only: this migration creates new tables and touches no
-- existing row.
--
-- This is NOT the local dashboard's cache-continuity metric and must never be
-- published beside it. The local lens admits only returns to an idle thread
-- (`usage_event_boundary.turn_context_before = 1`); nothing uploaded today
-- carries that bit, so this lane measures every adjacent request. Measured on
-- the owner's own corpus, sub-minute adjacencies are 97.6% intra-turn, which
-- inflates apparent reuse from 94.8% to 99.1% and over-weights that band 49x.
-- The published caption therefore says CONSECUTIVE REQUESTS, not user turns,
-- and no premium-dollar or coverage claim may be derived from these rows.
--
-- Identity follows 0019: the day manifest identity is the owner's per-day input
-- revision, so a re-upload that restates one day changes only that day's
-- `manifest_digest` and only that day's keys. `method_version` carries the
-- computation contract and is IN the identity of every row, so a definition
-- change misses every key rather than being servable beside rows computed the
-- old way. `carry_digest` does the same for the bounded cross-midnight
-- lookback: a pair is attributed to the CURRENT event's day and its previous
-- event may lie in an earlier day, so the seven preceding days are a real
-- input and a restatement of any of them must retire the dependent day.
--
-- No participant, device original id, session, path, filename, prompt or raw
-- account identifier is stored. `device_id` is the typed device surrogate the
-- delivered day already carries; the only owner-scoped key is the existing
-- owner digest; `model` and `effort` are the bounded dictionary tokens the
-- usage event already carries. Session identity never leaves the builder: it
-- is an opaque owner-scoped digest used only for equality, and only its
-- cardinality reaches these rows.

-- The DAY record, and the unit the lane selects on. A day that produced no
-- qualifying adjacency is a real, common outcome (a quota-only day, a day of
-- single-request sessions), and without a day record the oldest-day-first
-- selection would re-select it every pass forever. That is the same
-- head-of-line stall 0019's refusal table exists to prevent; here the day is
-- not refused, it is simply empty, so the mark records the empty result.
-- Field notes for the statement below. They sit ABOVE it, never inside it:
-- D1 applies a migration one statement at a time and its splitter drops a
-- comment from within one, so an inline note makes the applied DDL differ
-- from the same file imported whole. `npm run scripts:check` fails that.
-- `carry_days`:
-- Calendar days of bounded lookback the carry digest covers. Fixed by the
-- method, restated here so a row says what it depended on without a join.
-- `value_count`:
-- Values rows this day promoted, one per (model, effort) that produced at
-- least one same-configuration adjacency. Zero is a valid, recorded day.
-- `events_read`:
-- Usage rows the day's read returned, including rows the mapper skipped.
-- An empty day that was READ is distinguishable from one that was not.
-- `unreadable_events`:
-- Rows that broke a session chain because they could not be read at all.
-- Explicit rather than folded into `events_read`: unreadable evidence is
-- neither absence nor zero.
-- `refusal`:
-- A day that cannot be represented within the method's bounds is recorded
-- here rather than rediscovered, for exactly the reason 0019 grew a refusal
-- table: the oldest-day-first selection would otherwise re-select it every
-- pass and, once enough accumulate at the earliest dates, the lane never
-- advances again while reporting itself complete. The mark's own identity
-- already carries the day manifest digest and the carry digest, so a
-- re-upload of the day OR of any day it depended on retries it
-- automatically and nothing else does. Only reasons that are a function of
-- the day's own inputs are in the vocabulary: an owner-scoped transient
-- condition recorded per day would exclude that owner's earliest days for
-- good, so it stays a skip in the lane instead.
--
CREATE TABLE analytics_cache_retention_day_marks (
  mark_key TEXT PRIMARY KEY CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('typed-v11')),
  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
  manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method_version TEXT NOT NULL CHECK(method_version IN ('cache-retention-v1')),
  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),
  carry_days INTEGER NOT NULL CHECK(carry_days>=0 AND carry_days<=31),
  value_count INTEGER NOT NULL CHECK(value_count>=0 AND value_count<=4096),
  events_read INTEGER NOT NULL CHECK(events_read>=0),
  unreadable_events INTEGER NOT NULL CHECK(unreadable_events>=0 AND unreadable_events<=events_read),
  values_digest TEXT NOT NULL CHECK(length(values_digest)=64 AND values_digest NOT GLOB '*[^0-9a-f]*'),
  refusal TEXT CHECK(refusal IS NULL OR refusal IN ('group_limit_exceeded',
    'session_limit_exceeded','usage_row_refused','day_page_limit_exceeded')),
  CHECK(refusal IS NULL OR (value_count=0 AND events_read=0 AND unreadable_events=0)),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
    manifest_digest,day,method_version,carry_digest),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
-- Selected by (owner, day) oldest-first and swept by (method_version) for
-- retirement. Both are covered prefixes.
CREATE INDEX analytics_cache_retention_day_owner
  ON analytics_cache_retention_day_marks(source_id,owner_digest,day,method_version);
CREATE INDEX analytics_cache_retention_day_retirement
  ON analytics_cache_retention_day_marks(source_id,method_version,owner_digest,day);

-- The EXACT lookback dependency, one row per calendar day in the window,
-- present whether or not that day was delivered. An absent day is recorded as
-- the empty digest, so a day that is delivered LATER is as detectable as one
-- that is restated: both change the recorded digest and both must retire the
-- dependent day. The digest alone could not be checked in SQL; these rows can.
-- Field notes for the statement below. They sit ABOVE it, never inside it:
-- D1 applies a migration one statement at a time and its splitter drops a
-- comment from within one, so an inline note makes the applied DDL differ
-- from the same file imported whole. `npm run scripts:check` fails that.
-- `manifest_digest`:
-- The delivered manifest digest for that day, or '' when nothing was
-- delivered. Never a guess, never a zero.
--
CREATE TABLE analytics_cache_retention_day_carry (
  mark_key TEXT NOT NULL CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=0
    OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY(mark_key,day)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_cache_retention_day_carry_owner
  ON analytics_cache_retention_day_carry(source_id,owner_digest,day,mark_key);
-- Additive index on 0004's table: no column, constraint or row changes. The
-- candidate selection resolves each recorded carry day against the currently
-- delivered manifest for that (owner, device, day), and 0004's own index stops
-- at (source_id, owner_digest) while its UNIQUE puts the manifest columns
-- before `day`. Without this the staleness check degrades to an owner-wide
-- scan per carry row per candidate, which is the difference between a bounded
-- selection statement and one that grows with the owner's whole history.
CREATE INDEX analytics_v11_reusable_owner_day
  ON analytics_v11_reusable_values(source_id,owner_digest,device_id,day,manifest_digest);

-- One values row per (owner, day, method_version, model, effort). `model` and
-- `effort` are dimensions; `speedMode` and `surface` are same-configuration
-- FILTERS on the pair rather than dimensions, exactly as the local lens treats
-- them, so a pair whose speed mode or surface changed is not an adjacency at
-- all and never reaches a row.
-- Field notes for the statement below. They sit ABOVE it, never inside it:
-- D1 applies a migration one statement at a time and its splitter drops a
-- comment from within one, so an inline note makes the applied DDL differ
-- from the same file imported whole. `npm run scripts:check` fails that.
-- `adjacencies`:
-- Comparable adjacencies: same configuration, both sides' token components
-- observed, previous cache read > 0, and the prompt large enough to have
-- held the previous prefix. The two exclusions are counted per band.
--
CREATE TABLE analytics_cache_retention_day_values (
  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  mark_key TEXT NOT NULL CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method_version TEXT NOT NULL CHECK(method_version IN ('cache-retention-v1')),
  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 64 AND model NOT GLOB '*[^A-Za-z0-9._:-]*'),
  effort TEXT NOT NULL CHECK(length(effort) BETWEEN 1 AND 64 AND effort NOT GLOB '*[^A-Za-z0-9._:-]*'),
  adjacencies INTEGER NOT NULL CHECK(adjacencies>=0),
  sessions INTEGER NOT NULL CHECK(sessions>=0),
  bands_digest TEXT NOT NULL CHECK(length(bands_digest)=64 AND bands_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(source_id,owner_digest,day,method_version,carry_digest,model,effort),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_cache_retention_day_values_mark
  ON analytics_cache_retention_day_values(mark_key,model,effort);
CREATE INDEX analytics_cache_retention_day_values_owner
  ON analytics_cache_retention_day_values(source_id,owner_digest,day,method_version);

-- Seven closed bands per values row, the same seven the local lens uses, so a
-- reader cannot silently compare a hosted band against a differently cut one.
-- Integers only: a rate is computed by the merge, never stored rounded.
-- Field notes for the statement below. They sit ABOVE it, never inside it:
-- D1 applies a migration one statement at a time and its splitter drops a
-- comment from within one, so an inline note makes the applied DDL differ
-- from the same file imported whole. `npm run scripts:check` fails that.
-- `unordered_ties`:
-- Adjacencies whose two events share an observed instant. There is no
-- defensible order between them and no uploaded field supplies one, so they
-- are counted and reported rather than hidden or re-ordered by guess.
-- table constraint:
-- `matched_or_exceeded` implies `reused_more_than_half` because the previous
-- cache read is strictly positive on every comparable adjacency.
--
CREATE TABLE analytics_cache_retention_day_bands (
  value_key TEXT NOT NULL CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  band TEXT NOT NULL CHECK(band IN ('under_one_minute','one_to_five_minutes','five_to_thirty_minutes',
    'thirty_minutes_to_one_hour','one_to_six_hours','six_to_twenty_four_hours','over_twenty_four_hours')),
  source_id TEXT NOT NULL,
  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method_version TEXT NOT NULL CHECK(method_version IN ('cache-retention-v1')),
  adjacencies INTEGER NOT NULL CHECK(adjacencies>=0),
  reused_more_than_half INTEGER NOT NULL CHECK(reused_more_than_half>=0),
  matched_or_exceeded INTEGER NOT NULL CHECK(matched_or_exceeded>=0),
  unordered_ties INTEGER NOT NULL CHECK(unordered_ties>=0),
  excluded_insufficient_evidence INTEGER NOT NULL CHECK(excluded_insufficient_evidence>=0),
  excluded_context_contracted INTEGER NOT NULL CHECK(excluded_context_contracted>=0),
  sessions INTEGER NOT NULL CHECK(sessions>=0),
  CHECK(reused_more_than_half<=adjacencies AND matched_or_exceeded<=reused_more_than_half
    AND unordered_ties<=adjacencies AND sessions<=adjacencies),
  PRIMARY KEY(value_key,band)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_cache_retention_day_bands_owner
  ON analytics_cache_retention_day_bands(source_id,method_version,band,owner_digest,day);

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
CREATE TRIGGER analytics_cache_retention_day_bands_immutable
BEFORE UPDATE ON analytics_cache_retention_day_bands
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_values v WHERE v.value_key=OLD.value_key)
 OR OLD.value_key IS NOT NEW.value_key OR OLD.band IS NOT NEW.band
 OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest
 OR OLD.day IS NOT NEW.day OR OLD.method_version IS NOT NEW.method_version
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_band_retained'); END;
CREATE TRIGGER analytics_cache_retention_day_bands_retained
BEFORE DELETE ON analytics_cache_retention_day_bands
WHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_values v WHERE v.value_key=OLD.value_key)
BEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_band_retained'); END;

-- A values row is admitted only once all seven of its bands exist and agree on
-- scope, and its own totals agree with them. `sessions` is a distinct count and
-- does not sum across bands, so it is bounded by them rather than equated: at
-- least the largest band's, at most their sum.
CREATE TRIGGER analytics_cache_retention_day_bands_complete
BEFORE INSERT ON analytics_cache_retention_day_values
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_cache_retention_day_bands WHERE value_key=NEW.value_key)!=7
    OR COALESCE((SELECT SUM(adjacencies) FROM analytics_cache_retention_day_bands
      WHERE value_key=NEW.value_key),0)!=NEW.adjacencies
    OR NEW.sessions>COALESCE((SELECT SUM(sessions) FROM analytics_cache_retention_day_bands
      WHERE value_key=NEW.value_key),0)
    OR NEW.sessions<COALESCE((SELECT MAX(sessions) FROM analytics_cache_retention_day_bands
      WHERE value_key=NEW.value_key),0)
    OR EXISTS(SELECT 1 FROM analytics_cache_retention_day_bands b WHERE b.value_key=NEW.value_key
      AND (b.source_id!=NEW.source_id OR b.owner_digest!=NEW.owner_digest OR b.day!=NEW.day
        OR b.method_version!=NEW.method_version))
    THEN RAISE(ABORT,'analytics_cache_retention_day_bands_incomplete') END;
END;

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

-- Terminal erasure fences every tier. Without these a delayed builder could
-- recreate an erased owner's aggregate, which is a privacy failure rather than
-- a stale cache. Inserts and updates are both fenced because a staged row may
-- be replaced in place before its authorizing row exists.
CREATE TRIGGER analytics_cache_retention_day_marks_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_marks
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_carry_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_carry
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_carry_terminal_update
BEFORE UPDATE ON analytics_cache_retention_day_carry
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_values_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_values_terminal_update
BEFORE UPDATE ON analytics_cache_retention_day_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_bands_terminal_insert
BEFORE INSERT ON analytics_cache_retention_day_bands
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
CREATE TRIGGER analytics_cache_retention_day_bands_terminal_update
BEFORE UPDATE ON analytics_cache_retention_day_bands
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;
