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
