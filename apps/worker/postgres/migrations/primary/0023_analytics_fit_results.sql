-- PostgreSQL primary migration 0023: persist the reviewed reset-fit output
-- separately from daily/model result payloads. The existing owner-result row
-- already carries the complete owner/source authority fence and cascades on
-- erasure, so the graph builder can capture exactly the same eligible cohort
-- without reconstructing raw telemetry or deriving fits from model output.

ALTER TABLE analytics_owner_results
  DROP CONSTRAINT analytics_owner_results_metric_check;

ALTER TABLE analytics_owner_results
  ADD CONSTRAINT analytics_owner_results_metric_check
  CHECK (metric IN ('daily', 'model', 'fits'));
