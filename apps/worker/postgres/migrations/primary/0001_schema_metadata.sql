-- PostgreSQL primary schema migration 0001.
--
-- The migration runner sets search_path to the validated runtime schema before
-- executing this file. Feature tables arrive in later numbered fragments from
-- the owning adapters; this history table is the only bootstrap contract.
CREATE TABLE IF NOT EXISTS _tibotattle_migration_history (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
