-- Correction-aware effective quota inputs reuse the prepared graph-day
-- framing and quota kernel. This widens only the closed source-layout key;
-- every legacy key, payload digest and stored row is carried over unchanged.
-- Effective manifest digests cover the reconciled owner/day dependency with
-- sessions included, matching effective-daily-cursor-v2. They are never a
-- physical v1.1 manifest digest. Closed device/manifest constants keep one
-- owner/day identity across every retained source family.
--
-- quota_rows_read is the number of reconciled quota occurrences before daily
-- reduction. It participates in the effective values digest, so a prepared
-- fold cannot evade the acquisition row bound. effective_owner_revision is
-- only freshness evidence for retirement: an older or absent daily projector
-- cannot retire a newer prepared day. It is deliberately outside the content
-- digest, permitting exact replay after an unrelated owner upload.
--
-- SQLite requires a table rebuild to widen CHECK constraints. Drop every
-- trigger naming the values table before rename, then restore the same
-- immutable, completeness and erasure guards. Payload pages are untouched.
-- The final contract trigger is a runtime capability marker. Effective writes
-- refuse before staging any payload until it and both metadata columns exist.
DROP TRIGGER analytics_graph_day_values_immutable;
DROP TRIGGER analytics_graph_day_page_immutable;
DROP TRIGGER analytics_graph_day_page_retained;
DROP TRIGGER analytics_graph_day_pages_complete;
DROP TRIGGER analytics_graph_day_values_terminal_insert;
ALTER TABLE analytics_graph_day_values RENAME TO analytics_graph_day_values_0028;

CREATE TABLE analytics_graph_day_values (
  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('json-v11','typed-v11','effective')),
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
  quota_rows_read INTEGER,
  effective_owner_revision INTEGER,
  CHECK((source_layout='json-v11' AND source_namespace='') OR
    (source_layout IN ('typed-v11','effective') AND length(source_namespace)>0)),
  CHECK((source_layout='effective' AND device_id='effective-owner' AND manifest_id='effective-owner-day'
    AND quota_rows_read IS NOT NULL AND quota_rows_read BETWEEN 0 AND 9007199254740991
    AND effective_owner_revision IS NOT NULL AND effective_owner_revision BETWEEN 1 AND 9007199254740991)
    OR (source_layout!='effective' AND quota_rows_read IS NULL AND effective_owner_revision IS NULL)),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,acquisition_version),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
INSERT INTO analytics_graph_day_values
  (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
    day,acquisition_version,record_count,part_count,values_digest)
  SELECT value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
    day,acquisition_version,record_count,part_count,values_digest FROM analytics_graph_day_values_0028;
DROP TABLE analytics_graph_day_values_0028;
CREATE INDEX analytics_graph_day_owner
  ON analytics_graph_day_values(source_id,owner_digest,day,acquisition_version);
CREATE INDEX analytics_graph_day_retirement
  ON analytics_graph_day_values(source_id,acquisition_version,owner_digest,day);

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
CREATE TRIGGER analytics_graph_day_pages_complete BEFORE INSERT ON analytics_graph_day_values
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM analytics_graph_day_pages WHERE value_key=NEW.value_key)!=NEW.part_count
    OR COALESCE((SELECT SUM(entry_count) FROM analytics_graph_day_pages WHERE value_key=NEW.value_key),0)!=NEW.record_count
    OR EXISTS(SELECT 1 FROM analytics_graph_day_pages p WHERE p.value_key=NEW.value_key
      AND (p.source_id!=NEW.source_id OR p.owner_digest!=NEW.owner_digest OR p.day!=NEW.day
        OR p.acquisition_version!=NEW.acquisition_version OR p.part_index>=NEW.part_count))
    THEN RAISE(ABORT,'analytics_graph_day_pages_incomplete') END;
END;
CREATE TRIGGER analytics_graph_day_values_terminal_insert BEFORE INSERT ON analytics_graph_day_values
WHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
 WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)
BEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END;

-- Created last: this marker is absent for every incomplete upgrade. The
-- table CHECK is authoritative too; the trigger makes the runtime capability
-- name enforce the effective metadata contract rather than being an empty flag.
CREATE TRIGGER analytics_graph_day_effective_quota_contract BEFORE INSERT ON analytics_graph_day_values
WHEN NEW.source_layout='effective' AND (NEW.device_id!='effective-owner'
 OR NEW.manifest_id!='effective-owner-day' OR NEW.quota_rows_read IS NULL
 OR NEW.quota_rows_read<0 OR NEW.quota_rows_read>9007199254740991
 OR NEW.effective_owner_revision IS NULL OR NEW.effective_owner_revision<1
 OR NEW.effective_owner_revision>9007199254740991)
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_effective_quota_invalid'); END;
