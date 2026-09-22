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
  "codex-auto-review",
  "gpt-4-turbo-2024-04-09",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-mini",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5-pro",
  "gpt-5.6-sol-wm",
  "gpt-6-astra",
  "o1",
  "o1-pro",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
];
export type TelemetryModelId = typeof TELEMETRY_MODEL_IDS[number];

export interface ReviewedModelIdentity {
  readonly id: Exclude<TelemetryModelId, "unknown">;
  readonly label: string;
  readonly provider: "openai_codex" | "anthropic_claude_code";
  readonly allowanceTrack: "primary" | "spark";
  readonly pricingStatus: "published" | "assumed_alias" | "unpriced";
  readonly priceModelId: Exclude<TelemetryModelId, "unknown"> | null;
}
export const REVIEWED_MODEL_CATALOG_VERSION: "reviewed-model-catalog-2026-09-03.1";
export const REVIEWED_MODEL_CATALOG: readonly ReviewedModelIdentity[];
export const REVIEWED_CODEX_MODEL_IDS: readonly Exclude<TelemetryModelId, "unknown">[];
export const REVIEWED_CLAUDE_MODEL_IDS: readonly Exclude<TelemetryModelId, "unknown">[];
export function reviewedModelIdentity(value: unknown): ReviewedModelIdentity | null;
export type ReviewedModelVocabularyEntry =
  Omit<ReviewedModelIdentity, "label">;
export interface ReviewedModelCatalogCompleteness {
  readonly version: typeof REVIEWED_MODEL_CATALOG_VERSION;
  readonly identityCount: number;
  readonly modelIds: readonly string[];
  readonly identities: readonly ReviewedModelVocabularyEntry[];
}
export function assertReviewedModelCatalogCompleteness(
  options?: { catalog?: readonly ReviewedModelIdentity[] },
): ReviewedModelCatalogCompleteness;
export function codexRequestReasoningEffort(modelId: unknown, effort: unknown):
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "unknown" | null;
export function codexCacheReasoningConfiguration(modelId: unknown, effort: unknown):
  ReturnType<typeof codexRequestReasoningEffort>;

export interface AdminModelHistoryCounts {
  readonly fittedParticipantCount: number;
  readonly unstableParticipantCount: number;
  readonly staleParticipantCount: number;
  readonly refusedParticipantCount: number;
  readonly v1ParticipantCount: number;
  readonly unsupportedSourceParticipantCount: number;
}
export interface AdminModelHistoryDay extends AdminModelHistoryCounts {
  readonly day: string;
  readonly catalogVersion: string;
  readonly values: readonly (readonly [string, number, number])[];
}
export interface ExpandedAdminModelHistoryDay extends AdminModelHistoryDay {
  readonly byModel: Readonly<Record<string, Readonly<{
    capacityUsd: number | null;
    participantCount: number | null;
  }>>>;
}
export const ADMIN_MODEL_CONFIG: readonly Readonly<{
  modelId: Exclude<TelemetryModelId, "unknown">;
  label: string;
  allowanceTrack: "primary" | "spark";
  pricingStatus: "published" | "assumed_alias" | "unpriced";
}>[];
export const ADMIN_MODEL_HISTORY_CATALOG_VERSION: typeof REVIEWED_MODEL_CATALOG_VERSION;
export const LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION: "admin-model-roster-v0.2";
export function projectAdminModelHistoryDay(value: unknown): AdminModelHistoryDay | null;
export function expandAdminModelHistoryDay(value: unknown): ExpandedAdminModelHistoryDay | null;

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

export const TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION: "telemetry-contribution-v1.2";
export const TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION: "telemetry-envelope-v1.2";
export const TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION: "telemetry-day-manifest-v1.2";
export const TELEMETRY_V12_FIELD_DICTIONARY_VERSION: "telemetry-v1.2-registry-2026-09-20.1";
export const TELEMETRY_V12_PRIVACY_CONTRACT_VERSION: "ongoing-privacy-safe-telemetry-v1.2";
export const TELEMETRY_V12_CONTRACT_STATE: "staged";
export const MAX_TELEMETRY_V12_CHUNK_RECORDS: 200;
export const MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES: 1250000;
export const MAX_TELEMETRY_V12_DAY_CHUNKS: 4096;
export const MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES: 64000000;
export const MAX_TELEMETRY_V12_TIE_ORDER: 819199;
export const TELEMETRY_V12_STREAMS: readonly ["quota", "session", "usage"];
export const TELEMETRY_V12_ACCOUNT_BASES: readonly ["same_source", "provisional_marker", "unavailable"];
export const TELEMETRY_V12_PLAN_BASES: readonly ["same_source_occurrence", "provisional_marker", "conflicted", "unavailable"];
export type TelemetryV12Stream = typeof TELEMETRY_V12_STREAMS[number];
export type TelemetryV12AccountBasis = typeof TELEMETRY_V12_ACCOUNT_BASES[number];
export type TelemetryV12PlanBasis = typeof TELEMETRY_V12_PLAN_BASES[number];
export interface TelemetryV12Attribution {
  accountBasis: TelemetryV12AccountBasis;
  accountTrackId: string | null;
  planBasis: TelemetryV12PlanBasis;
  planType: TelemetryPlanType;
  planEraId: string | null;
}
export interface TelemetryV12Consent {
  telemetrySchemaVersion: typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
  fieldDictionaryVersion: typeof TELEMETRY_V12_FIELD_DICTIONARY_VERSION;
  privacyContractVersion: typeof TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
}
export interface TelemetryV12UsageEvent {
  schemaVersion: "usage-event-v1.2";
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
  accountPlanAttribution: TelemetryV12Attribution;
  boundaryFlags: 0 | 1 | 2 | 3 | null;
  tieOrder: number | null;
  cacheWriteTtl: {
    fiveMinuteTokens: number;
    oneHourTokens: number;
  } | null;
}
export interface TelemetryV12QuotaObservation {
  schemaVersion: "quota-observation-v1.2";
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
  accountPlanAttribution: TelemetryV12Attribution;
}
export interface TelemetryV12SessionDimension {
  schemaVersion: "session-dimension-v1.2";
  sessionUuid: string;
  firstEventTime: string;
  provider: string;
  toolClassCounts: Record<string, number>;
}
export type TelemetryV12Record = TelemetryV12UsageEvent | TelemetryV12QuotaObservation | TelemetryV12SessionDimension;
export interface TelemetryV12Chunk {
  schemaVersion: typeof TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION;
  manifestDigest: string;
  chunkId: string;
  chunkRevision: 1;
  chunkDigest: string;
  parserVersion: string;
  consent: TelemetryV12Consent;
  records: TelemetryV12Record[];
}
export interface TelemetryV12DayManifest {
  schemaVersion: typeof TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION;
  day: string;
  parserVersion: string;
  consent: TelemetryV12Consent;
  chunks: {chunkId: string; chunkDigest: string; recordCount: number}[];
  excluded: Record<TelemetryV12Stream, number>;
  manifestDigest: string;
}
export interface TelemetryV12Envelope {
  schemaVersion: typeof TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION;
  synthetic: false;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}
export function telemetryV12RequiredConsent(): Readonly<TelemetryV12Consent>;
export function isTelemetryV12ConsentCurrent(value: unknown): value is TelemetryV12Consent;
export function parseTelemetryV12Attribution(value: unknown): TelemetryV12Attribution;
export function parseTelemetryV12Record(stream: TelemetryV12Stream, value: unknown): TelemetryV12Record;
export function parseTelemetryV12ChunkId(value: unknown): {stream: TelemetryV12Stream; day: string; seq: number};
export function parseTelemetryV12Chunk(value: unknown): TelemetryV12Chunk;
export function parseTelemetryV12DayManifest(value: unknown): TelemetryV12DayManifest;
export function validateTelemetryV12DayUsageOrder(day: string, records: readonly TelemetryV12UsageEvent[]): readonly TelemetryV12UsageEvent[];
export function telemetryV12RecordAnchor(stream: TelemetryV12Stream, record: TelemetryV12Record): {occurrenceId: string; observedAt: string};
export function canonicalTelemetryV12Json(value: unknown): string;
export function telemetryV12DayManifestDigestInput(value: TelemetryV12DayManifest): string;
export function validateTelemetryV12Envelope(value: unknown): TelemetryV12Envelope;
export const TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION: "telemetry-domain-manifest-v1.2";
export const MAX_TELEMETRY_V12_DOMAIN_DAYS: 4096;
export interface TelemetryV12DomainManifest {
  schemaVersion: typeof TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION;
  fromDay: string;
  throughDay: string;
  predecessor: {token: string; previousGenerationId: string | null; legacyFingerprint: string};
  days: {day: string; manifestId: string; manifestDigest: string}[];
  manifestDigest: string;
}
export function parseTelemetryV12DomainManifest(value: unknown): TelemetryV12DomainManifest;
export function telemetryV12DomainManifestDigestInput(value: TelemetryV12DomainManifest): string;

export const PERFORMANCE_RECORD_SCHEMA_VERSION: "model-performance-daily-v1";
export const PERFORMANCE_MEASUREMENT_VERSION: "model-performance-samples-v1";
export const PERFORMANCE_BUCKET_SCHEME_VERSION: "performance-histogram-v1";
export const PERFORMANCE_FIELD_DICTIONARY_VERSION: "telemetry-performance-registry-2026-09-21.1";
export const PERFORMANCE_PRIVACY_CONTRACT_VERSION: "privacy-safe-model-performance-v1";
export const PERFORMANCE_CONTRACT_STATE: "staged";
export const PERFORMANCE_HISTOGRAM_SCHEMA_VERSION: "performance-histogram-v1";
export const MAX_PERFORMANCE_RECORD_CANONICAL_BYTES: 32768;
export const MAX_PERFORMANCE_HISTOGRAM_BUCKETS: 61;
export const MAX_PERFORMANCE_COUNT: 9007199254740991;
export const MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND: 9007199254740991;
export const MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS: 9007199254740991;
export const MAX_PERFORMANCE_TTFT_MILLISECONDS: 9007199254740991;
export const PERFORMANCE_API_SERVICE_TIERS: readonly [
  "standard", "priority", "flex", "batch", "unknown", "other", "mixed"
];
export const PERFORMANCE_SPEED_METHODS: readonly ["receipt", "legacy", "tool_free", "unavailable"];
export const PERFORMANCE_SPEED_MODE_SOURCES: readonly [
  "rollout_thread_settings", "turn_context_service_tier", "lineage_inherited",
  "unobserved", "mixed"
];
export const PERFORMANCE_SPEED_MODES: readonly [
  "fast", "standard", "unknown", "other", "mixed"
];
export const PERFORMANCE_REASONING_EFFORTS: readonly [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"
];
export type PerformanceSpeedMethod = typeof PERFORMANCE_SPEED_METHODS[number];
export type PerformanceReasoningEffort = typeof PERFORMANCE_REASONING_EFFORTS[number];
export type PerformanceSpeedMode = typeof PERFORMANCE_SPEED_MODES[number];
export type PerformanceSpeedModeSource = typeof PERFORMANCE_SPEED_MODE_SOURCES[number];
export type PerformanceApiServiceTier = typeof PERFORMANCE_API_SERVICE_TIERS[number];
export type PerformanceHistogramMetric = "speed" | "ttft" | "turnDuration";
export interface PerformanceHistogram {
  schemaVersion: typeof PERFORMANCE_HISTOGRAM_SCHEMA_VERSION;
  metric: PerformanceHistogramMetric;
  sampleCount: number;
  buckets: Readonly<Record<string, number>>;
  min: number | null;
  max: number | null;
}
export interface PerformanceHistogramQuantileBand {
  estimate: number;
  lower: number;
  upper: number;
}
export interface PerformanceHistogramQuantiles {
  methodVersion: "performance-histogram-type7-bounds-v1";
  approximate: true;
  unit: "tokens_per_second" | "milliseconds";
  sampleCount: number;
  p10: PerformanceHistogramQuantileBand | null;
  p25: PerformanceHistogramQuantileBand | null;
  median: PerformanceHistogramQuantileBand | null;
  p75: PerformanceHistogramQuantileBand | null;
  p90: PerformanceHistogramQuantileBand | null;
}
export const PERFORMANCE_HISTOGRAM_SCHEME_VERSION: "performance-histogram-v1";
export const SPEED_BUCKET_UPPER_CENTI_TPS: readonly number[];
export const TTFT_BUCKET_UPPER_MS: readonly number[];
export const TURN_DURATION_BUCKET_UPPER_MS: readonly number[];
export function buildPerformanceHistogram(
  metric: PerformanceHistogramMetric,
  values: readonly number[],
): PerformanceHistogram;
export function mergePerformanceHistograms(
  histograms: readonly PerformanceHistogram[],
): PerformanceHistogram;
export function parsePerformanceHistogram(value: unknown): PerformanceHistogram;
export function performanceHistogramQuantiles(value: unknown): PerformanceHistogramQuantiles;
export interface TelemetryPerformanceRecord {
  schemaVersion: typeof PERFORMANCE_RECORD_SCHEMA_VERSION;
  day: string;
  provider: string;
  modelId: string;
  reasoningEffort: PerformanceReasoningEffort;
  speedMethod: PerformanceSpeedMethod;
  speedMode: PerformanceSpeedMode;
  speedModeSource: PerformanceSpeedModeSource;
  apiServiceTier: PerformanceApiServiceTier;
  measurementVersion: typeof PERFORMANCE_MEASUREMENT_VERSION;
  bucketSchemeVersion: typeof PERFORMANCE_BUCKET_SCHEME_VERSION;
  turns: number;
  speedTurns: number;
  ttftTurns: number;
  completionTurns: number;
  timedResponses: number;
  speedTokens: number;
  speedDurationMs: number;
  speedHistogram: PerformanceHistogram;
  ttftHistogram: PerformanceHistogram;
  completionHistogram: PerformanceHistogram;
}
export function parseTelemetryPerformanceHistogram(value: unknown): PerformanceHistogram;
export function parseTelemetryPerformanceRecord(value: unknown): TelemetryPerformanceRecord;
export function canonicalTelemetryPerformanceJson(value: unknown): string;
export function telemetryPerformanceRowDigestInput(value: TelemetryPerformanceRecord): string;
