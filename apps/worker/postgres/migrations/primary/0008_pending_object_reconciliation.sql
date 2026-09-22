-- Extend the canonical ingest journal with the bounded reconciliation state
-- used by retention. Existing rows remain registered and retain their object
-- identity; no second quarantine-intent table is introduced.
ALTER TABLE pending_objects
  ADD COLUMN object_kind text NOT NULL DEFAULT 'telemetry_v1'
    CHECK (object_kind IN ('synthetic', 'telemetry', 'telemetry_v1', 'telemetry_v11', 'telemetry_v12')),
  ADD COLUMN registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN reconciliation_state text NOT NULL DEFAULT 'registered'
    CHECK (reconciliation_state IN ('registered', 'deleting')),
  ADD COLUMN reconciliation_lease_id text;

CREATE INDEX pending_objects_reconciliation
  ON pending_objects(reconciliation_state, registered_at, contribution_id);
