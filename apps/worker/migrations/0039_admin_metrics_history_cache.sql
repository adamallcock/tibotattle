-- Singleton aggregate caches for owner-dashboard history and allowance reads.
-- Scheduled maintenance builds content-free payloads from SELECT-only source
-- paths; authenticated interactive requests read only the corresponding row.
--
-- The JSON contract contains counts, calendar-day buckets, and named gauge
-- snapshots only. The application validates the complete v0.2 shape before
-- every write and read; this hard cap is a second, storage-level growth bound.
CREATE TABLE admin_metrics_history_cache (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 524288)
) STRICT;

-- Separate singleton for the owner-only merged-allowance preview. The payload
-- contains only coverage counts and 70 aggregate day summaries; participant
-- identifiers and raw fit evidence never cross this storage boundary.
CREATE TABLE admin_community_allowance_preview_cache (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 131072)
) STRICT;
