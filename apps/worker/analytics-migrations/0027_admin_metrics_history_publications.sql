-- One owner-history publication per registered source and payload contract.
-- The analytics scheduler writes these rows and the main Worker serves them,
-- and the two deploy separately. With 0016's single source-keyed row, a newly
-- deployed writer replaced the only payload a not-yet-deployed reader accepted,
-- so every contract change blanked the owner dashboard until both matched.
-- Keying by contract lets each reader keep serving its own publication.
CREATE TABLE analytics_admin_metrics_history_publications (
 source_id TEXT NOT NULL,
 schema_version TEXT NOT NULL CHECK(length(schema_version) BETWEEN 1 AND 64),
 generated_at TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(length(payload_json)<=524288
  AND json_valid(payload_json)
  AND json_extract(payload_json,'$.schemaVersion')=schema_version
  AND json_extract(payload_json,'$.generatedAt')=generated_at),
 PRIMARY KEY(source_id,schema_version),
 FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
