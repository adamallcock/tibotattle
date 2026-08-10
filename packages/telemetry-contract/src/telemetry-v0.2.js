import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  MAX_TELEMETRY_BROWSER_BYTES,
} from "./constants.js";
import {
  isTelemetryContractError,
  telemetryContractFailure,
} from "./errors.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryBounded,
  isTelemetryHashId,
  isTelemetryInstant,
  isTelemetryInteger,
  isTelemetryMember,
  isTelemetryMoney,
  telemetryPrivacyCanary,
} from "./primitives.js";
import {
  parseTelemetryContribution,
} from "./telemetry-v0.1.js";

const ACCOUNT_TRACK_PATTERN =
  /^(?:unattributed|account-track:v1:[a-f0-9]{64})$/u;
const DATASET_ID_PATTERN = /^dataset:v1:[a-f0-9]{64}$/u;

const V02_CONTRIBUTION_KEYS = Object.freeze([
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
]);
const V02_USAGE_KEYS = Object.freeze([
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
]);
const V02_QUOTA_KEYS = Object.freeze([
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
]);
const V02_ACTIVITY_KEYS = Object.freeze([
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
]);
const V02_USAGE_DIAGNOSTIC_KEYS = Object.freeze([
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricingCoveragePercent",
  "unknownBillableUnits",
  "priceBasis",
]);
const V02_CONTRIBUTION_DIAGNOSTIC_KEYS = Object.freeze([
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricedEventCoveragePercent",
  "unknownModelEventCount",
  "unknownBillableUnits",
  "priceBasis",
]);
const V02_EVENT_PRICE_BASES = Object.freeze([
  "current_api_prices",
  "historical_api_prices",
  "unpriced",
]);
const V02_BATCH_PRICE_BASES = Object.freeze([
  ...V02_EVENT_PRICE_BASES,
  "mixed_api_prices",
]);

function accountTrackId(value) {
  return typeof value === "string" && ACCOUNT_TRACK_PATTERN.test(value);
}

function validUsageDiagnostic(value) {
  return hasTelemetryExactKeys(value, V02_USAGE_DIAGNOSTIC_KEYS)
    && value.status === "untrusted_diagnostic"
    && value.sourceSchemaVersion === "telemetry-contribution-v0.1"
    && isTelemetryMoney(value.estimatedApiCostUsd)
    && isTelemetryBounded(value.pricingCoveragePercent, 0, 100)
    && isTelemetryInteger(value.unknownBillableUnits, 1_000_000_000)
    && V02_EVENT_PRICE_BASES.includes(value.priceBasis);
}

function validContributionDiagnostic(value) {
  return hasTelemetryExactKeys(
    value,
    V02_CONTRIBUTION_DIAGNOSTIC_KEYS,
  )
    && value.status === "untrusted_diagnostic"
    && value.sourceSchemaVersion === "telemetry-contribution-v0.1"
    && isTelemetryMoney(value.estimatedApiCostUsd)
    && isTelemetryBounded(value.pricedEventCoveragePercent, 0, 100)
    && isTelemetryInteger(value.unknownModelEventCount, 200)
    && isTelemetryInteger(value.unknownBillableUnits, 1_000_000_000)
    && V02_BATCH_PRICE_BASES.includes(value.priceBasis);
}

function stripV02Usage(row) {
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
  return {
    ...safe,
    schemaVersion: "usage-event-v0.1",
    accounting,
  };
}

function stripV02Quota(row) {
  const {
    accountTrackId: _accountTrackId,
    ...safe
  } = row;
  return {
    ...safe,
    schemaVersion: "quota-snapshot-v0.1",
  };
}

function stripV02Activity(row) {
  const {
    accountTrackId: _accountTrackId,
    provider: _provider,
    ...safe
  } = row;
  return {
    ...safe,
    schemaVersion: "export-activity-marker-v0.1",
  };
}

function canonicalTelemetryContributionV01Validated(
  value,
  options = {},
) {
  const {
    status: _status,
    sourceSchemaVersion: _sourceSchemaVersion,
    ...accounting
  } = value.accountingDiagnostic;
  const canonical = {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: value.synthetic,
    createdAt: value.createdAt,
    coveredAt: value.coveredAt,
    clientPlatform: value.clientPlatform,
    providerPolicyEpoch: value.providerPolicyEpoch,
    usageEvents: value.usageEvents.map(stripV02Usage),
    quotaSnapshots: value.quotaSnapshots.map(stripV02Quota),
    activityMarkers: value.activityMarkers.map(stripV02Activity),
    accounting,
  };
  parseTelemetryContribution(canonical, options);
  return canonical;
}

export function canonicalTelemetryContributionV01(
  value,
  options = {},
) {
  try {
    // Inspect descriptors before any property read. This rejects accessors and
    // reflection-hostile inputs without executing user-controlled getters.
    assertTelemetryClientBounds(value, options);
    parseTelemetryContributionV02(value, options);
    return canonicalTelemetryContributionV01Validated(value, options);
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "non_json_object",
      "The export must be ordinary JSON data.",
    );
  }
}

export function inspectTelemetryContributionV02(value, {
  maxSerializedBytes = MAX_TELEMETRY_BROWSER_BYTES,
  maxDepth = 12,
  maxArrayItems = 200,
  nowEpoch = Date.now(),
} = {}) {
  const errors = [];
  if (telemetryPrivacyCanary(value)) {
    errors.push("private_projection_invalid");
  }
  const closedShape = hasTelemetryExactKeys(
    value,
    V02_CONTRIBUTION_KEYS,
  );
  if (!closedShape) {
    errors.push("closed_shape_invalid");
  }
  if (closedShape) {
    if (value.schemaVersion !== ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION) {
      errors.push("schema_version_invalid");
    }
    if (
      value.consentVersion
        !== ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
    ) {
      errors.push("consent_version_invalid");
    }
    if (value.status !== "implementation_disabled") {
      errors.push("status_invalid");
    }
    if (value.synthetic !== false) errors.push("synthetic_invalid");
    if (
      typeof value.datasetId !== "string"
      || !DATASET_ID_PATTERN.test(value.datasetId)
    ) {
      errors.push("dataset_id_invalid");
    }
    if (
      !Number.isSafeInteger(value.partIndex)
      || value.partIndex < 1
      || value.partIndex > 100
    ) {
      errors.push("part_index_invalid");
    }
    if (
      !Number.isSafeInteger(value.partCount)
      || value.partCount < 1
      || value.partCount > 100
    ) {
      errors.push("part_count_invalid");
    }
    if (
      Number.isSafeInteger(value.partIndex)
      && Number.isSafeInteger(value.partCount)
      && value.partIndex > value.partCount
    ) {
      errors.push("part_range_invalid");
    }
    if (!["complete", "partial"].includes(value.completeness)) {
      errors.push("completeness_invalid");
    }
    if (!isTelemetryInstant(value.createdAt)) {
      errors.push("created_at_invalid");
    }
    if (
      !hasTelemetryExactKeys(value.coveredAt, ["startAt", "endAt"])
      || !isTelemetryInstant(value.coveredAt?.startAt)
      || !isTelemetryInstant(value.coveredAt?.endAt)
      || Date.parse(value.coveredAt?.endAt)
        < Date.parse(value.coveredAt?.startAt)
    ) {
      errors.push("covered_at_invalid");
    }
    if (!isTelemetryMember(value.clientPlatform, [
      "macos",
      "linux",
      "windows",
      "other",
      "unknown",
    ])) {
      errors.push("client_platform_invalid");
    }
    if (!isTelemetryMember(value.providerPolicyEpoch, [
      "unknown",
      "openai_pre_agentic_pool_2026_07_09",
      "openai_agentic_pool_2026_07_09",
      "anthropic_unknown",
    ])) {
      errors.push("provider_policy_epoch_invalid");
    }
    if (
      !Array.isArray(value.usageEvents)
      || value.usageEvents.length > 200
      || !value.usageEvents.every((row) => (
        hasTelemetryExactKeys(row, V02_USAGE_KEYS)
        && row.schemaVersion === "usage-event-v0.2"
        && accountTrackId(row.accountTrackId)
        && validUsageDiagnostic(row.accountingDiagnostic)
      ))
    ) {
      errors.push("usage_events_invalid");
    }
    if (
      !Array.isArray(value.quotaSnapshots)
      || value.quotaSnapshots.length > 200
      || !value.quotaSnapshots.every((row) => (
        hasTelemetryExactKeys(row, V02_QUOTA_KEYS)
        && row.schemaVersion === "quota-snapshot-v0.2"
        && accountTrackId(row.accountTrackId)
      ))
    ) {
      errors.push("quota_snapshots_invalid");
    }
    if (
      !Array.isArray(value.activityMarkers)
      || value.activityMarkers.length > 100
      || !value.activityMarkers.every((row) => (
        hasTelemetryExactKeys(row, V02_ACTIVITY_KEYS)
        && row.schemaVersion === "activity-marker-v0.2"
        && row.provider === "openai_codex"
        && accountTrackId(row.accountTrackId)
      ))
    ) {
      errors.push("activity_markers_invalid");
    }
    if (
      Array.isArray(value.usageEvents)
      && Array.isArray(value.quotaSnapshots)
      && Array.isArray(value.activityMarkers)
      && (
        value.usageEvents.length
          + value.quotaSnapshots.length
          + value.activityMarkers.length < 1
        || value.usageEvents.length
          + value.quotaSnapshots.length
          + value.activityMarkers.length > 200
      )
    ) {
      errors.push("record_count_invalid");
    }
    if (!validContributionDiagnostic(value.accountingDiagnostic)) {
      errors.push("accounting_diagnostic_invalid");
    }
    if (errors.length === 0) {
      try {
        assertTelemetryClientBounds(value, {
          maxSerializedBytes,
          maxDepth,
          maxArrayItems,
        });
        canonicalTelemetryContributionV01Validated(value, {
          maxSerializedBytes,
          maxDepth,
          maxArrayItems,
          nowEpoch,
        });
      } catch {
        errors.push("canonical_v01_invalid");
      }
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)].sort()),
  });
}

export function parseTelemetryContributionV02(value, options = {}) {
  const result = inspectTelemetryContributionV02(value, options);
  if (!result.valid) {
    const privacy = result.errors.includes("private_projection_invalid");
    telemetryContractFailure(
      privacy
        ? "PRIVACY_CANARY_DETECTED"
        : "TELEMETRY_RECORD_INVALID",
      privacy
        ? "private_projection_invalid"
        : result.errors[0] ?? "telemetry_v02_invalid",
      privacy
        ? "The export contains a forbidden content or identity field."
        : "The export does not match the account-scoped telemetry contract.",
    );
  }
  return value;
}

export function validateAccountScopedTelemetryContribution(
  value,
  options = {},
) {
  parseTelemetryContributionV02(value, options);
  return true;
}

export function inspectTelemetryContributionDatasetV02(
  parts,
  options = {},
) {
  const errors = [];
  if (!Array.isArray(parts) || parts.length === 0) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(["parts_missing"]),
    });
  }
  for (const part of parts) {
    const result = inspectTelemetryContributionV02(part, options);
    if (!result.valid) errors.push(...result.errors);
  }
  if (errors.length === 0) {
    const first = parts[0];
    const metadata = JSON.stringify({
      datasetId: first.datasetId,
      partCount: first.partCount,
      completeness: first.completeness,
      createdAt: first.createdAt,
      coveredAt: first.coveredAt,
    });
    if (parts.some((part) => JSON.stringify({
      datasetId: part.datasetId,
      partCount: part.partCount,
      completeness: part.completeness,
      createdAt: part.createdAt,
      coveredAt: part.coveredAt,
    }) !== metadata)) {
      errors.push("dataset_metadata_inconsistent");
    }
    const indexes = new Set(parts.map((part) => part.partIndex));
    if (indexes.size !== parts.length) errors.push("part_index_duplicate");
    if (first.completeness === "complete") {
      if (
        parts.length !== first.partCount
        || Array.from(
          { length: first.partCount },
          (_, index) => index + 1,
        ).some((index) => !indexes.has(index))
      ) {
        errors.push("complete_dataset_missing_parts");
      }
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)].sort()),
  });
}
