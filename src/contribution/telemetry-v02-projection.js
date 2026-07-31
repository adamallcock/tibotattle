import { createHash } from "node:crypto";

import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  inspectTelemetryContributionDatasetV02,
  inspectTelemetryContributionV02,
} from "@app-usagemonitor/telemetry-contract";
import {
  deriveTelemetryAccountTrackId,
} from "./account-track.js";
import {
  buildTelemetryContributionsFromBundle,
} from "./telemetry-v01-projection.js";

export const TELEMETRY_CONTRIBUTION_V02_VERSION =
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION;
export const TELEMETRY_CONTRIBUTION_V02_CONSENT_VERSION =
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
export const TELEMETRY_CONTRIBUTION_V02_STATUS = "implementation_disabled";

const CENTRAL_PARTICIPANT_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BUNDLE_ID_PATTERN = /^bundle:v1:[a-f0-9]{64}$/u;
const CLIENT_PLATFORMS = new Set([
  "macos",
  "linux",
  "windows",
  "other",
  "unknown",
]);
const COVERED_KEYS = Object.freeze(["startAt", "endAt"]);
const LEGACY_V02_ERROR_ORDER = new Map([
  ["closed_shape_invalid", 0],
  ["schema_version_invalid", 1],
  ["consent_version_invalid", 2],
  ["status_invalid", 3],
  ["synthetic_invalid", 4],
  ["dataset_id_invalid", 5],
  ["part_index_invalid", 6],
  ["part_count_invalid", 7],
  ["part_range_invalid", 8],
  ["completeness_invalid", 9],
  ["created_at_invalid", 10],
  ["covered_at_invalid", 11],
  ["client_platform_invalid", 12],
  ["provider_policy_epoch_invalid", 13],
  ["usage_events_invalid", 14],
  ["quota_snapshots_invalid", 15],
  ["activity_markers_invalid", 16],
  ["record_count_invalid", 17],
  ["accounting_diagnostic_invalid", 18],
  ["private_projection_invalid", 19],
  ["canonical_v01_invalid", 20],
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
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function deriveTelemetryDatasetIdV02(bundle, centralParticipantId) {
  if (typeof centralParticipantId !== "string"
      || !CENTRAL_PARTICIPANT_PATTERN.test(centralParticipantId)) {
    throw fixedError("participant_invalid");
  }
  if (!bundle || !BUNDLE_ID_PATTERN.test(bundle.bundleId)) {
    throw fixedError("bundle_id_invalid");
  }
  if (!hasExactKeys(bundle.coveredAt, COVERED_KEYS)
      || !isCanonicalIso(bundle.coveredAt.startAt)
      || !isCanonicalIso(bundle.coveredAt.endAt)
      || bundle.coveredAt.startAt > bundle.coveredAt.endAt) {
    throw fixedError("covered_at_invalid");
  }
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

export function validateTelemetryContributionV02(value) {
  const result = inspectTelemetryContributionV02(value);
  return {
    valid: result.valid,
    errors: [...result.errors].sort((left, right) => (
      (LEGACY_V02_ERROR_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (LEGACY_V02_ERROR_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    )),
  };
}

export function validateTelemetryContributionDatasetV02(parts) {
  const result = inspectTelemetryContributionDatasetV02(parts);
  return {
    valid: result.valid,
    errors: [...result.errors],
  };
}

export function buildTelemetryContributionsV02(
  bundle,
  centralParticipantId,
  { completenessProof = null } = {},
) {
  if (!bundle
      || bundle.schemaVersion !== "usage-metadata-bundle-v0.1"
      || !isPlainObject(bundle.records)
      || !Array.isArray(bundle.records.usageEvents)
      || !Array.isArray(bundle.records.quotaSnapshots)
      || !Array.isArray(bundle.records.activityMarkers)
      || !isCanonicalIso(bundle.createdAt)
      || !CLIENT_PLATFORMS.has(bundle.clientPlatform)) {
    throw fixedError("bundle_invalid");
  }
  if (completenessProof !== null
      && (!hasExactKeys(completenessProof, ["allPartsPresent"])
        || completenessProof.allPartsPresent !== true)) {
    throw fixedError("completeness_proof_invalid");
  }

  const participant = typeof centralParticipantId === "string"
    ? centralParticipantId.toLowerCase()
    : centralParticipantId;
  const datasetId = deriveTelemetryDatasetIdV02(bundle, participant);
  const usageScopes = sourceScopeMap(bundle.records.usageEvents, "eventId");
  const quotaScopes = sourceScopeMap(
    bundle.records.quotaSnapshots,
    "snapshotId",
  );
  const activityScopes = sourceScopeMap(
    bundle.records.activityMarkers,
    "markerId",
  );
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
