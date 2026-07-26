CREATE TABLE deletion_tombstones (
  participant_digest TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(participant_digest) = 64
      AND participant_digest NOT GLOB '*[^0-9a-f]*'
    ),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'participant-deletion-tombstone-v0.1'),
  deleted_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  CHECK (retain_until > deleted_at)
) STRICT;

CREATE INDEX deletion_tombstones_retention
  ON deletion_tombstones(retain_until, participant_digest);
