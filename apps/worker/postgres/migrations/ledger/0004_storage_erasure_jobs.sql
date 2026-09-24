-- Restartable provider-neutral erasure jobs. The independent ledger keeps the
-- owner digest and terminal proof after a primary restore; object payloads
-- remain outside this database.
CREATE TABLE storage_erasure_jobs (
  participant_digest text NOT NULL CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  source_namespace text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'complete')),
  terminal_json text,
  attempted_ms bigint NOT NULL DEFAULT 0 CHECK (attempted_ms >= 0),
  completed_at timestamptz,
  PRIMARY KEY (participant_digest, source_id, owner_digest),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
  CHECK (terminal_json IS NULL OR length(terminal_json) <= 65536)
);
CREATE INDEX storage_erasure_jobs_due
  ON storage_erasure_jobs(source_id, state, attempted_ms, participant_digest, owner_digest);
