-- PostgreSQL analytics journals currently contain legacy scheduler rows that
-- cannot be reconstructed into the exact D1 event tuple. Keep those rows
-- explicitly unqualified (version 0) and require future exact tuples to opt in
-- with every source field present.

ALTER TABLE storage_ingestion_changes
  ADD COLUMN event_tuple_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN revision bigint,
  ADD COLUMN object_digest text,
  ADD COLUMN content_digest text,
  ADD COLUMN public_authority_epoch bigint,
  ADD CONSTRAINT storage_ingestion_event_tuple_version CHECK (
    (event_tuple_version = 0 AND revision IS NULL AND object_digest IS NULL
      AND content_digest IS NULL AND public_authority_epoch IS NULL)
    OR
    (event_tuple_version = 1 AND revision IS NOT NULL AND revision > 0
      AND object_digest IS NOT NULL AND object_digest ~ '^[0-9a-f]{64}$'
      AND content_digest IS NOT NULL AND content_digest ~ '^[0-9a-f]{64}$'
      AND authority_epoch > 0 AND public_authority_epoch IS NOT NULL
      AND public_authority_epoch > 0 AND recorded_ms >= 0)
  );

ALTER TABLE analytics_applied_events
  ADD COLUMN event_tuple_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN revision bigint,
  ADD COLUMN kind text,
  ADD COLUMN object_digest text,
  ADD COLUMN content_digest text,
  ADD COLUMN public_authority_epoch bigint,
  ADD COLUMN recorded_ms bigint,
  ADD CONSTRAINT analytics_applied_event_tuple_version CHECK (
    (event_tuple_version = 0 AND revision IS NULL AND kind IS NULL
      AND object_digest IS NULL AND content_digest IS NULL
      AND public_authority_epoch IS NULL AND recorded_ms IS NULL)
    OR
    (event_tuple_version = 1 AND revision IS NOT NULL AND revision > 0
      AND kind IS NOT NULL
      AND kind IN ('source-updated', 'owner-active', 'owner-withdrawn', 'owner-erased')
      AND object_digest IS NOT NULL AND object_digest ~ '^[0-9a-f]{64}$'
      AND content_digest IS NOT NULL AND content_digest ~ '^[0-9a-f]{64}$'
      AND authority_epoch > 0 AND public_authority_epoch IS NOT NULL
      AND public_authority_epoch > 0 AND recorded_ms IS NOT NULL AND recorded_ms >= 0)
  );

COMMENT ON COLUMN storage_ingestion_changes.event_tuple_version IS
  '0 is legacy PostgreSQL scheduler history without the full D1 tuple; 1 is the complete D1 event tuple.';
COMMENT ON COLUMN analytics_applied_events.event_tuple_version IS
  '0 is legacy PostgreSQL receipts without the full D1 tuple; 1 is the complete D1 event tuple.';
COMMENT ON COLUMN storage_ingestion_changes.revision IS
  'Exact D1 event tuple revision; legacy PostgreSQL rows leave this NULL because owner_revision is not interchangeable.';
COMMENT ON COLUMN analytics_applied_events.revision IS
  'Exact D1 event tuple revision; legacy PostgreSQL receipts leave this NULL.';
