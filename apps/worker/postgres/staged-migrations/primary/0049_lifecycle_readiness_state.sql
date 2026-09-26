-- PostgreSQL primary migration 0049 (staged): lifecycle readiness state in the
-- Worker vocabulary.
--
-- /api/ready, /api/health, the admin overview and scheduled maintenance read
-- two singleton rows. The D1 contract is:
--
--   * migrations/0010_retention_lifecycle.sql: retention_state with the
--     never_run/running/completed/failed vocabulary, a fixed schema_version,
--     non-negative counters, LIFECYCLE_PASS_FAILED as the only failure code,
--     and a never_run seed whose two completion flags are true;
--   * migrations/0013_quarantine_reconciliation.sql: retention_state
--     maintenance_run_at and the quarantine_reconciliation_state singleton;
--   * migrations/0020_admin_operation_leases.sql: the maintenance lease token
--     and expiry, which PostgreSQL 0007 already names lease_id and
--     lease_expires_at.
--
-- PostgreSQL 0007 used idle/running/completed with false flag defaults and
-- had neither the maintenance-cycle marker nor the reconciliation singleton.
--
-- Forward-only and fail-closed: every added constraint validates the existing
-- row, so a row that already breaks the Worker contract aborts this migration
-- instead of being rewritten. Only the 'idle' state is converted.

-- (1) Drop the 0007 idle/running/completed vocabulary.
ALTER TABLE retention_state
  DROP CONSTRAINT retention_state_state_check;

-- (2) D1 seed parity (0010:38-54): the never-run lifecycle has nothing left to
-- retain or replay, so both completion flags are true. A row that has already
-- run keeps its recorded flags.
UPDATE retention_state
   SET state = 'never_run',
       quarantine_retention_complete = true,
       restore_replay_complete = true
 WHERE state = 'idle';

ALTER TABLE retention_state
  -- (3) The Worker vocabulary.
  ADD CONSTRAINT retention_state_state_check
    CHECK (state IN ('never_run', 'running', 'completed', 'failed')),
  ALTER COLUMN state SET DEFAULT 'never_run',
  -- (4) Flag defaults follow the D1 seed.
  ALTER COLUMN quarantine_retention_complete SET DEFAULT true,
  ALTER COLUMN restore_replay_complete SET DEFAULT true,
  -- (5) A fixed contract version, as D1 0010:19-20.
  ADD COLUMN schema_version text NOT NULL DEFAULT 'backend-retention-v0.1'
    CONSTRAINT retention_state_schema_version_check
      CHECK (schema_version = 'backend-retention-v0.1'),
  -- (6) The maintenance-cycle marker shared with the reconciliation row, and
  -- the quarantine cutoff of the last completed pass. Readiness compares the
  -- two markers as canonical ISO millisecond strings (Worker handleReady), so
  -- a marker holds whole milliseconds: rendering it is then lossless and two
  -- different cycles can never render as the same instant. Writers stamp
  -- ISO(scheduledTime); a sub-millisecond SQL clock value is refused.
  ADD COLUMN maintenance_run_at timestamptz
    CONSTRAINT retention_state_maintenance_run_at_ms_check
      CHECK (maintenance_run_at = date_trunc('milliseconds', maintenance_run_at, 'UTC')),
  ADD COLUMN quarantine_cutoff_at timestamptz,
  -- (7) The only lifecycle failure code.
  ADD CONSTRAINT retention_state_failure_code_check
    CHECK (failure_code IS NULL OR failure_code = 'LIFECYCLE_PASS_FAILED'),
  -- (8) A failed pass clears its cycle marker (Worker retention.ts), so a
  -- failed lifecycle can never match a reconciliation cycle.
  ADD CONSTRAINT retention_state_failed_cycle_check
    CHECK (state <> 'failed' OR maintenance_run_at IS NULL),
  -- (9) lease_id and lease_expires_at are the maintenance lease token and
  -- expiry; they are set and cleared together.
  ADD CONSTRAINT retention_state_lease_pair_check
    CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  -- (10) Non-negative counters.
  ADD CONSTRAINT retention_state_quarantine_objects_deleted_check
    CHECK (quarantine_objects_deleted >= 0),
  ADD CONSTRAINT retention_state_restored_participants_suppressed_check
    CHECK (restored_participants_suppressed >= 0);
-- A completed row may have a NULL last_completed_at: readiness reports it as
-- stale rather than refusing the row.

-- The reconciliation singleton (D1 0013:78-135). D1's cursor columns are
-- omitted because the PostgreSQL reconciler claims pending_objects rows
-- instead of walking a cursor. lease_id is present exactly while running.
-- Constraint names are explicit because a generated name for
-- referenced_objects_preserved would exceed 63 bytes and be truncated.
CREATE TABLE quarantine_reconciliation_state (
  singleton integer
    CONSTRAINT quarantine_reconciliation_state_pkey PRIMARY KEY
    CONSTRAINT quarantine_reconciliation_state_singleton_check CHECK (singleton = 1),
  schema_version text NOT NULL
    CONSTRAINT quarantine_reconciliation_state_schema_version_check
      CHECK (schema_version = 'quarantine-reconciliation-v0.1'),
  state text NOT NULL DEFAULT 'never_run'
    CONSTRAINT quarantine_reconciliation_state_state_check
      CHECK (state IN ('never_run', 'running', 'completed', 'failed')),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  -- The cycle marker holds whole milliseconds, as retention_state's does.
  maintenance_run_at timestamptz
    CONSTRAINT quarantine_reconciliation_state_maintenance_run_at_ms_check
      CHECK (maintenance_run_at = date_trunc('milliseconds', maintenance_run_at, 'UTC')),
  cutoff_at timestamptz,
  lease_id text,
  registrations_examined bigint NOT NULL DEFAULT 0
    CONSTRAINT quarantine_reconciliation_state_registrations_check
      CHECK (registrations_examined >= 0),
  orphan_objects_deleted bigint NOT NULL DEFAULT 0
    CONSTRAINT quarantine_reconciliation_state_orphans_check
      CHECK (orphan_objects_deleted >= 0),
  referenced_objects_preserved bigint NOT NULL DEFAULT 0
    CONSTRAINT quarantine_reconciliation_state_preserved_check
      CHECK (referenced_objects_preserved >= 0),
  reconciliation_complete boolean NOT NULL DEFAULT false,
  failure_code text
    CONSTRAINT quarantine_reconciliation_state_failure_code_check
      CHECK (failure_code IS NULL OR failure_code = 'QUARANTINE_RECONCILIATION_FAILED'),
  CONSTRAINT quarantine_reconciliation_state_lease_check
    CHECK ((state = 'running') = (lease_id IS NOT NULL))
);

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
  false
) ON CONFLICT (singleton) DO NOTHING;
