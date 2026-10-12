-- PostgreSQL primary migration 0024: stable scheduler source cutoffs.
--
-- last_attempt_at_ms is retry timing and may change on every delivery attempt.
-- source_recorded_at_ms is the durable logical cutoff for the source event (or
-- the first legacy cursor creation time), so a retry after a UTC-day boundary
-- keeps the same work identity and window.

ALTER TABLE analytics_scheduler_delivery_cursors
  ADD COLUMN source_recorded_at_ms bigint NOT NULL DEFAULT 0
  CHECK (source_recorded_at_ms >= 0);

-- Preserve the closest available legacy cutoff for existing cursors. A cursor
-- with no prior attempt retains the zero sentinel and is initialized by the
-- scheduler when its first durable source event is discovered.
UPDATE analytics_scheduler_delivery_cursors
   SET source_recorded_at_ms = last_attempt_at_ms;
