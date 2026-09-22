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

-- The v1/v1.1/v1.2 writers register pending_objects before inserting their
-- chunk row. Retention claims the same row before deleting the object. Reject
-- a writer that races a committed deleting claim; otherwise its
-- ON CONFLICT(contribution_id) DO NOTHING would silently publish a chunk after
-- cleanup had established the deletion fence.
CREATE OR REPLACE FUNCTION reject_reconciliation_deleting_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  blocked boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.pending_objects WHERE contribution_id=$1 AND reconciliation_state=''deleting'')',
    TG_TABLE_SCHEMA
  ) INTO blocked USING NEW.id;
  IF blocked THEN
    RAISE EXCEPTION USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v1_chunks_reconciliation_guard
  BEFORE INSERT ON telemetry_v1_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_deleting_chunk();
CREATE TRIGGER telemetry_v11_chunks_reconciliation_guard
  BEFORE INSERT ON telemetry_v11_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_deleting_chunk();
CREATE TRIGGER telemetry_v12_chunks_reconciliation_guard
  BEFORE INSERT ON telemetry_v12_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_deleting_chunk();
