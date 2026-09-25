-- Exact version-1 D1 event tuples carry their immutable fields directly and
-- do not have a PostgreSQL projection JSON representation. Keep the legacy
-- version-0 compatibility value required while permitting NULL only for the
-- exact tuple version checked by migration 0038.
ALTER TABLE analytics_applied_events
  ALTER COLUMN projection_json DROP NOT NULL,
  ADD CONSTRAINT analytics_applied_projection_json_required_unless_v1 CHECK (
    event_tuple_version = 1 OR projection_json IS NOT NULL
  );

COMMENT ON COLUMN analytics_applied_events.projection_json IS
  'Legacy event tuple version 0 requires a projection; exact version 1 tuples carry the complete tuple in dedicated columns and permit NULL projection JSON.';
