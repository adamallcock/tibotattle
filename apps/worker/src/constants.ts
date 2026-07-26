export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_PLAINTEXT_BYTES = 1536 * 1024;
export const MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT = 1;
export const MAX_TELEMETRY_CONTRIBUTIONS_PER_PARTICIPANT = 100;
export const AGGREGATE_MINIMUM_PARTICIPANTS = 3;

export const ENVELOPE_SCHEMA_VERSION = "synthetic-envelope-v0.1";
export const CONTRIBUTION_SCHEMA_VERSION = "synthetic-contribution-v0.1";
export const FIXTURE_ID = "codex-weekly-demo-v0.1";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v0.1";
export const TELEMETRY_CONTRIBUTION_SCHEMA_VERSION = "telemetry-contribution-v0.1";
export const TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.1";

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
