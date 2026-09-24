-- PostgreSQL upload ingress budget.
--
-- The budget name is an opaque host-selected namespace (normally the same
-- name used by the Worker Durable Object).  One state row is the serialization
-- point for token replenishment and lease admission; child lease rows retain
-- only opaque IDs and expiry timestamps.  This table contains no IP, account,
-- participant, request, or payload data.

CREATE TABLE upload_ingress_budget_states (
  budget_name text PRIMARY KEY
    CHECK (length(budget_name) BETWEEN 1 AND 200),
  schema_version text NOT NULL
    CHECK (schema_version = 'upload-ingress-budget-v0.1'),
  tokens double precision NOT NULL
    CHECK (tokens >= 0 AND tokens <= 1200 AND tokens <> 'NaN'::double precision),
  updated_at timestamptz NOT NULL,
  concurrency_denials bigint NOT NULL DEFAULT 0
    CHECK (concurrency_denials BETWEEN 0 AND 1000000000),
  start_rate_denials bigint NOT NULL DEFAULT 0
    CHECK (start_rate_denials BETWEEN 0 AND 1000000000),
  last_denied_at timestamptz
);

CREATE TABLE upload_ingress_budget_leases (
  budget_name text NOT NULL REFERENCES upload_ingress_budget_states(budget_name)
    ON DELETE CASCADE,
  lease_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (budget_name, lease_id)
);

CREATE INDEX upload_ingress_budget_leases_expiry
  ON upload_ingress_budget_leases(budget_name, expires_at);

-- Fixed-window per-binding rate limits.  `key_digest` is the only request
-- identity retained; callers must never be able to recover an address,
-- credential, or other raw key from this table.
CREATE TABLE postgres_rate_limit_buckets (
  limiter_name text NOT NULL
    CHECK (length(limiter_name) BETWEEN 1 AND 80),
  key_digest text NOT NULL
    CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  used_count integer NOT NULL CHECK (used_count BETWEEN 0 AND 10000),
  PRIMARY KEY (limiter_name, key_digest)
);

CREATE INDEX postgres_rate_limit_buckets_expiry
  ON postgres_rate_limit_buckets(limiter_name, window_started_at);
