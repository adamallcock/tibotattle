export const TELEMETRY_SCHEMA_VERSION = "telemetry-contribution-v0.1";
export const TELEMETRY_CONTRIBUTION_SCHEMA_VERSION =
  TELEMETRY_SCHEMA_VERSION;
export const ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v0.2";
export const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION =
  "telemetry-envelope-v0.1";
export const ACCOUNT_SCOPED_TELEMETRY_ENVELOPE_SCHEMA_VERSION =
  "telemetry-envelope-v0.2";
export const MAX_TELEMETRY_BROWSER_BYTES = 1_310_720;

export const TELEMETRY_PLAN_TYPES = Object.freeze([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "business",
  "enterprise",
  "edu",
  "team",
  "unknown",
]);

export const TELEMETRY_TOOL_CLASSES = Object.freeze([
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "hostedShell",
  "computerUse",
  "mcp",
  "applyPatch",
  "localShell",
  "subagent",
  "toolGateway",
  "other",
  "unknown",
]);

export const TELEMETRY_MODEL_IDS = Object.freeze([
  "unknown",
  "gpt-4.1",
  "gpt-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]);
