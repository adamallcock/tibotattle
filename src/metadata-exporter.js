import { platform } from "node:os";
import { resolve } from "node:path";
import {
  deriveParticipantId,
  randomBundleId,
} from "./export-identity.js";
import { verifyPrivacySafeBundle } from "./export-privacy.js";
import { assertValidExportRecord } from "./export-schema.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import { stableJson, writeOwnerOnlyPairNoClobber } from "./storage.js";
import { createExportResourceGuard } from "./export-resource-policy.js";
import { normalizeExportBounds, scanCodexSafeRecords } from "./export-safe-records.js";

function boundedIso(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function platformName() {
  if (platform() === "darwin") return "macos";
  if (platform() === "linux") return "linux";
  if (platform() === "win32") return "windows";
  return "other";
}

export {
  quotaObservationIdentitySubject,
  quotaStateIdentitySubject,
  usageEventIdentitySubject,
} from "./export-safe-records.js";

export async function buildLocalMetadataBundle({
  startAt,
  endAt,
  codexHome,
  secret,
  activityMarkers = [],
  createdAt = new Date().toISOString(),
  bundleId = randomBundleId(),
  forbiddenSourceValues = [],
  resourceLimits = {},
  resourceClock = () => Date.now(),
  resourceRss = () => process.memoryUsage().rss,
  resourceGuard: suppliedResourceGuard = null,
  signal = null,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  signal?.throwIfAborted?.();
  const bounds = normalizeExportBounds(startAt, endAt);
  if (suppliedResourceGuard && Object.keys(resourceLimits).length > 0) {
    throw new TypeError("Provide either a resource guard or resource limit overrides, not both");
  }
  const resourceGuard = suppliedResourceGuard ?? createExportResourceGuard({
      limits: resourceLimits,
      clock: resourceClock,
      rss: resourceRss,
    });
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  const usageEvents = [];
  const quotaSnapshotsById = new Map();
  const safeMarkers = [];
  const scan = await scanCodexSafeRecords({
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    codexHome,
    secret,
    activityMarkers,
    onRecord({ recordType, record }) {
      if (recordType === "usageEvent") usageEvents.push(record);
      else if (recordType === "quotaSnapshot") quotaSnapshotsById.set(record.snapshotId, record);
      else if (recordType === "activityMarker") safeMarkers.push(record);
      else throw new Error(`Unsupported safe record type: ${recordType}`);
    },
    resourceGuard,
    signal,
  });
  signal?.throwIfAborted?.();

  const compatibility = exportCompatibilityTuple();
  safeMarkers
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.markerId.localeCompare(right.markerId));
  usageEvents.sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId));
  const quotaSnapshots = [...quotaSnapshotsById.values()]
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.snapshotId.localeCompare(right.snapshotId));
  const recordCounts = {
    usageEvents: usageEvents.length,
    quotaSnapshots: quotaSnapshots.length,
    activityMarkers: safeMarkers.length,
  };
  const bundle = {
    schemaVersion: "usage-metadata-bundle-v0.1",
    compatibility,
    bundleId,
    participantId: deriveParticipantId(secret),
    createdAt: boundedIso(createdAt, "createdAt"),
    coveredAt: { startAt: bounds.startAt, endAt: bounds.endAt },
    sourceProviders: ["openai_codex"],
    clientPlatform: platformName(),
    transportReady: false,
    recordCounts,
    records: { usageEvents, quotaSnapshots, activityMarkers: safeMarkers },
    diagnostics: scan.diagnostics,
  };
  assertValidExportRecord("bundle", bundle);
  resourceGuard.observeCanonicalBundle(Buffer.byteLength(stableJson(bundle), "utf8"));
  const receipt = verifyPrivacySafeBundle(bundle, { createdAt: bundle.createdAt, forbiddenSourceValues });
  return { bundle, receipt, resourceUsage: resourceGuard.snapshot() };
}

export function renderMetadataExportPreview({ bundle, receipt, resourceUsage = null }) {
  const checks = receipt.checks.map((check) => `  ${check.code}: ${check.status} (${check.violations})`).join("\n");
  return [
    "Local metadata export preview",
    `Coverage: ${bundle.coveredAt.startAt} to ${bundle.coveredAt.endAt}`,
    `Usage events: ${bundle.recordCounts.usageEvents}`,
    `Quota snapshots: ${bundle.recordCounts.quotaSnapshots}`,
    `Activity markers: ${bundle.recordCounts.activityMarkers}`,
    `Source files scanned: ${bundle.diagnostics.sourceFilesScanned}`,
    `Privacy verdict: ${receipt.verdict}`,
    checks,
    `Bundle bytes: ${receipt.bundleBytes}`,
    `Resource policy: ${resourceUsage?.policyVersion ?? "unavailable"}`,
    `Resource records: ${resourceUsage?.counters.outputRecords ?? bundle.recordCounts.usageEvents + bundle.recordCounts.quotaSnapshots + bundle.recordCounts.activityMarkers}`,
    "Upload: disabled (transportReady=false)",
  ].join("\n");
}

export async function writeLocalMetadataBundle({ bundle, receipt, outputFile, receiptFile } = {}) {
  if (!outputFile || !receiptFile) throw new Error("outputFile and receiptFile are required");
  const output = resolve(outputFile);
  const receiptOutput = resolve(receiptFile);
  await writeOwnerOnlyPairNoClobber({
    firstPath: output,
    firstContent: stableJson(bundle),
    secondPath: receiptOutput,
    secondContent: stableJson(receipt),
  });
  return { outputFile: output, receiptFile: receiptOutput };
}
