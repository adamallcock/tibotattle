export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_PLAINTEXT_BYTES = 1536 * 1024;
export const MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT = 1;
export const MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW = 100;
export const TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS =
  7 * 24 * 60 * 60 * 1000;
export const MAX_PARTICIPANT_PROFILE_HISTORY_ITEMS = 101;
export const AGGREGATE_MINIMUM_PARTICIPANTS = 3;
export const COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS = 20;
export const COMMUNITY_WEEKLY_POLICY_VERSION = "community-weekly-v0.1";
export const COMMUNITY_WEEKLY_CUTOFF_MILLISECONDS = 48 * 60 * 60 * 1000;
export const COMMUNITY_WEEKLY_LEASE_MILLISECONDS = 5 * 60 * 1000;
export const COMMUNITY_WEEKLY_MAX_CELLS = 100;
export const SESSION_TTL_MILLISECONDS = 30 * 60 * 1000;
export const UPLOAD_AUTHORIZATION_TTL_MILLISECONDS = 5 * 60 * 1000;
// This must cover every allowed ingress lease. The Durable Object may renew a
// live request for up to the configured five-minute maximum, and canonical
// D1 insert triggers must not expire its one-use authorization earlier.
export const UPLOAD_CONSUME_LEASE_MILLISECONDS = 5 * 60 * 1000;
// The ingress Durable Object may renew its short operational lease while the
// request is alive, but no single public upload may hold that shared capacity
// for longer than four minutes. The body policy is capped below this value;
// handlers re-check the live lease immediately before storage side effects.
export const MAX_UPLOAD_INGRESS_LIFETIME_MILLISECONDS = 4 * 60 * 1000;
export const DEVICE_PAIRING_TTL_MILLISECONDS = 10 * 60 * 1000;
export const DEVICE_CREDENTIAL_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
export const RECOVERY_RETRY_TTL_MILLISECONDS = 5 * 60 * 1000;
export const RECOVERY_RETRY_LIMIT = 2;
export const QUARANTINE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS =
  60 * 60 * 1000;
export const BACKEND_LIFECYCLE_STALE_MILLISECONDS = 2 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";

export const ENVELOPE_SCHEMA_VERSION = "synthetic-envelope-v0.1";
export const CONTRIBUTION_SCHEMA_VERSION = "synthetic-contribution-v0.1";
export const FIXTURE_ID = "codex-weekly-demo-v0.1";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v0.1";
export const TELEMETRY_CONTRIBUTION_SCHEMA_VERSION = "telemetry-contribution-v0.1";
export const TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.1";
export const ONGOING_TELEMETRY_CONSENT_VERSION =
  "ongoing-privacy-safe-telemetry-v0.1";
export const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2";
export const ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION =
  "ongoing-privacy-safe-telemetry-v0.2";
// telemetry-contribution-v1.0 consent identifiers (incremental contribution
// model). The field dictionary identifier is pinned here until the contract
// package freezes the regenerated v1.0 registry.
export const INCREMENTAL_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v1.0";
export const INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION =
  "telemetry-v1.0-registry-2026-08-07.1";
export const ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION =
  "ongoing-privacy-safe-telemetry-v1.0";
export const ENROLLMENT_MODES = ["local_open", "open", "invite_only", "disabled"] as const;

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
