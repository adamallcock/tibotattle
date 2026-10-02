-- Preparation scheduling records only source/digest/day positions. A lease
-- protects selection, never an owner calculation or a downstream publication.
CREATE TABLE analytics_shared_preparation_cursor (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id),
 turn INTEGER NOT NULL DEFAULT 0 CHECK(turn BETWEEN 0 AND 9007199254740990),
 after_recent_owner TEXT NOT NULL DEFAULT '' CHECK(after_recent_owner='' OR length(after_recent_owner)=64 AND after_recent_owner NOT GLOB '*[^0-9a-f]*'),
 after_dirty_owner TEXT NOT NULL DEFAULT '' CHECK(after_dirty_owner='' OR length(after_dirty_owner)=64 AND after_dirty_owner NOT GLOB '*[^0-9a-f]*'),
 after_history_owner TEXT NOT NULL DEFAULT '' CHECK(after_history_owner='' OR length(after_history_owner)=64 AND after_history_owner NOT GLOB '*[^0-9a-f]*'),
 after_resume_rowid INTEGER NOT NULL DEFAULT 0 CHECK(after_resume_rowid>=0),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990),
 claim_token TEXT CHECK(claim_token IS NULL OR length(claim_token)=36),
 claim_expires_ms INTEGER CHECK(claim_expires_ms IS NULL OR claim_expires_ms>=0),
 updated_ms INTEGER NOT NULL DEFAULT 0 CHECK(updated_ms>=0),
 CHECK((claim_token IS NULL AND claim_expires_ms IS NULL) OR (claim_token IS NOT NULL AND claim_expires_ms>updated_ms))
) STRICT;
CREATE TABLE analytics_shared_preparation_ranges (
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
 history_from_day TEXT NOT NULL CHECK(length(history_from_day)=10),
 history_through_day TEXT NOT NULL CHECK(length(history_through_day)=10),
 history_next_day TEXT NOT NULL CHECK(length(history_next_day)=10),
 recent_next_day TEXT NOT NULL CHECK(length(recent_next_day)=10),
 dirty_after_day TEXT NOT NULL DEFAULT '' CHECK(dirty_after_day='' OR length(dirty_after_day)=10),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),
 PRIMARY KEY(source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),
 CHECK(history_from_day<=history_through_day AND julianday(history_through_day)-julianday(history_from_day)<=100)
) STRICT, WITHOUT ROWID;
CREATE INDEX analytics_shared_preparation_pending ON analytics_shared_feature_days(source_id,state);
CREATE TRIGGER analytics_shared_preparation_range_insert BEFORE INSERT ON analytics_shared_preparation_ranges
WHEN NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active' AND r.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_shared_preparation_ineligible'); END;
CREATE TRIGGER analytics_shared_preparation_range_update BEFORE UPDATE ON analytics_shared_preparation_ranges
WHEN NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest OR NEW.revision!=OLD.revision+1
 OR NEW.updated_ms<OLD.updated_ms OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_shared_preparation_conflict'); END;
CREATE TRIGGER analytics_shared_preparation_owner_terminal AFTER UPDATE OF state ON analytics_owner_state
WHEN NEW.state!='active'
BEGIN
 DELETE FROM analytics_shared_preparation_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 UPDATE analytics_shared_preparation_cursor SET
  after_recent_owner=CASE WHEN after_recent_owner=NEW.owner_digest THEN '' ELSE after_recent_owner END,
  after_dirty_owner=CASE WHEN after_dirty_owner=NEW.owner_digest THEN '' ELSE after_dirty_owner END,
  after_history_owner=CASE WHEN after_history_owner=NEW.owner_digest THEN '' ELSE after_history_owner END,
  revision=revision+1,claim_token=NULL,claim_expires_ms=NULL
 WHERE source_id=NEW.source_id AND NEW.owner_digest IN(after_recent_owner,after_dirty_owner,after_history_owner);
END;
CREATE TRIGGER analytics_shared_preparation_erasure AFTER INSERT ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_shared_preparation_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 UPDATE analytics_shared_preparation_cursor SET
  after_recent_owner=CASE WHEN after_recent_owner=NEW.owner_digest THEN '' ELSE after_recent_owner END,
  after_dirty_owner=CASE WHEN after_dirty_owner=NEW.owner_digest THEN '' ELSE after_dirty_owner END,
  after_history_owner=CASE WHEN after_history_owner=NEW.owner_digest THEN '' ELSE after_history_owner END,
  revision=revision+1,claim_token=NULL,claim_expires_ms=NULL
 WHERE source_id=NEW.source_id AND NEW.owner_digest IN(after_recent_owner,after_dirty_owner,after_history_owner);
END;

-- Forward-only release of the exact claimant. All0032 claim/promotion and
-- target-authority guards remain unchanged; no frame or checkpoint is rewritten.
DROP TRIGGER analytics_shared_feature_day_update;
CREATE TRIGGER analytics_shared_feature_day_update BEFORE UPDATE ON analytics_shared_feature_days
BEGIN
  SELECT CASE WHEN NEW.job_key!=OLD.job_key OR NEW.source_id!=OLD.source_id
    OR NEW.source_namespace!=OLD.source_namespace OR NEW.owner_digest!=OLD.owner_digest
    OR NEW.day!=OLD.day OR NEW.method_digest!=OLD.method_digest
    OR NEW.dependency_digest!=OLD.dependency_digest OR NEW.authority_epoch!=OLD.authority_epoch
    OR NEW.owner_revision<OLD.owner_revision OR NEW.input_revision<OLD.input_revision
    OR NEW.updated_ms<OLD.updated_ms OR OLD.state!='building'
    OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o
      JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest
        AND o.state='active' AND o.revision=NEW.owner_revision
        AND o.authority_epoch=NEW.authority_epoch
        AND r.source_namespace=NEW.source_namespace AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    OR NOT (
      (NEW.head_revision=OLD.head_revision AND NEW.state='building'
        AND NEW.payload_digest IS OLD.payload_digest AND NEW.payload_bytes=OLD.payload_bytes
        AND NEW.part_count=OLD.part_count AND NEW.claim_token IS NOT NULL
        AND (OLD.claim_token IS NULL OR OLD.claim_expires_ms<=NEW.updated_ms))
      OR
      (NEW.head_revision=OLD.head_revision+1 AND OLD.claim_token IS NOT NULL
        AND OLD.claim_expires_ms>NEW.updated_ms AND NEW.claim_token IS NULL
        AND NEW.state IN ('building','complete','refused')
        AND NEW.part_count=(SELECT count(*) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision
            AND p.claim_token=OLD.claim_token AND p.saved_ms=NEW.updated_ms)
        AND NEW.payload_bytes=(SELECT sum(payload_bytes) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
        AND 0=(SELECT min(part_index) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision)
        AND NEW.part_count-1=(SELECT max(part_index) FROM analytics_shared_feature_parts p
          WHERE p.job_key=NEW.job_key AND p.revision=NEW.head_revision))
      OR
      (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.claim_expires_ms IS NULL
        AND NEW.head_revision=OLD.head_revision AND NEW.state=OLD.state
        AND NEW.owner_revision=OLD.owner_revision AND NEW.input_revision=OLD.input_revision
        AND NEW.updated_ms=OLD.updated_ms AND NEW.payload_digest IS OLD.payload_digest
        AND NEW.payload_bytes=OLD.payload_bytes AND NEW.part_count=OLD.part_count)
    ) THEN RAISE(ABORT,'analytics_shared_feature_head_conflict') END;
END;
CREATE TRIGGER analytics_shared_feature_release_v1 BEFORE UPDATE ON analytics_shared_feature_days WHEN 0
BEGIN SELECT RAISE(ABORT,'analytics_shared_feature_release_v1'); END;

-- Subject-free source/day scheduling metadata. The native incarnation survives
-- bounded cleanup, so a stale revision cannot update a recreated cursor.
CREATE TABLE analytics_community_daily_owner_cursor (
 cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 day TEXT NOT NULL CHECK(length(day)=10),
 next_owner_offset INTEGER NOT NULL CHECK(next_owner_offset BETWEEN 0 AND 9007199254740991),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 UNIQUE(source_id,day),
 CHECK(cursor_id BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE TRIGGER analytics_community_daily_owner_cursor_update
BEFORE UPDATE ON analytics_community_daily_owner_cursor
WHEN NEW.cursor_id!=OLD.cursor_id OR NEW.source_id!=OLD.source_id OR NEW.day!=OLD.day
 OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_cursor_conflict'); END;

-- Per-source/owner date scheduling coordinates only. Six exact lifecycle guards
-- preserve retained-fence replay, erasure and incarnation-safe cleanup.
CREATE TABLE analytics_cache_retention_date_cursor (
 cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),
 cycle_upper_day INTEGER NOT NULL CHECK(cycle_upper_day BETWEEN -719528 AND 2932896),
 next_day INTEGER NOT NULL CHECK(next_day BETWEEN -719528 AND 2932897),
 next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 0 AND 9007199254740991),
 day_slot_limit INTEGER NOT NULL CHECK(day_slot_limit BETWEEN 0 AND 9007199254740991),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 UNIQUE(source_id,owner_digest),
 FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),
 CHECK(cursor_id BETWEEN 1 AND 9007199254740991),
 CHECK(next_day<=cycle_upper_day+1),
 CHECK(next_ordinal<=day_slot_limit),
 CHECK(day_slot_limit>0 OR next_ordinal=0),
 CHECK(next_day<=cycle_upper_day OR (next_ordinal=0 AND day_slot_limit=0))
) STRICT;
CREATE TRIGGER analytics_cache_retention_date_cursor_insert
BEFORE INSERT ON analytics_cache_retention_date_cursor
WHEN NEW.revision!=1 OR NEW.next_ordinal!=0 OR NEW.day_slot_limit!=0
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
  WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active' AND r.contract_version=1
  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_cache_date_cursor_conflict'); END;
CREATE TRIGGER analytics_cache_retention_date_cursor_update
BEFORE UPDATE ON analytics_cache_retention_date_cursor
WHEN NEW.cursor_id!=OLD.cursor_id OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.revision!=OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
 OR NOT (
  (OLD.next_day=OLD.cycle_upper_day+1 AND NEW.next_day<=NEW.cycle_upper_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)
  OR (NEW.cycle_upper_day=OLD.cycle_upper_day AND OLD.next_day<=OLD.cycle_upper_day AND (
   (NEW.next_day>OLD.next_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)
   OR (NEW.next_day=OLD.next_day AND OLD.day_slot_limit>0 AND NEW.day_slot_limit=OLD.day_slot_limit AND NEW.next_ordinal>OLD.next_ordinal)
   OR (NEW.next_day>=OLD.next_day AND OLD.day_slot_limit=0 AND NEW.day_slot_limit>0 AND NEW.next_ordinal>0)
  ))
 )
BEGIN SELECT RAISE(ABORT,'analytics_cache_date_cursor_conflict'); END;
CREATE TRIGGER analytics_cache_retention_date_cursor_owner_terminal
AFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'
BEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_cache_retention_date_cursor_erasure
AFTER INSERT ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;

-- Additive review proposal only. Keep approved table and four guard bytes exact.
CREATE TRIGGER analytics_cache_retention_date_cursor_erasure_replay
AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END;
CREATE TRIGGER analytics_cache_retention_date_cursor_owner_delete
BEFORE DELETE ON analytics_owner_state
BEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END;
