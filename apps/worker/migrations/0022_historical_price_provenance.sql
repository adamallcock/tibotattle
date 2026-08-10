PRAGMA foreign_keys = ON;

-- Keep the server's pricing decision and the canonical event-time input
-- alongside retained records. Contribution-level fields summarize the rows
-- accepted into that contribution so a later audit can distinguish one basis
-- from a genuinely mixed batch without re-pricing the payload.
ALTER TABLE telemetry_records ADD COLUMN server_price_basis TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_price_event_time TEXT;

ALTER TABLE telemetry_contributions ADD COLUMN server_price_basis TEXT;
ALTER TABLE telemetry_contributions ADD COLUMN server_price_epoch_basis TEXT;
ALTER TABLE telemetry_contributions ADD COLUMN server_price_event_time_start TEXT;
ALTER TABLE telemetry_contributions ADD COLUMN server_price_event_time_end TEXT;
