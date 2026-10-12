-- Durable ledger receipts for erase/restore replay. Payloads remain digest or
-- bounded metadata only; application source/object content stays in primary
-- storage and object providers.

CREATE TABLE participant_erasure_receipts (
  operation_id text PRIMARY KEY,
  participant_digest text NOT NULL CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('started', 'completed', 'failed')),
  details_json text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE restore_suppression_receipts (
  receipt_id text PRIMARY KEY,
  participant_digest text NOT NULL CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  restore_digest text NOT NULL CHECK (restore_digest ~ '^[0-9a-f]{64}$'),
  suppressed_at timestamptz NOT NULL,
  UNIQUE (participant_digest, restore_digest)
);
