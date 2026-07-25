export const TELEMETRY_V01_REGISTRY_VERSION = "telemetry-v0.1-registry-2026-07-25.3";
export const TELEMETRY_V01_REVIEWED_AT = "2026-07-25";

export const OPENAI_CODEX_MODEL_IDS = Object.freeze([
  "gpt-4.1",
  "gpt-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export const OPENAI_CODEX_LIMIT_IDS = Object.freeze([
  "codex",
  "codex-spark",
]);

export const ANTHROPIC_CLAUDE_MODEL_IDS = Object.freeze([
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]);

export const EXPORT_DIAGNOSTIC_CODES = Object.freeze([
  "collector_empty_lines",
  "collector_irrelevant_records",
  "collector_out_of_bounds_records",
  "collector_oversized_irrelevant_lines",
  "collector_unsupported_schema_records",
  "collector_unsupported_source_records",
  "fork_replay_events_skipped",
  "last_only_events",
  "lineage_parents_missing",
  "malformed_lines",
  "malformed_rate_limit_records",
  "malformed_task_events",
  "malformed_timestamps",
  "malformed_usage_records",
  "missing_rate_limit_records",
  "replayed_events_skipped",
  "replayed_tool_calls_skipped",
  "unattached_tool_calls",
  "unattributed_fork_replay_events_skipped",
]);

const modelIds = new Set([...OPENAI_CODEX_MODEL_IDS, ...ANTHROPIC_CLAUDE_MODEL_IDS]);
const limitIds = new Set(OPENAI_CODEX_LIMIT_IDS);

export function recognizedExportModelId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return modelIds.has(normalized) ? normalized : null;
}

export function recognizedExportLimitId(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return limitIds.has(normalized) ? normalized : "unknown";
}

export function exportRegistrySnapshot() {
  return {
    schemaVersion: TELEMETRY_V01_REGISTRY_VERSION,
    reviewedAt: TELEMETRY_V01_REVIEWED_AT,
    evidence: "reviewed_local_observations_and_repository_fixtures",
    providers: {
      openai_codex: {
        modelIds: [...OPENAI_CODEX_MODEL_IDS],
        limitIds: [...OPENAI_CODEX_LIMIT_IDS],
      },
      anthropic_claude_code: { modelIds: [...ANTHROPIC_CLAUDE_MODEL_IDS], limitIds: [] },
    },
    diagnosticCodes: [...EXPORT_DIAGNOSTIC_CODES],
  };
}
