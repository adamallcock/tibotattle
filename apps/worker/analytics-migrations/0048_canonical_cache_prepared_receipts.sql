-- A cache work lease may prepare its exact physical slots while bounded
-- neighbor repair still waits for another leaf. This receipt is scheduling
-- metadata only; it never proves source authority or cache completion.
CREATE TABLE analytics_canonical_cache_prepared_receipts (
 work_key TEXT PRIMARY KEY REFERENCES analytics_partition_work(work_key) ON DELETE CASCADE,
 work_revision INTEGER NOT NULL CHECK(work_revision BETWEEN 1 AND 9007199254740990),
 input_revision TEXT NOT NULL CHECK(length(input_revision)=64 AND input_revision NOT GLOB '*[^0-9a-f]*'),
 partition_key TEXT NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 256),
 method TEXT NOT NULL CHECK(method='canonical-cache-neighbors-v1'),
 manifest_generation INTEGER NOT NULL CHECK(manifest_generation>=0),
 row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 16)
) STRICT, WITHOUT ROWID;
