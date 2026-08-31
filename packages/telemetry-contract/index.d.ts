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
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
];
export type TelemetryPlanType = typeof TELEMETRY_PLAN_TYPES[number];
export const TELEMETRY_PLAN_DISPLAY_NAMES: Readonly<
  Record<Exclude<TelemetryPlanType, "unknown">, string>
>;

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

export const TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION: "telemetry-contribution-v1.1";
export const TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION: "telemetry-envelope-v1.1";
export const TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION: "telemetry-day-manifest-v1.1";
export const TELEMETRY_V11_FIELD_DICTIONARY_VERSION: "telemetry-v1.1-registry-2026-08-31.1";
export const TELEMETRY_V11_PRIVACY_CONTRACT_VERSION: "ongoing-privacy-safe-telemetry-v1.1";
export const TELEMETRY_V11_CONTRACT_STATE: "staged";
export const MAX_TELEMETRY_V11_CHUNK_RECORDS: 200;
export const MAX_TELEMETRY_V11_CHUNK_CANONICAL_BYTES: 1250000;
export const MAX_TELEMETRY_V11_DAY_CHUNKS: 4096;
export const TELEMETRY_V11_STREAMS: readonly ["quota", "session", "usage"];
export const TELEMETRY_V11_ACCOUNT_BASES: readonly ["same_source", "provisional_marker", "unavailable"];
export const TELEMETRY_V11_PLAN_BASES: readonly ["same_source_occurrence", "provisional_marker", "conflicted", "unavailable"];
export type TelemetryV11Stream = typeof TELEMETRY_V11_STREAMS[number];
export type TelemetryV11AccountBasis = typeof TELEMETRY_V11_ACCOUNT_BASES[number];
export type TelemetryV11PlanBasis = typeof TELEMETRY_V11_PLAN_BASES[number];
export interface TelemetryV11Attribution {
  accountBasis: TelemetryV11AccountBasis;
  accountTrackId: string | null;
  planBasis: TelemetryV11PlanBasis;
  planType: TelemetryPlanType;
  planEraId: string | null;
}
export interface TelemetryV11Consent {
  telemetrySchemaVersion: typeof TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION;
  fieldDictionaryVersion: typeof TELEMETRY_V11_FIELD_DICTIONARY_VERSION;
  privacyContractVersion: typeof TELEMETRY_V11_PRIVACY_CONTRACT_VERSION;
}
export interface TelemetryV11UsageEvent {
  schemaVersion: "usage-event-v1.1";
  eventId: string;
  eventTime: string;
  sessionUuid: string;
  provider: string;
  modelId: string;
  speedMode: string;
  apiServiceTier: string;
  surface: string;
  billingSurface: string;
  reasoningEffort: string;
  agentScope: string;
  outcome: string;
  totalInputContextTokens: number | null;
  components: {
    inputUncachedTokens: number | null;
    inputCacheReadTokens: number | null;
    inputCacheWriteTokens: number | null;
    outputTextTokens: number | null;
    outputReasoningTokens: number | null;
    outputCombinedTokens: number | null;
  };
  accountPlanAttribution: TelemetryV11Attribution;
}
export interface TelemetryV11QuotaObservation {
  schemaVersion: "quota-observation-v1.1";
  observationId: string;
  observedTime: string;
  provider: string;
  planType: TelemetryPlanType;
  planVariant: string;
  limitId: string;
  slot: string;
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
  accountPlanAttribution: TelemetryV11Attribution;
}
export interface TelemetryV11SessionDimension {
  schemaVersion: "session-dimension-v1.1";
  sessionUuid: string;
  firstEventTime: string;
  provider: string;
  toolClassCounts: Record<string, number>;
}
export type TelemetryV11Record = TelemetryV11UsageEvent | TelemetryV11QuotaObservation | TelemetryV11SessionDimension;
export interface TelemetryV11Chunk {
  schemaVersion: typeof TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION;
  manifestDigest: string;
  chunkId: string;
  chunkRevision: 1;
  chunkDigest: string;
  parserVersion: string;
  consent: TelemetryV11Consent;
  records: TelemetryV11Record[];
}
export interface TelemetryV11DayManifest {
  schemaVersion: typeof TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION;
  day: string;
  parserVersion: string;
  consent: TelemetryV11Consent;
  chunks: {chunkId: string; chunkDigest: string; recordCount: number}[];
  excluded: Record<TelemetryV11Stream, number>;
  manifestDigest: string;
}
export interface TelemetryV11Envelope {
  schemaVersion: typeof TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION;
  synthetic: false;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}
export function telemetryV11RequiredConsent(): Readonly<TelemetryV11Consent>;
export function isTelemetryV11ConsentCurrent(value: unknown): value is TelemetryV11Consent;
export function parseTelemetryV11Attribution(value: unknown): TelemetryV11Attribution;
export function parseTelemetryV11Record(stream: TelemetryV11Stream, value: unknown): TelemetryV11Record;
export function parseTelemetryV11ChunkId(value: unknown): {stream: TelemetryV11Stream; day: string; seq: number};
export function parseTelemetryV11Chunk(value: unknown): TelemetryV11Chunk;
export function parseTelemetryV11DayManifest(value: unknown): TelemetryV11DayManifest;
export function telemetryV11RecordAnchor(stream: TelemetryV11Stream, record: TelemetryV11Record): {occurrenceId: string; observedAt: string};
export function canonicalTelemetryV11Json(value: unknown): string;
export function telemetryV11DayManifestDigestInput(value: TelemetryV11DayManifest): string;
export function validateTelemetryV11Envelope(value: unknown): TelemetryV11Envelope;
export const TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION: "telemetry-domain-manifest-v1.1";
export const MAX_TELEMETRY_V11_DOMAIN_DAYS: 4096;
export interface TelemetryV11DomainManifest {
  schemaVersion: typeof TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION;
  fromDay: string;
  throughDay: string;
  predecessor: {token: string; previousGenerationId: string | null; legacyFingerprint: string};
  days: {day: string; manifestId: string; manifestDigest: string}[];
  manifestDigest: string;
}
export function parseTelemetryV11DomainManifest(value: unknown): TelemetryV11DomainManifest;
export function telemetryV11DomainManifestDigestInput(value: TelemetryV11DomainManifest): string;
