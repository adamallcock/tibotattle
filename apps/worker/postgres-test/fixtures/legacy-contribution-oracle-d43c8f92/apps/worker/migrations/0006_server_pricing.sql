PRAGMA foreign_keys = ON;

ALTER TABLE telemetry_records ADD COLUMN billing_surface TEXT;
ALTER TABLE telemetry_records ADD COLUMN total_input_context_tokens INTEGER;
ALTER TABLE telemetry_records ADD COLUMN reasoning_effort TEXT;
ALTER TABLE telemetry_records ADD COLUMN agent_scope TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_cost_usd TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_cost_nanousd INTEGER;
ALTER TABLE telemetry_records ADD COLUMN server_pricing_coverage_percent REAL;
ALTER TABLE telemetry_records ADD COLUMN server_unknown_billable_units INTEGER;
ALTER TABLE telemetry_records ADD COLUMN server_pricing_status TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_pricing_method_version TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_price_registry_version TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_price_registry_sha256 TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_price_card_ids TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_unpriced_reason_codes TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_price_epoch_basis TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_tier_basis TEXT;
ALTER TABLE telemetry_records ADD COLUMN server_api_service_tier TEXT;

ALTER TABLE telemetry_contributions ADD COLUMN server_cost_nanousd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry_contributions ADD COLUMN server_priced_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry_contributions ADD COLUMN server_partially_priced_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry_contributions ADD COLUMN server_unpriced_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry_contributions ADD COLUMN server_pricing_method_version TEXT;
ALTER TABLE telemetry_contributions ADD COLUMN server_price_registry_version TEXT;
ALTER TABLE telemetry_contributions ADD COLUMN server_price_registry_sha256 TEXT;

CREATE INDEX telemetry_records_participant_server_price
  ON telemetry_records(participant_id, record_kind, observed_at, server_pricing_status);
