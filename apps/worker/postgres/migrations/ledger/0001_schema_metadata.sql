-- PostgreSQL deletion-ledger schema migration 0001.
--
-- The ledger has an independent runtime schema and pool. Feature tables arrive
-- in later numbered fragments from the erasure and restore adapters.
CREATE TABLE IF NOT EXISTS _tibotattle_migration_history (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
