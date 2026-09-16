-- Independent deletion ledger for the owner-erasure qualification.
-- Load this into a separate disposable PostgreSQL database from erasure.sql.

CREATE SCHEMA tibotattle_erasure_ledger_test;
REVOKE ALL ON SCHEMA tibotattle_erasure_ledger_test FROM PUBLIC;

CREATE TABLE tibotattle_erasure_ledger_test.deletion_tombstones (
  participant_digest text PRIMARY KEY,
  schema_version text NOT NULL,
  deleted_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  CHECK (length(participant_digest) = 64),
  CHECK (retain_until >= deleted_at)
);
