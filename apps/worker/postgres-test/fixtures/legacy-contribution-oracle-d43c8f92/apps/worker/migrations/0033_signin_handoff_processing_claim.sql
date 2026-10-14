PRAGMA foreign_keys = ON;

-- A one-use OAuth state must be reserved before any expensive external work, or
-- many concurrent callbacks carrying one valid state each pass the plain pending
-- read and each generates a client secret and issues a provider token request.
-- These columns turn the pending read into an atomic claim: a callback moves the
-- row from pending to a short-lived processing state (claim_id + claimed_at)
-- with a conditional UPDATE, and only the single winner proceeds to provider I/O.
-- Completion and failure-discard are then fenced to that claim_id, so one racing
-- callback can never delete or complete another claimant's row.
--
-- claimed_at doubles as a lease: a claim older than the processing window is
-- re-claimable, so a crashed claimant strands the sign-in only briefly and one
-- bounded retry can still complete it inside the authorization window. Columns
-- are nullable and added forward-only; existing in-flight rows are simply
-- unclaimed and are claimed by the next callback.
ALTER TABLE apple_signin_handoffs ADD COLUMN claim_id TEXT
  CHECK (claim_id IS NULL OR (
    length(claim_id) = 64
    AND claim_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ));
ALTER TABLE apple_signin_handoffs ADD COLUMN claimed_at TEXT;

ALTER TABLE google_signin_handoffs ADD COLUMN claim_id TEXT
  CHECK (claim_id IS NULL OR (
    length(claim_id) = 64
    AND claim_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ));
ALTER TABLE google_signin_handoffs ADD COLUMN claimed_at TEXT;
