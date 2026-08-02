PRAGMA foreign_keys = ON;

-- A contribution's accepted record count is decided once, at ingest, and never
-- changes afterwards. It was nevertheless re-derived on every read with a
-- correlated `COUNT(*) FROM telemetry_records WHERE origin_contribution_id = c.id`,
-- and `telemetry_records` carried no index on that column, so each of those
-- counts was a full table scan. The personal dashboard runs one such count per
-- listed contribution, up to 100 of them, which made a single dashboard load
-- read roughly a hundred times the whole records table. Measured against a
-- 200,000-record fixture built from these migrations that query took 5.6
-- seconds, against D1's 30-second statement ceiling; the same defect made every
-- upload's two digest-replay lookups cost a scan each, and made the ingest
-- finalize UPDATE scan every usage row in the table four times over.
--
-- The count is now stored on the row that owns it. It is written by the ingest
-- path from the batch result it already has in hand, and it is deliberately
-- kept distinct from `declared_record_count`: a contribution that re-sends the
-- client's one-hour replay overlap declares records that were already stored,
-- and those are dropped by `INSERT OR IGNORE`. `declared - accepted` is exactly
-- that deduplicated remainder and is reported to the participant, so the two
-- columns must not be conflated.
--
-- The column is nullable on purpose. NULL means "ingest wrote the records but
-- had not yet written this row's accounting", which is the only state a
-- half-finished ingest can leave behind; it is repaired from the records
-- themselves the next time the contribution is looked up.
--
-- The index on `origin_contribution_id` is added for the paths that still have
-- to reach records from a contribution — the backfill below, the repair of an
-- unfinished ingest, and any future join — so that none of them can reintroduce
-- a table scan. It is not, on its own, the fix: an indexed count still reads one
-- row per record, and it is the read-time counting that had to stop.

CREATE INDEX telemetry_records_origin_contribution
  ON telemetry_records(origin_contribution_id);

ALTER TABLE telemetry_contributions ADD COLUMN accepted_record_count INTEGER;

-- Backfill every existing contribution with exactly the number the removed
-- subquery would have returned, so no participant's reported record counts move.
UPDATE telemetry_contributions
   SET accepted_record_count = (
     SELECT COUNT(*)
       FROM telemetry_records r
      WHERE r.origin_contribution_id = telemetry_contributions.id
   );
