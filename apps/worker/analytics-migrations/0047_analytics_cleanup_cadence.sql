-- Source-global scheduling metadata only; this has no owner or payload keys.
-- A due-time CAS serializes empty lifecycle sweeps. Successful bounded removal
-- may reopen immediately; a no-op or interrupted pass retries within one minute.
CREATE TABLE analytics_partition_maintenance (
 source_id TEXT PRIMARY KEY REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 next_cleanup_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_cleanup_ms BETWEEN 0 AND 9007199254740991),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
