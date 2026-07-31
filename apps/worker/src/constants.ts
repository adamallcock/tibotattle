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
export const UPLOAD_CONSUME_LEASE_MILLISECONDS = 60 * 1000;
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
export const ENROLLMENT_MODES = ["local_open", "open", "invite_only", "disabled"] as const;

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
