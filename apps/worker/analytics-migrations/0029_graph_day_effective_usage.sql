-- Reuse the immutable graph-day framing for effective model-usage summaries.
-- The distinct layout keeps old quota readers and cleanup workers from
-- treating a usage-only value as a quota day. Existing keys, metadata and page
-- bytes are preserved. Usage rows are counted inside the signed projection;
-- quota_rows_read stays NULL and owner revision only fences retirement.
-- Drop all triggers that name the rebuilt table, then restore every guard.
-- The usage contract is created last so partial upgrades remain unavailable.
DROP TRIGGER analytics_graph_day_values_immutable;
DROP TRIGGER analytics_graph_day_page_immutable;
DROP TRIGGER analytics_graph_day_page_retained;
DROP TRIGGER analytics_graph_day_pages_complete;
DROP TRIGGER analytics_graph_day_values_terminal_insert;
DROP TRIGGER analytics_graph_day_effective_quota_contract;
ALTER TABLE analytics_graph_day_values RENAME TO analytics_graph_day_values_0029;

CREATE TABLE analytics_graph_day_values (
  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64 AND value_key NOT GLOB '*[^0-9a-f]*'),
  source_id TEXT NOT NULL,
  source_layout TEXT NOT NULL CHECK(source_layout IN ('json-v11','typed-v11','effective','effective-usage')),
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
    (source_layout IN ('typed-v11','effective','effective-usage') AND length(source_namespace)>0)),
  CHECK((source_layout='effective' AND device_id='effective-owner' AND manifest_id='effective-owner-day'
    AND quota_rows_read IS NOT NULL AND quota_rows_read BETWEEN 0 AND 9007199254740991
    AND effective_owner_revision IS NOT NULL AND effective_owner_revision BETWEEN 1 AND 9007199254740991)
    OR (source_layout='effective-usage' AND device_id='effective-owner' AND length(manifest_id)=89 AND substr(manifest_id,1,25)='effective-owner-usage-v1:' AND substr(manifest_id,26) NOT GLOB '*[^0-9a-f]*'
    AND quota_rows_read IS NULL AND effective_owner_revision IS NOT NULL
    AND effective_owner_revision BETWEEN 1 AND 9007199254740991)
    OR (source_layout IN ('json-v11','typed-v11') AND quota_rows_read IS NULL AND effective_owner_revision IS NULL)),
  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,acquisition_version),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
INSERT INTO analytics_graph_day_values
  (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
    day,acquisition_version,record_count,part_count,values_digest,quota_rows_read,effective_owner_revision)
  SELECT value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
    day,acquisition_version,record_count,part_count,values_digest,quota_rows_read,effective_owner_revision FROM analytics_graph_day_values_0029;
DROP TABLE analytics_graph_day_values_0029;
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

-- Restore the existing quota capability before enabling the new usage layout.
CREATE TRIGGER analytics_graph_day_effective_quota_contract BEFORE INSERT ON analytics_graph_day_values
WHEN NEW.source_layout='effective' AND (NEW.device_id!='effective-owner'
 OR NEW.manifest_id!='effective-owner-day' OR NEW.quota_rows_read IS NULL
 OR NEW.quota_rows_read<0 OR NEW.quota_rows_read>9007199254740991
 OR NEW.effective_owner_revision IS NULL OR NEW.effective_owner_revision<1
 OR NEW.effective_owner_revision>9007199254740991)
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_effective_quota_invalid'); END;

CREATE TRIGGER analytics_graph_day_effective_usage_contract BEFORE INSERT ON analytics_graph_day_values
WHEN NEW.source_layout='effective-usage' AND (NEW.device_id!='effective-owner'
 OR length(NEW.manifest_id)!=89 OR substr(NEW.manifest_id,1,25)!='effective-owner-usage-v1:'
 OR substr(NEW.manifest_id,26) GLOB '*[^0-9a-f]*' OR NEW.quota_rows_read IS NOT NULL
 OR NEW.effective_owner_revision IS NULL OR NEW.effective_owner_revision<1
 OR NEW.effective_owner_revision>9007199254740991
 OR EXISTS(SELECT 1 FROM analytics_graph_day_pages p WHERE p.value_key=NEW.value_key
   AND p.component IN ('planAnchors','fitFragments','runEndpoints') AND p.entry_count>0))
BEGIN SELECT RAISE(ABORT,'analytics_graph_day_effective_usage_invalid'); END;
