export const MAX_REQUEST_BYTES = 192 * 1024;
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_CONTRIBUTIONS_PER_PARTICIPANT = 1;

export const ENVELOPE_SCHEMA_VERSION = "synthetic-envelope-v0.1";
export const CONTRIBUTION_SCHEMA_VERSION = "synthetic-contribution-v0.1";
export const FIXTURE_ID = "codex-weekly-demo-v0.1";

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
