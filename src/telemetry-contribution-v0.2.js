import { createHash } from "node:crypto";
import { buildTelemetryContributionsFromBundle } from "./telemetry-contribution-builder.js";
import {
  deriveTelemetryAccountTrackId,
  isTelemetryAccountTrackId,
} from "./telemetry-account-track.js";

export const TELEMETRY_CONTRIBUTION_V02_VERSION = "telemetry-contribution-v0.2";
export const TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2";
export const TELEMETRY_CONTRIBUTION_V02_STATUS = "implementation_disabled";

const CENTRAL_PARTICIPANT_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BUNDLE_ID_PATTERN = /^bundle:v1:[a-f0-9]{64}$/u;
const DATASET_ID_PATTERN = /^dataset:v1:[a-f0-9]{64}$/u;
const LOCAL_SCOPE_PATTERN = /account:v1:[a-f0-9]{64}/u;
const PRIVATE_KEY_PATTERN =
  /^(?:accountScopeId|participantId|sessionScopeId|providerStateId|path|content|email|capabilities)$/iu;
const CONTENT_PATTERN =
  /(?:\/Users\/|\/home\/|file:\/\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu;
const USD_PATTERN = /^(?:0|[1-9]\d*)\.\d{6}$/u;
const ID_PATTERNS = Object.freeze({
  eventId: /^event:v2:[a-f0-9]{64}$/u,
  snapshotId: /^snapshot:v2:[a-f0-9]{64}$/u,
  markerId: /^marker:v2:[a-f0-9]{64}$/u,
});
const PROVIDERS = new Set(["openai_codex", "anthropic_claude_code"]);
const CLIENT_PLATFORMS = new Set(["macos", "linux", "windows", "other", "unknown"]);
const PROVIDER_POLICY_EPOCHS = new Set([
  "openai_pre_agentic_pool_2026_07_09",
  "openai_agentic_pool_2026_07_09",
  "anthropic_unknown",
  "unknown",
]);
const COMPONENT_KEYS = Object.freeze([
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite5mTokens",
  "inputCacheWrite1hTokens",
  "outputTextTokens",
  "outputReasoningTokens",
  "outputCombinedTokens",
]);
const TOOL_KEYS = Object.freeze([
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
const COVERED_KEYS = Object.freeze(["startAt", "endAt"]);
const USAGE_ACCOUNTING_KEYS = Object.freeze([
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricingCoveragePercent",
  "unknownBillableUnits",
  "priceBasis",
]);
const DATASET_ACCOUNTING_KEYS = Object.freeze([
  "status",
  "sourceSchemaVersion",
  "estimatedApiCostUsd",
  "pricedEventCoveragePercent",
  "unknownModelEventCount",
  "unknownBillableUnits",
  "priceBasis",
]);
const USAGE_KEYS = Object.freeze([
  "schemaVersion",
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
  "accountTrackId",
  "accountingDiagnostic",
]);
const QUOTA_KEYS = Object.freeze([
  "schemaVersion",
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
  "accountTrackId",
]);
const ACTIVITY_KEYS = Object.freeze([
  "schemaVersion",
  "observedTime",
  "provider",
  "surface",
  "state",
  "agenticPoolCoupling",
  "planType",
  "planVariant",
  "markerId",
  "accountTrackId",
]);
const CONTRIBUTION_KEYS = Object.freeze([
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

function fixedError(code) {
  const error = new Error(`Telemetry contribution v0.2 failed (${code})`);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isCanonicalIso(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function isNullableSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function scanPrivateProjection(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (
        LOCAL_SCOPE_PATTERN.test(current)
        || CENTRAL_PARTICIPANT_PATTERN.test(current)
        || CONTENT_PATTERN.test(current)
      ) return false;
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (PRIVATE_KEY_PATTERN.test(key)) return false;
      stack.push(child);
    }
  }
  return true;
}

function usageAccountingDiagnostic(accounting) {
  return {
    status: "untrusted_diagnostic",
    sourceSchemaVersion: "telemetry-contribution-v0.1",
    estimatedApiCostUsd: accounting.estimatedApiCostUsd,
    pricingCoveragePercent: accounting.pricingCoveragePercent,
    unknownBillableUnits: accounting.unknownBillableUnits,
    priceBasis: accounting.priceBasis,
  };
}

function datasetAccountingDiagnostic(accounting) {
  return {
    status: "untrusted_diagnostic",
    sourceSchemaVersion: "telemetry-contribution-v0.1",
    estimatedApiCostUsd: accounting.estimatedApiCostUsd,
    pricedEventCoveragePercent: accounting.pricedEventCoveragePercent,
    unknownModelEventCount: accounting.unknownModelEventCount,
    unknownBillableUnits: accounting.unknownBillableUnits,
    priceBasis: accounting.priceBasis,
  };
}

function sourceScopeMap(records, idKey) {
  const result = new Map();
  for (const record of records) {
    const id = record?.[idKey];
    const scope = record?.accountScopeId;
    if (typeof id !== "string" || typeof scope !== "string") {
      throw fixedError("bundle_scope_invalid");
    }
    if (result.has(id) && result.get(id) !== scope) {
      throw fixedError("bundle_scope_ambiguous");
    }
    result.set(id, scope);
  }
  return result;
}

function transformUsage(record, localScope, participantId) {
  const {
    accounting,
    schemaVersion: _schemaVersion,
    ...safe
  } = record;
  return {
    schemaVersion: "usage-event-v0.2",
    ...safe,
    accountTrackId: deriveTelemetryAccountTrackId(
      localScope,
      participantId,
      record.provider,
    ),
    accountingDiagnostic: usageAccountingDiagnostic(accounting),
  };
}

function transformQuota(record, localScope, participantId) {
  const { schemaVersion: _schemaVersion, ...safe } = record;
  return {
    schemaVersion: "quota-snapshot-v0.2",
    ...safe,
    accountTrackId: deriveTelemetryAccountTrackId(
      localScope,
      participantId,
      record.provider,
    ),
  };
}

function transformActivity(record, localScope, participantId) {
  const { schemaVersion: _schemaVersion, ...safe } = record;
  const provider = "openai_codex";
  return {
    schemaVersion: "activity-marker-v0.2",
    ...safe,
    provider,
    accountTrackId: deriveTelemetryAccountTrackId(
      localScope,
      participantId,
      provider,
    ),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function deriveTelemetryDatasetIdV02(bundle, centralParticipantId) {
  if (
    typeof centralParticipantId !== "string"
    || !CENTRAL_PARTICIPANT_PATTERN.test(centralParticipantId)
  ) throw fixedError("participant_invalid");
  if (!bundle || !BUNDLE_ID_PATTERN.test(bundle.bundleId)) {
    throw fixedError("bundle_id_invalid");
  }
  if (
    !hasExactKeys(bundle.coveredAt, COVERED_KEYS)
    || !isCanonicalIso(bundle.coveredAt.startAt)
    || !isCanonicalIso(bundle.coveredAt.endAt)
    || bundle.coveredAt.startAt > bundle.coveredAt.endAt
  ) throw fixedError("covered_at_invalid");
  const digest = createHash("sha256")
    .update("app-usagemonitor/telemetry-dataset/v0.2\u0000", "utf8")
    .update(centralParticipantId.toLowerCase(), "utf8")
    .update("\u0000", "utf8")
    .update(bundle.bundleId, "utf8")
    .update("\u0000", "utf8")
    .update(bundle.coveredAt.startAt, "utf8")
    .update("\u0000", "utf8")
    .update(bundle.coveredAt.endAt, "utf8")
    .digest("hex");
  return `dataset:v1:${digest}`;
}

function validUsageAccounting(value) {
  return hasExactKeys(value, USAGE_ACCOUNTING_KEYS)
    && value.status === "untrusted_diagnostic"
    && value.sourceSchemaVersion === "telemetry-contribution-v0.1"
    && (value.estimatedApiCostUsd === null || USD_PATTERN.test(value.estimatedApiCostUsd))
    && Number.isFinite(value.pricingCoveragePercent)
    && value.pricingCoveragePercent >= 0
    && value.pricingCoveragePercent <= 100
    && Number.isSafeInteger(value.unknownBillableUnits)
    && value.unknownBillableUnits >= 0
    && ["current_api_prices", "unpriced"].includes(value.priceBasis);
}

function validDatasetAccounting(value) {
  return hasExactKeys(value, DATASET_ACCOUNTING_KEYS)
    && value.status === "untrusted_diagnostic"
    && value.sourceSchemaVersion === "telemetry-contribution-v0.1"
    && (value.estimatedApiCostUsd === null || USD_PATTERN.test(value.estimatedApiCostUsd))
    && Number.isFinite(value.pricedEventCoveragePercent)
    && value.pricedEventCoveragePercent >= 0
    && value.pricedEventCoveragePercent <= 100
    && Number.isSafeInteger(value.unknownModelEventCount)
    && value.unknownModelEventCount >= 0
    && Number.isSafeInteger(value.unknownBillableUnits)
    && value.unknownBillableUnits >= 0
    && ["current_api_prices", "unpriced"].includes(value.priceBasis);
}

function validUsage(value) {
  return hasExactKeys(value, USAGE_KEYS)
    && value.schemaVersion === "usage-event-v0.2"
    && isCanonicalIso(value.eventTime)
    && PROVIDERS.has(value.provider)
    && typeof value.modelId === "string"
    && ["recognized", "unrecognized", "missing"].includes(value.modelRecognition)
    && (value.modelFingerprint === null
      || /^model:v1:[a-f0-9]{64}$/u.test(value.modelFingerprint))
    && ["chatgpt_subscription", "openai_api", "claude_subscription", "unknown"]
      .includes(value.billingSurface)
    && ["standard", "fast", "unknown", "other"].includes(value.speedMode)
    && ["standard", "priority", "flex", "batch", "unknown", "other"]
      .includes(value.apiServiceTier)
    && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]
      .includes(value.reasoningEffort)
    && hasExactKeys(value.components, COMPONENT_KEYS)
    && COMPONENT_KEYS.every((key) => isNullableSafeInteger(value.components[key]))
    && isNullableSafeInteger(value.totalInputContextTokens)
    && ["scheduled_task", "subagent", "extension_or_ide", "cli_exec",
      "local_interactive_unclassified", "local_rollout_unclassified"].includes(value.surface)
    && ["root", "subagent", "automation", "unknown"].includes(value.agentScope)
    && ["standalone", "forked", "parent_linked"].includes(value.lineageDisposition)
    && hasExactKeys(value.toolClassCounts, TOOL_KEYS)
    && TOOL_KEYS.every((key) => Number.isSafeInteger(value.toolClassCounts[key])
      && value.toolClassCounts[key] >= 0)
    && ["completed", "failed", "cancelled", "interrupted", "retry", "unknown"]
      .includes(value.outcome)
    && ID_PATTERNS.eventId.test(value.eventId)
    && isTelemetryAccountTrackId(value.accountTrackId)
    && validUsageAccounting(value.accountingDiagnostic);
}

function validQuota(value) {
  return hasExactKeys(value, QUOTA_KEYS)
    && value.schemaVersion === "quota-snapshot-v0.2"
    && isCanonicalIso(value.observedTime)
    && isCanonicalIso(value.receivedTime)
    && PROVIDERS.has(value.provider)
    && ["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"]
      .includes(value.planType)
    && ["pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown"]
      .includes(value.planVariant)
    && ["unknown", "codex", "codex-spark"].includes(value.limitId)
    && ["primary", "secondary", "five_hour", "seven_day", "other", "unknown"]
      .includes(value.slot)
    && Number.isFinite(value.usedPercent)
    && value.usedPercent >= 0
    && value.usedPercent <= 100
    && Number.isSafeInteger(value.displayPrecision)
    && value.displayPrecision >= 0
    && value.displayPrecision <= 6
    && Number.isSafeInteger(value.windowDurationMinutes)
    && value.windowDurationMinutes > 0
    && isCanonicalIso(value.resetsAt)
    && ["rollout", "app_server_read", "status_line", "ui_declaration", "notification"]
      .includes(value.snapshotSource)
    && ["account_shared_unallocated", "general_usage", "model_specific",
      "separate_limit", "unknown"].includes(value.providerSurface)
    && ID_PATTERNS.snapshotId.test(value.snapshotId)
    && isTelemetryAccountTrackId(value.accountTrackId);
}

function validActivity(value) {
  return hasExactKeys(value, ACTIVITY_KEYS)
    && value.schemaVersion === "activity-marker-v0.2"
    && isCanonicalIso(value.observedTime)
    && value.provider === "openai_codex"
    && typeof value.surface === "string"
    && ["start", "end", "pulse"].includes(value.state)
    && typeof value.agenticPoolCoupling === "string"
    && ["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"]
      .includes(value.planType)
    && ["pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown"]
      .includes(value.planVariant)
    && ID_PATTERNS.markerId.test(value.markerId)
    && isTelemetryAccountTrackId(value.accountTrackId);
}

export function validateTelemetryContributionV02(value) {
  const errors = [];
  if (!hasExactKeys(value, CONTRIBUTION_KEYS)) errors.push("closed_shape_invalid");
  if (errors.length === 0) {
    if (value.schemaVersion !== TELEMETRY_CONTRIBUTION_V02_VERSION) {
      errors.push("schema_version_invalid");
    }
    if (value.consentVersion !== TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION) {
      errors.push("consent_version_invalid");
    }
    if (value.status !== TELEMETRY_CONTRIBUTION_V02_STATUS) errors.push("status_invalid");
    if (value.synthetic !== false) errors.push("synthetic_invalid");
    if (!DATASET_ID_PATTERN.test(value.datasetId)) errors.push("dataset_id_invalid");
    if (!Number.isSafeInteger(value.partIndex) || value.partIndex < 1
      || value.partIndex > 100) {
      errors.push("part_index_invalid");
    }
    if (!Number.isSafeInteger(value.partCount) || value.partCount < 1
      || value.partCount > 100) {
      errors.push("part_count_invalid");
    }
    if (value.partIndex > value.partCount) errors.push("part_range_invalid");
    if (!["complete", "partial"].includes(value.completeness)) {
      errors.push("completeness_invalid");
    }
    if (!isCanonicalIso(value.createdAt)) errors.push("created_at_invalid");
    if (
      !hasExactKeys(value.coveredAt, COVERED_KEYS)
      || !isCanonicalIso(value.coveredAt.startAt)
      || !isCanonicalIso(value.coveredAt.endAt)
      || value.coveredAt.startAt > value.coveredAt.endAt
    ) errors.push("covered_at_invalid");
    if (!CLIENT_PLATFORMS.has(value.clientPlatform)) errors.push("client_platform_invalid");
    if (!PROVIDER_POLICY_EPOCHS.has(value.providerPolicyEpoch)) {
      errors.push("provider_policy_epoch_invalid");
    }
    if (!Array.isArray(value.usageEvents)
      || value.usageEvents.length > 200
      || !value.usageEvents.every(validUsage)) {
      errors.push("usage_events_invalid");
    }
    if (!Array.isArray(value.quotaSnapshots)
      || value.quotaSnapshots.length > 200
      || !value.quotaSnapshots.every(validQuota)) {
      errors.push("quota_snapshots_invalid");
    }
    if (!Array.isArray(value.activityMarkers)
      || value.activityMarkers.length > 100
      || !value.activityMarkers.every(validActivity)) {
      errors.push("activity_markers_invalid");
    }
    if (Array.isArray(value.usageEvents)
      && Array.isArray(value.quotaSnapshots)
      && Array.isArray(value.activityMarkers)
      && (
        value.usageEvents.length
          + value.quotaSnapshots.length
          + value.activityMarkers.length < 1
        || value.usageEvents.length
          + value.quotaSnapshots.length
          + value.activityMarkers.length > 200
      )) {
      errors.push("record_count_invalid");
    }
    if (!validDatasetAccounting(value.accountingDiagnostic)) {
      errors.push("accounting_diagnostic_invalid");
    }
    if (!scanPrivateProjection(value)) errors.push("private_projection_invalid");
  }
  return { valid: errors.length === 0, errors };
}

export function validateTelemetryContributionDatasetV02(parts) {
  const errors = [];
  if (!Array.isArray(parts) || parts.length === 0) {
    return { valid: false, errors: ["parts_missing"] };
  }
  for (const part of parts) {
    const result = validateTelemetryContributionV02(part);
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
    }) !== metadata)) errors.push("dataset_metadata_inconsistent");
    const indexes = new Set(parts.map((part) => part.partIndex));
    if (indexes.size !== parts.length) errors.push("part_index_duplicate");
    if (first.completeness === "complete") {
      if (
        parts.length !== first.partCount
        || Array.from({ length: first.partCount }, (_, index) => index + 1)
          .some((index) => !indexes.has(index))
      ) errors.push("complete_dataset_missing_parts");
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort() };
}

export function buildTelemetryContributionsV02(
  bundle,
  centralParticipantId,
  { completenessProof = null } = {},
) {
  if (
    !bundle
    || bundle.schemaVersion !== "usage-metadata-bundle-v0.1"
    || !isPlainObject(bundle.records)
    || !Array.isArray(bundle.records.usageEvents)
    || !Array.isArray(bundle.records.quotaSnapshots)
    || !Array.isArray(bundle.records.activityMarkers)
    || !isCanonicalIso(bundle.createdAt)
    || !CLIENT_PLATFORMS.has(bundle.clientPlatform)
  ) throw fixedError("bundle_invalid");
  if (
    completenessProof !== null
    && (!hasExactKeys(completenessProof, ["allPartsPresent"])
      || completenessProof.allPartsPresent !== true)
  ) throw fixedError("completeness_proof_invalid");

  const participant = typeof centralParticipantId === "string"
    ? centralParticipantId.toLowerCase()
    : centralParticipantId;
  const datasetId = deriveTelemetryDatasetIdV02(bundle, participant);
  const usageScopes = sourceScopeMap(bundle.records.usageEvents, "eventId");
  const quotaScopes = sourceScopeMap(bundle.records.quotaSnapshots, "snapshotId");
  const activityScopes = sourceScopeMap(bundle.records.activityMarkers, "markerId");
  const v01Parts = buildTelemetryContributionsFromBundle(bundle);
  const completeness = completenessProof === null ? "partial" : "complete";
  const parts = v01Parts.map((part, index) => {
    const value = {
      schemaVersion: TELEMETRY_CONTRIBUTION_V02_VERSION,
      consentVersion: TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION,
      status: TELEMETRY_CONTRIBUTION_V02_STATUS,
      synthetic: false,
      datasetId,
      partIndex: index + 1,
      partCount: v01Parts.length,
      completeness,
      createdAt: part.createdAt,
      coveredAt: structuredClone(part.coveredAt),
      clientPlatform: part.clientPlatform,
      providerPolicyEpoch: part.providerPolicyEpoch,
      usageEvents: part.usageEvents.map((record) => transformUsage(
        record,
        usageScopes.get(record.eventId),
        participant,
      )),
      quotaSnapshots: part.quotaSnapshots.map((record) => transformQuota(
        record,
        quotaScopes.get(record.snapshotId),
        participant,
      )),
      activityMarkers: part.activityMarkers.map((record) => transformActivity(
        record,
        activityScopes.get(record.markerId),
        participant,
      )),
      accountingDiagnostic: datasetAccountingDiagnostic(part.accounting),
    };
    const validation = validateTelemetryContributionV02(value);
    if (!validation.valid) throw fixedError(validation.errors[0]);
    return deepFreeze(value);
  });
  const datasetValidation = validateTelemetryContributionDatasetV02(parts);
  if (!datasetValidation.valid) throw fixedError(datasetValidation.errors[0]);
  return Object.freeze(parts);
}
