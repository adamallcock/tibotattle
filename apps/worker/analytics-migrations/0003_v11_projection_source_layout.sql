-- Resume only with the exact storage layout used by the first page. A verified
-- raw-to-typed copy/cutover is separate from a pending aggregate calculation.
ALTER TABLE analytics_v11_projection_work ADD COLUMN source_namespace TEXT;
ALTER TABLE analytics_v11_projection_work ADD COLUMN source_layout TEXT NOT NULL DEFAULT 'json-v11'
  CHECK((source_layout='json-v11' AND source_namespace IS NULL)
    OR (source_layout='typed-v11' AND source_namespace IS NOT NULL AND length(source_namespace) BETWEEN 1 AND 256));
CREATE TRIGGER analytics_v11_work_source_layout_immutable BEFORE UPDATE ON analytics_v11_projection_work
WHEN OLD.source_layout IS NOT NEW.source_layout OR OLD.source_namespace IS NOT NEW.source_namespace
BEGIN SELECT RAISE(ABORT,'analytics_v11_source_layout_immutable'); END;
