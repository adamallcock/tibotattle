-- PostgreSQL primary migration 0020: restart-safe analytical results and
-- per-owner event delivery cursors.
--
-- Result rows are calculation evidence, not public aggregates.  The
-- scheduler materializes them only after the shared quota/model finisher has
-- proved the complete source pin.  Publications then fold the exact active
-- cohort through the existing aggregate builders.

CREATE TABLE analytics_owner_results (
  source_id text NOT NULL,
  source_namespace text NOT NULL,
  observed_day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('daily','model')),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  owner_revision bigint NOT NULL CHECK (owner_revision >= 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  public_authority_epoch bigint NOT NULL CHECK (public_authority_epoch >= 0),
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  method text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready','not_testable')),
  reason text,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  computed_at_ms bigint NOT NULL CHECK (computed_at_ms >= 0),
  PRIMARY KEY (source_id, observed_day, metric, owner_digest),
  CONSTRAINT analytics_owner_results_owner_fk
    FOREIGN KEY (source_id, owner_digest)
    REFERENCES analytics_owner_state(source_id, owner_digest)
    ON DELETE CASCADE,
  CHECK ((status='ready' AND reason IS NULL) OR
         (status='not_testable' AND reason IS NOT NULL))
);
CREATE INDEX analytics_owner_results_publication
  ON analytics_owner_results(source_id, observed_day, metric, owner_digest);

-- Cursors are per owner so acknowledging one out-of-order candidate can
-- never hide another owner's earlier ingestion event.  The event digest is
-- retained for diagnostics while sequence remains the monotonic fence.
CREATE TABLE analytics_scheduler_delivery_cursors (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  last_attempt_at_ms bigint NOT NULL DEFAULT 0 CHECK (last_attempt_at_ms >= 0),
  PRIMARY KEY (source_id, owner_digest),
  CONSTRAINT analytics_scheduler_delivery_owner_fk
    FOREIGN KEY (source_id, owner_digest)
    REFERENCES analytics_owner_state(source_id, owner_digest)
    ON DELETE CASCADE
);
