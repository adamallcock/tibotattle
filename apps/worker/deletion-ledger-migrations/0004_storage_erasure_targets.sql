-- One durable completion row per source/analytics target. The existing source
-- job retains the source-proven terminal recipe; this table proves that every
-- declared derived target completed it before owner erasure can be acknowledged.
CREATE TABLE storage_erasure_targets (
 participant_digest TEXT NOT NULL,
 source_id TEXT NOT NULL,
 owner_digest TEXT NOT NULL,
 target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
 source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
 state TEXT NOT NULL CHECK(state IN ('pending','complete')),
 completed_at TEXT,
 PRIMARY KEY(participant_digest,source_id,owner_digest,target_id),
 FOREIGN KEY(participant_digest,source_id,owner_digest)
  REFERENCES storage_erasure_jobs(participant_digest,source_id,owner_digest) ON DELETE CASCADE,
 CHECK((state='pending' AND completed_at IS NULL) OR (state='complete' AND completed_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX storage_erasure_targets_pending
 ON storage_erasure_targets(state,target_id,source_id,participant_digest,owner_digest);

CREATE TRIGGER storage_erasure_target_scope BEFORE UPDATE ON storage_erasure_targets
WHEN OLD.participant_digest IS NOT NEW.participant_digest OR OLD.source_id IS NOT NEW.source_id
 OR OLD.owner_digest IS NOT NEW.owner_digest OR OLD.target_id IS NOT NEW.target_id
 OR OLD.source_namespace IS NOT NEW.source_namespace
BEGIN SELECT RAISE(ABORT,'storage_erasure_target_conflict'); END;

DROP TRIGGER storage_erasure_tombstone_retained;
CREATE TRIGGER storage_erasure_tombstone_retained BEFORE DELETE ON deletion_tombstones
WHEN EXISTS(SELECT 1 FROM storage_erasure_jobs WHERE participant_digest=OLD.participant_digest AND state='pending')
 OR EXISTS(SELECT 1 FROM storage_erasure_targets WHERE participant_digest=OLD.participant_digest AND state='pending')
BEGIN SELECT RAISE(ABORT,'storage_erasure_pending'); END;
