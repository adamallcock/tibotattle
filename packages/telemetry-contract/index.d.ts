export const TELEMETRY_SCHEMA_VERSION:
  "telemetry-contribution-v0.1";
export const TELEMETRY_CONTRIBUTION_SCHEMA_VERSION:
  typeof TELEMETRY_SCHEMA_VERSION;
export const ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION:
  "telemetry-contribution-v0.2";
export const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION:
  "privacy-safe-telemetry-v0.2";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION:
  "telemetry-envelope-v0.1";
export const ACCOUNT_SCOPED_TELEMETRY_ENVELOPE_SCHEMA_VERSION:
  "telemetry-envelope-v0.2";
export const MAX_TELEMETRY_BROWSER_BYTES: 1310720;

export const TELEMETRY_PLAN_TYPES: readonly [
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
];
export type TelemetryPlanType = typeof TELEMETRY_PLAN_TYPES[number];

export const TELEMETRY_TOOL_CLASSES: readonly [
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
];
export type TelemetryToolClass =
  typeof TELEMETRY_TOOL_CLASSES[number];

export const TELEMETRY_MODEL_IDS: readonly [
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
];
export type TelemetryModelId = typeof TELEMETRY_MODEL_IDS[number];

export const TELEMETRY_CONTRACT_ERROR_CODES: readonly [
  "ENVELOPE_INVALID",
  "PRIVACY_CANARY_DETECTED",
  "TELEMETRY_RECORD_INVALID",
];
export type TelemetryContractErrorCode =
  typeof TELEMETRY_CONTRACT_ERROR_CODES[number];

export class TelemetryContractError extends TypeError {
  constructor(
    code: TelemetryContractErrorCode,
    detailCode: string,
    message?: string,
  );
  readonly code: TelemetryContractErrorCode;
  readonly detailCode: string;
}

export function isTelemetryContractError(
  value: unknown,
): value is TelemetryContractError;

export interface TelemetryValidationOptions {
  maxSerializedBytes?: number;
  maxDepth?: number;
  maxArrayItems?: number;
  nowEpoch?: number;
}

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_ENVELOPE_SCHEMA_VERSION;
  synthetic: false;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

export interface UsageAccounting {
  estimatedApiCostUsd: string | null;
  pricingCoveragePercent: number;
  unknownBillableUnits: number;
  priceBasis:
    | "current_api_prices"
    | "historical_api_prices"
    | "unpriced";
}

export type TelemetryBatchPriceBasis =
  | UsageAccounting["priceBasis"]
  | "mixed_api_prices";

export interface TelemetryUsageEvent {
  schemaVersion: "usage-event-v0.1";
  eventTime: string;
  provider: "openai_codex" | "anthropic_claude_code";
  modelId: TelemetryModelId;
  modelRecognition: "recognized" | "unrecognized" | "missing";
  modelFingerprint: string | null;
  billingSurface:
    | "chatgpt_subscription"
    | "openai_api"
    | "claude_subscription"
    | "unknown";
  speedMode: "standard" | "fast" | "unknown" | "other";
  apiServiceTier:
    | "standard"
    | "priority"
    | "flex"
    | "batch"
    | "unknown"
    | "other";
  reasoningEffort:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra"
    | "unknown";
  components: {
    inputUncachedTokens: number | null;
    inputCacheReadTokens: number | null;
    inputCacheWriteTokens: number | null;
    inputCacheWrite5mTokens: number | null;
    inputCacheWrite1hTokens: number | null;
    outputTextTokens: number | null;
    outputReasoningTokens: number | null;
    outputCombinedTokens: number | null;
  };
  totalInputContextTokens: number | null;
  surface:
    | "scheduled_task"
    | "subagent"
    | "extension_or_ide"
    | "cli_exec"
    | "local_interactive_unclassified"
    | "local_rollout_unclassified";
  agentScope: "root" | "subagent" | "automation" | "unknown";
  lineageDisposition: "standalone" | "forked" | "parent_linked";
  toolClassCounts: Record<TelemetryToolClass, number>;
  outcome:
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "retry"
    | "unknown";
  eventId: string;
  accounting: UsageAccounting;
}

export interface TelemetryQuotaSnapshot {
  schemaVersion: "quota-snapshot-v0.1";
  observedTime: string;
  receivedTime: string;
  provider: "openai_codex" | "anthropic_claude_code";
  planType: TelemetryPlanType;
  planVariant:
    | "pro-20x"
    | "pro-10x-promo"
    | "pro-5x"
    | "plus"
    | "unknown";
  limitId: "unknown" | "codex" | "codex-spark";
  slot:
    | "primary"
    | "secondary"
    | "five_hour"
    | "seven_day"
    | "other"
    | "unknown";
  usedPercent: number;
  displayPrecision: number;
  windowDurationMinutes: number;
  resetsAt: string;
  snapshotSource:
    | "rollout"
    | "app_server_read"
    | "status_line"
    | "ui_declaration"
    | "notification";
  providerSurface:
    | "account_shared_unallocated"
    | "general_usage"
    | "model_specific"
    | "separate_limit"
    | "unknown";
  snapshotId: string;
}

export interface TelemetryActivityMarker {
  schemaVersion: "export-activity-marker-v0.1";
  observedTime: string;
  surface: string;
  state: "start" | "end" | "pulse";
  agenticPoolCoupling: string;
  planType: TelemetryPlanType;
  planVariant: TelemetryQuotaSnapshot["planVariant"];
  markerId: string;
}

export interface TelemetryContribution {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  synthetic: false;
  createdAt: string;
  coveredAt: {
    startAt: string;
    endAt: string;
  };
  clientPlatform: "macos" | "linux" | "windows" | "other" | "unknown";
  providerPolicyEpoch:
    | "unknown"
    | "openai_pre_agentic_pool_2026_07_09"
    | "openai_agentic_pool_2026_07_09"
    | "anthropic_unknown";
  usageEvents: TelemetryUsageEvent[];
  quotaSnapshots: TelemetryQuotaSnapshot[];
  activityMarkers: TelemetryActivityMarker[];
  accounting: {
    estimatedApiCostUsd: string | null;
    pricedEventCoveragePercent: number;
    unknownModelEventCount: number;
    unknownBillableUnits: number;
    priceBasis: TelemetryBatchPriceBasis;
  };
}

export type AccountTrackId =
  | "unattributed"
  | `account-track:v1:${string}`;

export type UsageAccountingDiagnosticV02 =
  Omit<UsageAccounting, "priceBasis"> & {
    status: "untrusted_diagnostic";
    sourceSchemaVersion: "telemetry-contribution-v0.1";
    priceBasis: UsageAccounting["priceBasis"];
  };

export type TelemetryUsageEventV02 =
  Omit<TelemetryUsageEvent, "schemaVersion" | "accounting"> & {
    schemaVersion: "usage-event-v0.2";
    accountTrackId: AccountTrackId;
    accountingDiagnostic: UsageAccountingDiagnosticV02;
  };

export type TelemetryQuotaSnapshotV02 =
  Omit<TelemetryQuotaSnapshot, "schemaVersion"> & {
    schemaVersion: "quota-snapshot-v0.2";
    accountTrackId: AccountTrackId;
  };

export type TelemetryActivityMarkerV02 =
  Omit<TelemetryActivityMarker, "schemaVersion"> & {
    schemaVersion: "activity-marker-v0.2";
    provider: "openai_codex";
    accountTrackId: AccountTrackId;
  };

export interface TelemetryContributionV02
  extends Omit<
    TelemetryContribution,
    | "schemaVersion"
    | "usageEvents"
    | "quotaSnapshots"
    | "activityMarkers"
    | "accounting"
  > {
  schemaVersion: typeof ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION;
  consentVersion: typeof ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  status: "implementation_disabled";
  datasetId: `dataset:v1:${string}`;
  partIndex: number;
  partCount: number;
  completeness: "complete" | "partial";
  usageEvents: TelemetryUsageEventV02[];
  quotaSnapshots: TelemetryQuotaSnapshotV02[];
  activityMarkers: TelemetryActivityMarkerV02[];
  accountingDiagnostic: {
    status: "untrusted_diagnostic";
    sourceSchemaVersion: "telemetry-contribution-v0.1";
    estimatedApiCostUsd: string | null;
    pricedEventCoveragePercent: number;
    unknownModelEventCount: number;
    unknownBillableUnits: number;
    priceBasis: TelemetryBatchPriceBasis;
  };
}

export interface TelemetryInspection {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function parseTelemetryContribution(
  value: unknown,
  options?: TelemetryValidationOptions,
): TelemetryContribution;
export function validateTelemetryContribution(
  value: unknown,
  options?: TelemetryValidationOptions,
): true;
export function parseTelemetryContributionV02(
  value: unknown,
  options?: TelemetryValidationOptions,
): TelemetryContributionV02;
export function validateAccountScopedTelemetryContribution(
  value: unknown,
  options?: TelemetryValidationOptions,
): true;
export function inspectTelemetryContributionV02(
  value: unknown,
  options?: TelemetryValidationOptions,
): TelemetryInspection;
export function inspectTelemetryContributionDatasetV02(
  parts: unknown,
  options?: TelemetryValidationOptions,
): TelemetryInspection;
export function canonicalTelemetryContributionV01(
  value: TelemetryContributionV02,
  options?: TelemetryValidationOptions,
): TelemetryContribution;
export function validateContributionForUpload(
  value: unknown,
  options?: TelemetryValidationOptions,
): true;
export function parseTelemetryEnvelope(
  value: unknown,
): TelemetryEnvelope;
export function validateTelemetryEnvelope(
  value: unknown,
): true;
