PRAGMA foreign_keys = ON;

ALTER TABLE contributions
  ADD COLUMN quarantine_deleted_at TEXT;

ALTER TABLE telemetry_contributions
  ADD COLUMN quarantine_deleted_at TEXT;

CREATE INDEX contributions_quarantine_retention
  ON contributions(created_at, id)
  WHERE quarantine_deleted_at IS NULL;

CREATE INDEX telemetry_contributions_quarantine_retention
  ON telemetry_contributions(created_at, id)
  WHERE quarantine_deleted_at IS NULL;

CREATE TABLE retention_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'backend-retention-v0.1'),
  state TEXT NOT NULL DEFAULT 'never_run'
    CHECK (state IN ('never_run', 'running', 'completed', 'failed')),
  last_started_at TEXT,
  last_completed_at TEXT,
  quarantine_cutoff_at TEXT,
  quarantine_objects_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (quarantine_objects_deleted >= 0),
  quarantine_retention_complete INTEGER NOT NULL DEFAULT 1
    CHECK (quarantine_retention_complete IN (0, 1)),
  restored_participants_suppressed INTEGER NOT NULL DEFAULT 0
    CHECK (restored_participants_suppressed >= 0),
  restore_replay_complete INTEGER NOT NULL DEFAULT 1
    CHECK (restore_replay_complete IN (0, 1)),
  failure_code TEXT
    CHECK (failure_code IS NULL OR failure_code = 'LIFECYCLE_PASS_FAILED')
) STRICT;

INSERT INTO retention_state (
  singleton,
  schema_version,
  state,
  quarantine_objects_deleted,
  quarantine_retention_complete,
  restored_participants_suppressed,
  restore_replay_complete
) VALUES (
  1,
  'backend-retention-v0.1',
  'never_run',
  0,
  1,
  0,
  1
);
