-- A v1.2 chunk may only become durable while its exact quarantine object
-- registration is still eligible for reconciliation. This fences a writer
-- that loses the race to an orphan cleanup claim: after a reconciler changes
-- the registration to `deleting`, the object may be removed and the chunk
-- must not be admitted against it.
CREATE TRIGGER telemetry_v12_chunk_quarantine_admission
BEFORE INSERT ON telemetry_v12_chunks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM pending_quarantine_objects pending
   WHERE pending.contribution_id = NEW.id
     AND pending.r2_key = NEW.r2_key
     AND pending.object_kind = 'telemetry'
     AND pending.reconciliation_state = 'registered'
)
BEGIN
  SELECT RAISE(ABORT, 'telemetry_v12_chunk_staging_denied');
END;
