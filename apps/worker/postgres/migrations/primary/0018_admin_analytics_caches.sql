-- PostgreSQL primary migration 0018: provider-backed owner-admin caches.
--
-- These rows carry the existing D1 DTO payloads byte-for-byte.  They are
-- bounded aggregate evidence, never a second analytical source, and are
-- keyed by the canonical source id so a restored or misconfigured source
-- cannot be read as another runtime's dashboard.

CREATE TABLE analytics_admin_metric_snapshots (
  source_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  metrics_json text NOT NULL CHECK (char_length(metrics_json) <= 4000),
  PRIMARY KEY (source_id, captured_at)
);

CREATE TABLE analytics_admin_metrics_history_cache (
 source_id text PRIMARY KEY,
 source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
 generated_at timestamptz NOT NULL,
  payload_json text NOT NULL CHECK (char_length(payload_json) <= 524288)
);

CREATE TABLE analytics_admin_allowance_preview_cache (
 source_id text PRIMARY KEY,
 source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
 generated_at timestamptz NOT NULL,
  payload_json text NOT NULL CHECK (char_length(payload_json) <= 262144)
);

CREATE TABLE analytics_admin_progress_cache (
 source_id text PRIMARY KEY,
 source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
 generated_at timestamptz NOT NULL,
  payload_json text NOT NULL CHECK (char_length(payload_json) <= 524288)
);

CREATE INDEX analytics_admin_metric_snapshots_recent
  ON analytics_admin_metric_snapshots(source_id, captured_at DESC);
