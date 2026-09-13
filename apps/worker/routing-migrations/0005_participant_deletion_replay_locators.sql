-- Server-only restore/replay locator. The key uses the independent deletion
-- tombstone domain; neither the raw participant id nor an authentication grant
-- enters the catalog. Rows are retained for the life of their owner route.
CREATE TABLE storage_participant_deletion_replay_locators (
  participant_digest TEXT PRIMARY KEY NOT NULL
    CHECK (length(participant_digest) = 64
      AND participant_digest NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES storage_owner_routes(owner_id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (owner_id)
) STRICT;

CREATE TRIGGER storage_participant_deletion_replay_locator_immutable
BEFORE UPDATE ON storage_participant_deletion_replay_locators BEGIN
  SELECT RAISE(ABORT, 'STORAGE_PARTICIPANT_DELETION_LOCATOR_IMMUTABLE');
END;

CREATE TRIGGER storage_participant_deletion_replay_locator_no_delete
BEFORE DELETE ON storage_participant_deletion_replay_locators BEGIN
  SELECT RAISE(ABORT, 'STORAGE_PARTICIPANT_DELETION_LOCATOR_HISTORY_REQUIRED');
END;
