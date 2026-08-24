-- Hourly owner-dashboard gauge snapshots. Event-count history is computed
-- retroactively from the retained event tables; this table exists only for
-- the numbers that are current-state reads (backlogs, corpus posture, the
-- published band cohort) and would otherwise have no yesterday.
--
-- Aggregate identity boundary: metrics_json is a flat object of named counts.
-- No participant identifiers, no per-account rows. Growth is one row per
-- hour; history is kept in full and downsampled only at read time.
CREATE TABLE admin_metric_snapshots (
  captured_at TEXT PRIMARY KEY,
  metrics_json TEXT NOT NULL CHECK (length(metrics_json) <= 4000)
) STRICT;
