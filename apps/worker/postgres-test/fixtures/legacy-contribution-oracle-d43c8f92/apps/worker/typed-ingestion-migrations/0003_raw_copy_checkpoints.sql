-- Raw-copy checkpoints do not certify authority, a consistent snapshot, or a
-- production cutover. The operation owning the source write fence owns those.
CREATE TABLE storage_raw_copy_runs (
  run_id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  source_snapshot_digest TEXT NOT NULL CHECK(length(source_snapshot_digest)=64),
  format TEXT NOT NULL CHECK(format IN ('v1','v11')),
  last_source_row_id INTEGER NOT NULL DEFAULT 0 CHECK(last_source_row_id>=0),
  copied_rows INTEGER NOT NULL DEFAULT 0 CHECK(copied_rows>=0),
  UNIQUE(source_namespace, format, source_snapshot_digest)
) STRICT;
CREATE TABLE storage_raw_copy_pages (
  run_id TEXT NOT NULL REFERENCES storage_raw_copy_runs(run_id),
  after_source_row_id INTEGER NOT NULL CHECK(after_source_row_id>=0),
  through_source_row_id INTEGER NOT NULL CHECK(through_source_row_id>after_source_row_id),
  record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 32),
  batch_digest TEXT NOT NULL CHECK(length(batch_digest)=64),
  PRIMARY KEY(run_id, after_source_row_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER storage_raw_copy_page_guard BEFORE INSERT ON storage_raw_copy_pages
WHEN NOT EXISTS(SELECT 1 FROM storage_raw_copy_runs r WHERE r.run_id=NEW.run_id
  AND r.last_source_row_id=NEW.after_source_row_id)
BEGIN SELECT RAISE(ABORT,'storage_copy_cursor_conflict'); END;
CREATE TRIGGER storage_raw_copy_page_commit AFTER INSERT ON storage_raw_copy_pages
BEGIN UPDATE storage_raw_copy_runs SET last_source_row_id=NEW.through_source_row_id,
  copied_rows=copied_rows+NEW.record_count WHERE run_id=NEW.run_id; END;
CREATE TRIGGER storage_raw_copy_run_identity BEFORE UPDATE ON storage_raw_copy_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.source_namespace IS NOT OLD.source_namespace
  OR NEW.source_snapshot_digest IS NOT OLD.source_snapshot_digest OR NEW.format IS NOT OLD.format
BEGIN SELECT RAISE(ABORT,'storage_copy_identity_conflict'); END;
CREATE TRIGGER storage_raw_copy_page_immutable BEFORE UPDATE ON storage_raw_copy_pages
BEGIN SELECT RAISE(ABORT,'storage_copy_identity_conflict'); END;
