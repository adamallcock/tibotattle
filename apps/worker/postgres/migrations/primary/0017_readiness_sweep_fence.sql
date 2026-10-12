-- Extend the primary readiness checkpoint with an independent-ledger cursor.
-- The owner and ledger walks are both resumable; a request performs at most
-- one bounded page and a second Worker instance can continue the same row.
ALTER TABLE postgres_readiness_sweeps
  DROP CONSTRAINT postgres_readiness_sweeps_state_check;

ALTER TABLE postgres_readiness_sweeps
  ADD CONSTRAINT postgres_readiness_sweeps_state_check
    CHECK (state IN ('pending', 'ledger', 'complete'));

ALTER TABLE postgres_readiness_sweeps
  ADD COLUMN ledger_cursor_owner_digest text
    CHECK (ledger_cursor_owner_digest IS NULL OR ledger_cursor_owner_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN ledger_generation bigint
    CHECK (ledger_generation IS NULL OR ledger_generation >= 0),
  ADD COLUMN primary_incarnation text;

UPDATE postgres_readiness_sweeps
   SET state = 'pending'
 WHERE state = 'complete' AND ledger_watermark IS NULL;
