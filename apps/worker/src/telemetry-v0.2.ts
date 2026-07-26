import { ApiError } from "./errors";
import {
  validateTelemetryContribution,
  type TelemetryActivityMarker,
  type TelemetryContribution,
  type TelemetryQuotaSnapshot,
  type TelemetryUsageEvent,
} from "./telemetry-validation";

export const TELEMETRY_V02_ENABLED = false;
export const TELEMETRY_V02_CONTRIBUTION_SCHEMA_VERSION =
  "telemetry-contribution-v0.2" as const;
export const TELEMETRY_V02_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2" as const;
export const TELEMETRY_V02_ENVELOPE_SCHEMA_VERSION =
  "telemetry-envelope-v0.2" as const;

export type AccountTrackId =
  | "unattributed"
  | `account-track:v1:${string}`;

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

export type UsageAccountingDiagnosticV02 =
  TelemetryUsageEvent["accounting"] & {
  status: "untrusted_diagnostic";
  sourceSchemaVersion: "telemetry-contribution-v0.1";
};

export type ContributionAccountingDiagnosticV02 =
  TelemetryContribution["accounting"] & {
  status: "untrusted_diagnostic";
  sourceSchemaVersion: "telemetry-contribution-v0.1";
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
  schemaVersion: typeof TELEMETRY_V02_CONTRIBUTION_SCHEMA_VERSION;
  consentVersion: typeof TELEMETRY_V02_CONSENT_VERSION;
  status: "implementation_disabled";
  datasetId: `dataset:v1:${string}`;
  partIndex: number;
  partCount: number;
  completeness: "complete" | "partial";
  usageEvents: TelemetryUsageEventV02[];
  quotaSnapshots: TelemetryQuotaSnapshotV02[];
  activityMarkers: TelemetryActivityMarkerV02[];
  accountingDiagnostic: ContributionAccountingDiagnosticV02;
}

type JsonRecord = Record<string, unknown>;

const ACCOUNT_TRACK_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const DATASET_ID_PATTERN = /^dataset:v1:[a-f0-9]{64}$/u;
const PARTICIPANT_ID_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDERS = new Set(["openai_codex", "anthropic_claude_code"]);

const CONTRIBUTION_KEYS = [
  "schemaVersion",
  "consentVersion",
  "status",
  "synthetic",
  "datasetId",
  "partIndex",
  "partCount",
  "completeness",
  "createdAt",
  "coveredAt",
  "clientPlatform",
  "providerPolicyEpoch",
  "usageEvents",
  "quotaSnapshots",
  "activityMarkers",
  "accountingDiagnostic",
] as const;

const USAGE_KEYS = [
  "schemaVersion",
  "accountTrackId",
  "eventTime",
  "provider",
  "modelId",
  "modelRecognition",
  "modelFingerprint",
  "billingSurface",
  "speedMode",
  "apiServiceTier",
  "reasoningEffort",
  "components",
  "totalInputContextTokens",
  "surface",
  "agentScope",
  "lineageDisposition",
  "toolClassCounts",
  "outcome",
  "eventId",
  "accountingDiagnostic",
] as const;

const QUOTA_KEYS = [
  "schemaVersion",
  "accountTrackId",
  "observedTime",
  "receivedTime",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "slot",
  "usedPercent",
  "displayPrecision",
  "windowDurationMinutes",
  "resetsAt",
  "snapshotSource",
  "providerSurface",
  "snapshotId",
] as const;

const ACTIVITY_KEYS = [
  "schemaVersion",
  "accountTrackId",
  "observedTime",
  "provider",
  "surface",
  "state",
  "agenticPoolCoupling",
  "planType",
  "planVariant",
  "markerId",
] as const;

const USAGE_DIAGNOSTIC_KEYS = [
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricingCoveragePercent",
  "unknownBillableUnits",
  "priceBasis",
] as const;

const CONTRIBUTION_DIAGNOSTIC_KEYS = [
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricedEventCoveragePercent",
  "unknownModelEventCount",
  "unknownBillableUnits",
  "priceBasis",
] as const;

function invalid(code: "TELEMETRY_RECORD_INVALID" | "PRIVACY_CANARY_DETECTED"): never {
  throw new ApiError(400, code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function accountTrackId(value: unknown): value is AccountTrackId {
  return value === "unattributed"
    || (typeof value === "string" && ACCOUNT_TRACK_PATTERN.test(value));
}

function privacyCanary(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }
  return /(?:openai-)?account:v1:[a-f0-9]{64}/iu.test(serialized)
    || /(?:participant:|um_session_|sessionScopeId|sessionId)/iu.test(serialized)
    || /(?:accountScopeId|providerAccountId|centralParticipantId)/iu.test(serialized)
    || /"(?:prompt|response|message|command|arguments|cwd|path|url|email|username|hostname)"\s*:/iu.test(serialized)
    || /(?:\/Users\/|\/home\/|[A-Z]:\\|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/u.test(serialized);
}

function validPartMetadata(value: JsonRecord): boolean {
  return typeof value.datasetId === "string"
    && DATASET_ID_PATTERN.test(value.datasetId)
    && Number.isSafeInteger(value.partIndex)
    && Number(value.partIndex) >= 1
    && Number(value.partIndex) <= 100
    && Number.isSafeInteger(value.partCount)
    && Number(value.partCount) >= 1
    && Number(value.partCount) <= 100
    && Number(value.partIndex) <= Number(value.partCount)
    && (value.completeness === "complete" || value.completeness === "partial");
}

function validDiagnosticHeader(
  value: unknown,
  keys: readonly string[],
): value is JsonRecord {
  return exact(value, keys)
    && value.status === "untrusted_diagnostic"
    && value.sourceSchemaVersion === "telemetry-contribution-v0.1"
    && (value.priceBasis === "current_api_prices" || value.priceBasis === "unpriced");
}

function stripV02Usage(row: TelemetryUsageEventV02): TelemetryUsageEvent {
  const {
    accountTrackId: _accountTrackId,
    accountingDiagnostic,
    ...safe
  } = row;
  const {
    status: _status,
    sourceSchemaVersion: _sourceSchemaVersion,
    ...accounting
  } = accountingDiagnostic;
  return { ...safe, schemaVersion: "usage-event-v0.1", accounting };
}

function stripV02Quota(row: TelemetryQuotaSnapshotV02): TelemetryQuotaSnapshot {
  const { accountTrackId: _accountTrackId, ...safe } = row;
  return { ...safe, schemaVersion: "quota-snapshot-v0.1" };
}

function stripV02Activity(row: TelemetryActivityMarkerV02): TelemetryActivityMarker {
  const {
    accountTrackId: _accountTrackId,
    provider: _provider,
    ...safe
  } = row;
  return { ...safe, schemaVersion: "export-activity-marker-v0.1" };
}

/**
 * Validate the frozen, disabled v0.2 plaintext contract.
 *
 * This function is deliberately not called by the Worker routing or storage
 * path. Activation requires the evidence, renewed-consent, and privacy gates
 * recorded in the account-track transport decision.
 */
export function validateTelemetryContributionV02(
  value: unknown,
): TelemetryContributionV02 {
  if (privacyCanary(value)) invalid("PRIVACY_CANARY_DETECTED");
  if (!exact(value, CONTRIBUTION_KEYS)
      || value.schemaVersion !== TELEMETRY_V02_CONTRIBUTION_SCHEMA_VERSION
      || value.consentVersion !== TELEMETRY_V02_CONSENT_VERSION
      || value.status !== "implementation_disabled"
      || !validPartMetadata(value)
      || !Array.isArray(value.usageEvents)
      || value.usageEvents.length > 200
      || !Array.isArray(value.quotaSnapshots)
      || value.quotaSnapshots.length > 200
      || !Array.isArray(value.activityMarkers)
      || value.activityMarkers.length > 100
      || value.usageEvents.length
        + value.quotaSnapshots.length
        + value.activityMarkers.length < 1
      || value.usageEvents.length
        + value.quotaSnapshots.length
        + value.activityMarkers.length > 200
      || !value.usageEvents.every((row) => exact(row, USAGE_KEYS)
        && row.schemaVersion === "usage-event-v0.2"
        && accountTrackId(row.accountTrackId)
        && validDiagnosticHeader(
          row.accountingDiagnostic,
          USAGE_DIAGNOSTIC_KEYS,
        ))
      || !value.quotaSnapshots.every((row) => exact(row, QUOTA_KEYS)
        && row.schemaVersion === "quota-snapshot-v0.2"
        && accountTrackId(row.accountTrackId))
      || !value.activityMarkers.every((row) => exact(row, ACTIVITY_KEYS)
        && row.schemaVersion === "activity-marker-v0.2"
        && row.provider === "openai_codex"
        && accountTrackId(row.accountTrackId))
      || !validDiagnosticHeader(
        value.accountingDiagnostic,
        CONTRIBUTION_DIAGNOSTIC_KEYS,
      )) {
    invalid("TELEMETRY_RECORD_INVALID");
  }

  const record = value as unknown as TelemetryContributionV02;
  canonicalTelemetryContributionV01(record);
  return record;
}

/**
 * Convert the validated v0.2 transport object to the current canonical
 * server-pricing shape. Account tracks and dataset metadata remain separate
 * storage dimensions and are never discarded by the v0.2 repository.
 */
export function canonicalTelemetryContributionV01(
  record: TelemetryContributionV02,
): TelemetryContribution {
  const {
    status: _status,
    sourceSchemaVersion: _sourceSchemaVersion,
    ...accounting
  } = record.accountingDiagnostic;
  const v01Record: TelemetryContribution = {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: record.synthetic,
    createdAt: record.createdAt,
    coveredAt: record.coveredAt,
    clientPlatform: record.clientPlatform,
    providerPolicyEpoch: record.providerPolicyEpoch,
    usageEvents: record.usageEvents.map(stripV02Usage),
    quotaSnapshots: record.quotaSnapshots.map(stripV02Quota),
    activityMarkers: record.activityMarkers.map(stripV02Activity),
    accounting,
  };
  validateTelemetryContribution(v01Record);
  return v01Record;
}

export function telemetryAccountTrackPartitionKey(
  participantId: string,
  accountTrack: AccountTrackId,
  provider: TelemetryUsageEvent["provider"],
): string {
  if (!PARTICIPANT_ID_PATTERN.test(participantId)
      || !accountTrackId(accountTrack)
      || !PROVIDERS.has(provider)) {
    throw new TypeError("Invalid telemetry account-track partition");
  }
  return `${participantId.toLowerCase()}\u0000${accountTrack}\u0000${provider}`;
}
