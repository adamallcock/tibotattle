PRAGMA foreign_keys = ON;

-- These tables deliberately contain operational metadata only. A request ID
-- is the diagnostic reference returned to the caller; it is not a participant
-- identifier and is never joined to contribution or record contents.
CREATE TABLE diagnostic_error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL
    CHECK (length(request_id) = 36),
  route_class TEXT NOT NULL
    CHECK (length(route_class) BETWEEN 1 AND 80),
  error_code TEXT NOT NULL
    CHECK (length(error_code) BETWEEN 1 AND 80),
  status INTEGER NOT NULL CHECK (status BETWEEN 400 AND 599),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX diagnostic_error_events_recent
  ON diagnostic_error_events(occurred_at DESC, id DESC);

CREATE INDEX diagnostic_error_events_request
  ON diagnostic_error_events(request_id, occurred_at DESC);

CREATE TABLE admin_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT UNIQUE
    CHECK (operation_id IS NULL OR length(operation_id) = 36),
  action TEXT NOT NULL CHECK (
    action IN ('set_collection_controls', 'run_maintenance')
  ),
  actor_identity_digest TEXT NOT NULL
    CHECK (length(actor_identity_digest) = 64
      AND actor_identity_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'success', 'failure')),
  details_json TEXT NOT NULL CHECK (length(details_json) <= 2000),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX admin_action_audit_recent
  ON admin_action_audit(created_at DESC, id DESC);
