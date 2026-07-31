import { createHash } from "node:crypto";

import {
  parseTelemetryContribution,
} from "@app-usagemonitor/telemetry-contract";
import { stableJson } from "../export/index.js";

export const PREPARED_CONTRIBUTION_SET_VERSION =
  "prepared-contribution-set-v0.1";
export const PREPARED_CONTRIBUTION_SET_MANIFEST =
  "prepared-contribution-set-v0.1.json";
export const PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA =
  "telemetry-contribution-v0.1";
// This is deliberately equal to the server's maximum accepted batches in one
// fixed weekly admission window. A prepared set can therefore never exceed a
// fresh window by itself; prior accepted batches may cause the remainder to
// wait until the server-advertised retry time.
export const MAX_PREPARED_CONTRIBUTION_BATCHES = 100;
export const PREPARED_CONTRIBUTION_LIMITS = Object.freeze({
  maximumActivityMarkersPerBatch: 100,
  maximumBatches: MAX_PREPARED_CONTRIBUTION_BATCHES,
  maximumContributionBytes: 1_310_720,
  maximumManifestBytes: 256 * 1024,
  maximumRecordsPerBatch: 200,
});

const CONTRIBUTION_BASENAME =
  /^telemetry-contribution-([0-9]{6})\.json$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECORD_COUNT_KEYS = Object.freeze([
  "usageEvents",
  "quotaSnapshots",
  "activityMarkers",
]);
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "builderVersion",
  "eligibleSchemaVersion",
  "batchCount",
  "files",
]);
const MANIFEST_FILE_KEYS = Object.freeze([
  "basename",
  "sha256",
  "bytes",
  "recordCounts",
]);
const ERROR_CODES = new Set([
  "directory_invalid",
  "manifest_missing",
  "manifest_invalid",
  "manifest_changed",
  "manifest_unexpected_entry",
  "file_missing",
  "file_invalid",
  "file_changed",
  "file_digest",
  "file_metadata",
  "file_schema",
  "publication_invalid",
]);

export class PreparedContributionSetError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown prepared contribution set error");
    }
    super(`Prepared contribution set failed (${code})`);
    this.name = "PreparedContributionSetError";
    this.code = `prepared_contribution_set_${code}`;
  }
}

function fail(code) {
  throw new PreparedContributionSetError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validCounts(value) {
  return exact(value, RECORD_COUNT_KEYS)
    && integer(
      value.usageEvents,
      PREPARED_CONTRIBUTION_LIMITS.maximumRecordsPerBatch,
    )
    && integer(
      value.quotaSnapshots,
      PREPARED_CONTRIBUTION_LIMITS.maximumRecordsPerBatch,
    )
    && integer(
      value.activityMarkers,
      PREPARED_CONTRIBUTION_LIMITS.maximumActivityMarkersPerBatch,
    )
    && value.usageEvents + value.quotaSnapshots + value.activityMarkers >= 1
    && value.usageEvents + value.quotaSnapshots + value.activityMarkers
      <= PREPARED_CONTRIBUTION_LIMITS.maximumRecordsPerBatch;
}

export function preparedContributionSetId(manifest) {
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

export function validatePreparedTelemetryContributionV01(value) {
  try {
    return parseTelemetryContribution(value);
  } catch {
    fail("file_schema");
  }
}

export function preparedContributionRecordCounts(value) {
  return {
    usageEvents: value.usageEvents.length,
    quotaSnapshots: value.quotaSnapshots.length,
    activityMarkers: value.activityMarkers.length,
  };
}

export function isPreparedContributionBasename(value) {
  return typeof value === "string" && CONTRIBUTION_BASENAME.test(value);
}

export function preparedContributionBasename(index) {
  if (!Number.isSafeInteger(index)
      || index < 1
      || index > PREPARED_CONTRIBUTION_LIMITS.maximumBatches) {
    fail("manifest_invalid");
  }
  return `telemetry-contribution-${String(index).padStart(6, "0")}.json`;
}

export function validatePreparedContributionFileEntry(
  value,
  { expectedIndex = null } = {},
) {
  if (!exact(value, MANIFEST_FILE_KEYS)
      || !isPreparedContributionBasename(value.basename)
      || !SHA256_PATTERN.test(value.sha256)
      || !integer(
        value.bytes,
        PREPARED_CONTRIBUTION_LIMITS.maximumContributionBytes,
      )
      || value.bytes < 1
      || !validCounts(value.recordCounts)
      || (expectedIndex !== null
        && value.basename !== preparedContributionBasename(expectedIndex))) {
    fail("manifest_invalid");
  }
  return value;
}

export function validatePreparedContributionManifest(value, builderVersion) {
  if (!exact(value, MANIFEST_KEYS)
      || value.schemaVersion !== PREPARED_CONTRIBUTION_SET_VERSION
      || value.builderVersion !== builderVersion
      || value.eligibleSchemaVersion
        !== PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA
      || !integer(
        value.batchCount,
        PREPARED_CONTRIBUTION_LIMITS.maximumBatches,
      )
      || value.batchCount < 1
      || !Array.isArray(value.files)
      || value.files.length !== value.batchCount) {
    fail("manifest_invalid");
  }
  const names = new Set();
  for (const [index, entry] of value.files.entries()) {
    validatePreparedContributionFileEntry(entry, {
      expectedIndex: index + 1,
    });
    if (names.has(entry.basename)) fail("manifest_invalid");
    names.add(entry.basename);
  }
  return value;
}
