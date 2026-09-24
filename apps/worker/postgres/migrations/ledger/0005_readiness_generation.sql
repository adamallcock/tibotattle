-- Independent-ledger mutation generation used by the primary restore fence.
-- A readiness request may inspect one bounded page and remember this value;
-- any later tombstone/job mutation invalidates that page without requiring a
-- cross-database transaction.
CREATE TABLE storage_erasure_ledger_generation (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  generation bigint NOT NULL CHECK (generation >= 0)
);

INSERT INTO storage_erasure_ledger_generation(singleton, generation)
VALUES (1, 0);

CREATE OR REPLACE FUNCTION bump_storage_erasure_ledger_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  UPDATE storage_erasure_ledger_generation
     SET generation = generation + 1
   WHERE singleton = 1;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER storage_erasure_jobs_readiness_generation
AFTER INSERT OR UPDATE OR DELETE ON storage_erasure_jobs
FOR EACH ROW EXECUTE FUNCTION bump_storage_erasure_ledger_generation();

CREATE TRIGGER deletion_tombstones_readiness_generation
AFTER INSERT OR UPDATE OR DELETE ON deletion_tombstones
FOR EACH ROW EXECUTE FUNCTION bump_storage_erasure_ledger_generation();
