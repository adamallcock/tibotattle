PRAGMA foreign_keys = ON;

-- A single scheduled maintenance pass owns the lifecycle, reconciliation, and
-- aggregate rebuild sequence at a time. The expiry is an availability escape
-- hatch after a worker crash; normal completion clears the token immediately.
ALTER TABLE retention_state
  ADD COLUMN maintenance_lease_token TEXT;

ALTER TABLE retention_state
  ADD COLUMN maintenance_lease_expires_at TEXT;

CREATE INDEX retention_state_maintenance_lease
  ON retention_state(maintenance_lease_expires_at);
