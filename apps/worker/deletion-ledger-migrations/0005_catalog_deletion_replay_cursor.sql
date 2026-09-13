-- A bounded catalog replay walks retained deletion digests over successive
-- lifecycle leases. This cursor contains no participant identity or route.
CREATE TABLE storage_catalog_deletion_replay_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  after_participant_digest TEXT NOT NULL CHECK (
    after_participant_digest = '' OR (
      length(after_participant_digest) = 64
      AND after_participant_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  cycle_incomplete INTEGER NOT NULL CHECK (cycle_incomplete IN (0, 1)),
  verification_required INTEGER NOT NULL CHECK (verification_required IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO storage_catalog_deletion_replay_state (
  singleton_id, after_participant_digest, cycle_incomplete,
  verification_required, updated_at
) VALUES (1, '', 0, 0, 0);

-- Exact deletion authority for catalog replay attempts that have not yet
-- proved every route-history source and derived target complete. A revisioned
-- attempt token prevents one invocation clearing a concurrently refreshed row.
CREATE TABLE storage_catalog_deletion_replay_pending (
  participant_digest TEXT PRIMARY KEY NOT NULL
    REFERENCES deletion_tombstones(participant_digest) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  attempted_ms INTEGER NOT NULL CHECK (attempted_ms >= 0),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  attempt_token TEXT NOT NULL CHECK (length(attempt_token) = 36)
) STRICT, WITHOUT ROWID;

CREATE INDEX storage_catalog_deletion_replay_attempts
  ON storage_catalog_deletion_replay_pending(attempted_ms, participant_digest);

CREATE TRIGGER storage_catalog_deletion_replay_pending_transition
BEFORE UPDATE ON storage_catalog_deletion_replay_pending
WHEN NEW.participant_digest <> OLD.participant_digest
 OR NEW.created_at <> OLD.created_at
 OR NEW.attempted_ms < OLD.attempted_ms
 OR NEW.revision <> OLD.revision + 1
 OR NEW.attempt_token = OLD.attempt_token
BEGIN SELECT RAISE(ABORT,'storage_catalog_deletion_replay_conflict'); END;

DROP TRIGGER storage_erasure_tombstone_retained;
CREATE TRIGGER storage_erasure_tombstone_retained BEFORE DELETE ON deletion_tombstones
WHEN EXISTS(SELECT 1 FROM storage_erasure_jobs WHERE participant_digest=OLD.participant_digest AND state='pending')
 OR EXISTS(SELECT 1 FROM storage_erasure_targets WHERE participant_digest=OLD.participant_digest AND state='pending')
 OR EXISTS(SELECT 1 FROM storage_catalog_deletion_replay_pending WHERE participant_digest=OLD.participant_digest)
BEGIN SELECT RAISE(ABORT,'storage_erasure_pending'); END;
