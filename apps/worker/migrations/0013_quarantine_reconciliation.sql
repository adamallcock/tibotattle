PRAGMA foreign_keys = ON;

ALTER TABLE retention_state
  ADD COLUMN maintenance_run_at TEXT;

CREATE TABLE pending_quarantine_objects (
  r2_key TEXT PRIMARY KEY NOT NULL,
  contribution_id TEXT NOT NULL UNIQUE,
  object_kind TEXT NOT NULL
    CHECK (object_kind IN ('synthetic', 'telemetry')),
  registered_at TEXT NOT NULL,
  reconciliation_state TEXT NOT NULL DEFAULT 'registered'
    CHECK (reconciliation_state IN ('registered', 'deleting')),
  reconciliation_lease_id TEXT,
  CHECK (
    (object_kind = 'synthetic' AND r2_key GLOB 'synthetic/*')
    OR
    (object_kind = 'telemetry' AND r2_key GLOB 'telemetry/*')
  ),
  CHECK (
    (reconciliation_state = 'registered'
      AND reconciliation_lease_id IS NULL)
    OR
    (reconciliation_state = 'deleting'
      AND reconciliation_lease_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX pending_quarantine_objects_due
  ON pending_quarantine_objects(registered_at, r2_key);

CREATE TRIGGER contributions_block_reconciling_quarantine
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND reconciliation_state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine reconciliation in progress');
END;

CREATE TRIGGER contributions_clear_pending_quarantine
AFTER INSERT ON contributions
FOR EACH ROW
BEGIN
  DELETE FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND contribution_id = NEW.id
     AND reconciliation_state = 'registered';
END;

CREATE TRIGGER telemetry_contributions_block_reconciling_quarantine
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND reconciliation_state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine reconciliation in progress');
END;

CREATE TRIGGER telemetry_contributions_clear_pending_quarantine
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
BEGIN
  DELETE FROM pending_quarantine_objects
   WHERE r2_key = NEW.r2_key
     AND contribution_id = NEW.id
     AND reconciliation_state = 'registered';
END;

CREATE TABLE quarantine_reconciliation_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'quarantine-reconciliation-v0.1'),
  state TEXT NOT NULL DEFAULT 'never_run'
    CHECK (state IN ('never_run', 'running', 'completed', 'failed')),
  last_started_at TEXT,
  last_completed_at TEXT,
  maintenance_run_at TEXT,
  cutoff_at TEXT,
  cursor_registered_at TEXT,
  cursor_r2_key TEXT,
  lease_id TEXT,
  registrations_examined INTEGER NOT NULL DEFAULT 0
    CHECK (registrations_examined >= 0),
  orphan_objects_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (orphan_objects_deleted >= 0),
  referenced_objects_preserved INTEGER NOT NULL DEFAULT 0
    CHECK (referenced_objects_preserved >= 0),
  reconciliation_complete INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_complete IN (0, 1)),
  failure_code TEXT CHECK (
    failure_code IS NULL
    OR failure_code = 'QUARANTINE_RECONCILIATION_FAILED'
  ),
  CHECK (
    (cursor_registered_at IS NULL AND cursor_r2_key IS NULL)
    OR
    (cursor_registered_at IS NOT NULL AND cursor_r2_key IS NOT NULL)
  ),
  CHECK (
    (state = 'running' AND lease_id IS NOT NULL)
    OR
    (state != 'running' AND lease_id IS NULL)
  ),
  CHECK (
    reconciliation_complete = 0
    OR (cursor_registered_at IS NULL AND cursor_r2_key IS NULL)
  )
) STRICT;

INSERT INTO quarantine_reconciliation_state (
  singleton,
  schema_version,
  state,
  registrations_examined,
  orphan_objects_deleted,
  referenced_objects_preserved,
  reconciliation_complete
) VALUES (
  1,
  'quarantine-reconciliation-v0.1',
  'never_run',
  0,
  0,
  0,
  0
);
