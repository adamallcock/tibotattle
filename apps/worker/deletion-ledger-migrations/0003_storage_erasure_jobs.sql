-- Independent, digest-only retry recipe. It survives deletion/restoration of the
-- ingestion database and expires with the existing completed deletion tombstone.
CREATE TABLE storage_erasure_jobs (
 participant_digest TEXT NOT NULL REFERENCES deletion_tombstones(participant_digest) ON DELETE CASCADE,
 source_id TEXT NOT NULL,owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),
 source_namespace TEXT NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 256),
 state TEXT NOT NULL CHECK(state IN ('pending','complete')),
 terminal_json TEXT CHECK(terminal_json IS NULL OR json_valid(terminal_json)),
 completed_at TEXT,attempted_ms INTEGER NOT NULL DEFAULT 0 CHECK(attempted_ms>=0),
 PRIMARY KEY(participant_digest,source_id,owner_digest),
 CHECK((state='pending' AND completed_at IS NULL) OR (state='complete' AND completed_at IS NOT NULL AND terminal_json IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX storage_erasure_pending ON storage_erasure_jobs(source_id,state,attempted_ms,participant_digest,owner_digest);
CREATE TRIGGER storage_erasure_job_scope BEFORE UPDATE ON storage_erasure_jobs
WHEN OLD.participant_digest IS NOT NEW.participant_digest OR OLD.source_id IS NOT NEW.source_id
 OR OLD.owner_digest IS NOT NEW.owner_digest OR OLD.source_namespace IS NOT NEW.source_namespace
 OR (OLD.terminal_json IS NOT NULL AND OLD.terminal_json IS NOT NEW.terminal_json)
BEGIN SELECT RAISE(ABORT,'storage_erasure_job_conflict'); END;
CREATE TRIGGER storage_erasure_tombstone_retained BEFORE DELETE ON deletion_tombstones
WHEN EXISTS(SELECT 1 FROM storage_erasure_jobs WHERE participant_digest=OLD.participant_digest AND state='pending')
BEGIN SELECT RAISE(ABORT,'storage_erasure_pending'); END;
