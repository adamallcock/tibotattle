-- Owner-only, content-free dashboard history belongs to analytics storage.
-- Rows are pinned to the registered ingestion source because one analytics
-- database may consume more than one explicit source.
CREATE TABLE analytics_admin_metric_snapshots (
 source_id TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 metrics_json TEXT NOT NULL CHECK(length(metrics_json)<=4000),
 PRIMARY KEY(source_id,captured_at),
 FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE analytics_admin_metrics_history_cache (
 source_id TEXT PRIMARY KEY,
 generated_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(length(payload_json)<=524288),
 FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
