-- Existing independent terminal fences must also purge restored derived data.
-- UPDATE replay works without requiring another active-owner transition.

CREATE TRIGGER analytics_shared_preparation_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_shared_preparation_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 UPDATE analytics_shared_preparation_cursor SET
  after_recent_owner=CASE WHEN after_recent_owner=NEW.owner_digest THEN '' ELSE after_recent_owner END,
  after_dirty_owner=CASE WHEN after_dirty_owner=NEW.owner_digest THEN '' ELSE after_dirty_owner END,
  after_history_owner=CASE WHEN after_history_owner=NEW.owner_digest THEN '' ELSE after_history_owner END,
  revision=revision+1,claim_token=NULL,claim_expires_ms=NULL
 WHERE source_id=NEW.source_id AND NEW.owner_digest IN(after_recent_owner,after_dirty_owner,after_history_owner);
END;

CREATE TRIGGER analytics_canonical_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_pages WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_facts WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_canonical_input_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_input_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_partition_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_partition_work WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_ranges WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_partition_subject_schedule WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_partition_subject_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_partition_work WHERE work_key IN(SELECT work_key FROM analytics_partition_work_subjects
 WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest); UPDATE analytics_partition_global_changes SET after_owner_digest='',version=version+1
 WHERE source_id=NEW.source_id AND after_owner_digest=NEW.owner_digest;
END;

CREATE TRIGGER analytics_canonical_rolling_erasure_replay AFTER UPDATE ON analytics_storage_erasure_fences
BEGIN
 DELETE FROM analytics_canonical_rolling_windows WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
 DELETE FROM analytics_canonical_rolling_segments WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest;
END;

-- Empty-string subjects are anonymous global fairness counters.
CREATE TRIGGER analytics_partition_subject_schedule_admit BEFORE INSERT ON analytics_partition_subject_schedule
WHEN NEW.owner_digest!='' AND NOT EXISTS(SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_partition_subject_ineligible'); END;
CREATE TRIGGER analytics_partition_subject_schedule_update BEFORE UPDATE ON analytics_partition_subject_schedule
WHEN NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest
 OR NEW.owner_digest!='' AND NOT EXISTS(SELECT 1 FROM analytics_owner_state o
 WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
BEGIN SELECT RAISE(ABORT,'analytics_partition_subject_ineligible'); END;
DELETE FROM analytics_partition_subject_schedule WHERE owner_digest!='' AND NOT EXISTS(
 SELECT 1 FROM analytics_owner_state o WHERE o.source_id=analytics_partition_subject_schedule.source_id
 AND o.owner_digest=analytics_partition_subject_schedule.owner_digest AND o.state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest));
CREATE TRIGGER analytics_canonical_effect_cursor_remove BEFORE DELETE ON analytics_canonical_effects
BEGIN UPDATE analytics_partition_reconciliation SET after_effect_key='',complete=0
 WHERE source_id=(SELECT source_id FROM analytics_canonical_pages WHERE change_key=OLD.change_key)
 AND after_effect_key=OLD.effect_key; END;
CREATE TRIGGER analytics_shared_preparation_owner_delete BEFORE DELETE ON analytics_owner_state
BEGIN
 DELETE FROM analytics_shared_preparation_ranges WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest;
 UPDATE analytics_shared_preparation_cursor SET
 after_recent_owner=CASE WHEN after_recent_owner=OLD.owner_digest THEN '' ELSE after_recent_owner END,
 after_dirty_owner=CASE WHEN after_dirty_owner=OLD.owner_digest THEN '' ELSE after_dirty_owner END,
 after_history_owner=CASE WHEN after_history_owner=OLD.owner_digest THEN '' ELSE after_history_owner END,
 revision=revision+1,claim_token=NULL,claim_expires_ms=NULL
 WHERE source_id=OLD.source_id AND OLD.owner_digest IN(after_recent_owner,after_dirty_owner,after_history_owner);
END;

-- The parent row is no longer visible to a child FK-cascade trigger.
CREATE TRIGGER analytics_canonical_page_cursor_remove BEFORE DELETE ON analytics_canonical_pages
BEGIN UPDATE analytics_partition_reconciliation SET after_effect_key='',complete=0
 WHERE source_id=OLD.source_id AND after_effect_key IN(
 SELECT effect_key FROM analytics_canonical_effects WHERE change_key=OLD.change_key); END;

-- Clock-admitted publication leaves must retain subjects independently of
-- ancestor queue rows, which may later be retired.
DROP TRIGGER analytics_partition_manifest_admit;
DROP TRIGGER analytics_partition_manifest_subjects;
CREATE TRIGGER analytics_partition_manifest_admit BEFORE INSERT ON analytics_partition_work
WHEN NEW.stage IN('activity','cache','publication') AND (NEW.partition_key LIKE 'effective-union-v1/%' OR NEW.partition_key LIKE 'legacy-selected-v1/%')
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
  WHERE h.partition_key=NEW.partition_key AND h.content_revision=NEW.input_revision AND m.state='complete'
  AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0))
BEGIN SELECT RAISE(ABORT,'analytics_partition_manifest_changed'); END;
CREATE TRIGGER analytics_partition_manifest_subjects AFTER INSERT ON analytics_partition_work
WHEN NEW.stage IN('activity','cache','publication') AND (NEW.partition_key LIKE 'effective-union-v1/%' OR NEW.partition_key LIKE 'legacy-selected-v1/%')
BEGIN
 INSERT INTO analytics_partition_work_subjects(work_key,source_id,owner_digest)
 SELECT DISTINCT NEW.work_key,f.source_id,f.owner_digest FROM analytics_canonical_manifest_rows r
 JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=NEW.input_revision;
END;
