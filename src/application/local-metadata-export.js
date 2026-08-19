import {
  assertValidExportRecord,
  createCodexCheckpointStateContext,
  createExportResourceGuard,
  createPrivacySafeBundleVerifier,
  createSafeRecordsContext,
  stableJson,
} from "../export/index.js";
import { isProxy } from "node:util/types";
import { validateClaudeStatusSnapshot } from "../providers/claude/statusline.js";
import { createLocalCodexLogScanner } from "./local-codex-log-scanner.js";

function requirePort(configuration, name) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) {
    throw new TypeError("local metadata export configuration is required");
  }
  let value;
  try {
    value = configuration[name];
  } catch {
    throw new TypeError(`local metadata export configuration.${name} is required`);
  }
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError(`local metadata export configuration.${name} must be a function`);
  }
  return value;
}

function requireObject(configuration, name) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) {
    throw new TypeError("local metadata export configuration is required");
  }
  let value;
  try {
    value = configuration[name];
  } catch {
    throw new TypeError(`local metadata export configuration.${name} is required`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`local metadata export configuration.${name} is required`);
  }
  return value;
}

const WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION =
  "windows-review-pair-storage-v1";
const WINDOWS_REVIEW_PAIR_STORAGE_METHODS = Object.freeze([
  "writeReviewPair",
  "readReviewPair",
  "recoverReviewPairTransactions",
  "recoverOwnerOnlyPairTransactions",
  "writeOwnerOnlyPairNoClobber",
  "readOwnerOnlyLocalMetadataBundlePair",
]);

function requireOptionalPort(configuration, name) {
  if (!configuration || typeof configuration !== "object"
      || Array.isArray(configuration) || isProxy(configuration)) {
    throw new TypeError("local metadata export configuration is required");
  }
  const descriptor = Object.getOwnPropertyDescriptor(configuration, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function"
      || isProxy(descriptor.value)) {
    throw new TypeError(`local metadata export configuration.${name} must be a function`);
  }
  return descriptor.value;
}

function ownValue(object, name, message) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(message);
  }
  return descriptor.value;
}

function reviewPairStoragePort(configuration) {
  const descriptor = Object.getOwnPropertyDescriptor(configuration, "reviewPairStorage");
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError("Windows review pair storage is invalid");
  }
  const storage = descriptor.value;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)
      || isProxy(storage)) {
    throw new TypeError("Windows review pair storage is invalid");
  }

  const validator = requireOptionalPort(configuration, "reviewPairStorageValidator");
  if (!validator) {
    throw new TypeError("Windows review pair storage validator is required");
  }
  let reviewed;
  try {
    reviewed = Reflect.apply(validator, undefined, [storage]);
  } catch {
    throw new TypeError("Windows review pair storage is invalid");
  }
  if (reviewed !== true) throw new TypeError("Windows review pair storage is invalid");

  if (ownValue(storage, "contractVersion", "Windows review pair storage is invalid")
      !== WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION) {
    throw new TypeError("Windows review pair storage is invalid");
  }
  for (const name of WINDOWS_REVIEW_PAIR_STORAGE_METHODS) {
    const value = ownValue(storage, name, "Windows review pair storage is invalid");
    if (typeof value !== "function" || isProxy(value)) {
      throw new TypeError("Windows review pair storage is invalid");
    }
  }
  return Object.freeze({
    writeOwnerOnlyPairNoClobber: ownValue(
      storage,
      "writeOwnerOnlyPairNoClobber",
      "Windows review pair storage is invalid",
    ),
  });
}

function boundedIso(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function assertSignal(signal) {
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
}

/**
 * Reviewed orchestration facade for a local metadata bundle. Runtime ports
 * (filesystem scanner, pseudonyms, hash, writer, OS name and path resolver)
 * are supplied by the local composition root.
 */
export function createLocalMetadataExportContext(configuration = {}) {
  const codexLogPorts = requireObject(configuration, "codexLogPorts");
  const createHash = requirePort(configuration, "createHash");
  const deriveAccountScopeId = requirePort(configuration, "deriveAccountScopeId");
  const deriveEventOccurrenceId = requirePort(configuration, "deriveEventOccurrenceId");
  const deriveMarkerOccurrenceId = requirePort(configuration, "deriveMarkerOccurrenceId");
  const deriveModelFingerprint = requirePort(configuration, "deriveModelFingerprint");
  const deriveParticipantId = requirePort(configuration, "deriveParticipantId");
  const deriveQuotaStateId = requirePort(configuration, "deriveQuotaStateId");
  const deriveSessionScopeId = requirePort(configuration, "deriveSessionScopeId");
  const deriveSnapshotObservationId = requirePort(configuration, "deriveSnapshotObservationId");
  const exportCompatibilityTuple = requirePort(configuration, "exportCompatibilityTuple");
  const platformName = requirePort(configuration, "platformName");
  const randomBundleId = requirePort(configuration, "randomBundleId");
  const resolvePath = requirePort(configuration, "resolvePath");
  const sha256Hex = requirePort(configuration, "sha256Hex");
  const configuredWriter = requireOptionalPort(configuration, "writeOwnerOnlyPairNoClobber");
  const clock = requirePort(configuration, "clock");
  const rss = requirePort(configuration, "rss");
  const selectedPlatform = platformName();
  const reviewedWindowsPairStorage = selectedPlatform === "windows"
    ? reviewPairStoragePort(configuration)
    : undefined;
  if (selectedPlatform !== "windows" && !configuredWriter) {
    throw new TypeError("local metadata export configuration.writeOwnerOnlyPairNoClobber must be a function");
  }
  const scanner = createLocalCodexLogScanner(codexLogPorts);
  const checkpointState = createCodexCheckpointStateContext({ createHash, isProxy });
  const safeRecords = createSafeRecordsContext({
    assertValidExportRecord,
    createHash,
    createExportResourceGuard(options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return createExportResourceGuard(options);
      }
      return createExportResourceGuard({
        ...options,
        ...(Object.hasOwn(options, "clock") ? {} : { clock }),
        ...(Object.hasOwn(options, "rss") ? {} : { rss }),
      });
    },
    deriveAccountScopeId,
    deriveEventOccurrenceId,
    deriveMarkerOccurrenceId,
    deriveModelFingerprint,
    deriveQuotaStateId,
    deriveSessionScopeId,
    deriveSnapshotObservationId,
    exportCompatibilityTuple,
    isProxy,
    scanCodexLogEvents: scanner.scanCodexLogEvents,
    stableJson,
    validateClaudeStatusSnapshot,
    ...checkpointState,
  });
  const verifyPrivacySafeBundle = createPrivacySafeBundleVerifier({
    compatibilityTuple: exportCompatibilityTuple,
    sha256Hex,
  });

  async function buildLocalMetadataBundle({
    startAt,
    endAt,
    codexHome,
    secret,
    activityMarkers = [],
    createdAt = new Date().toISOString(),
    bundleId = randomBundleId(),
    forbiddenSourceValues = [],
    resourceLimits = {},
    resourceClock = clock,
    resourceRss = rss,
    resourceGuard: suppliedResourceGuard = null,
    signal = null,
  } = {}) {
    if (!secret) throw new Error("A participant export secret is required");
    assertSignal(signal);
    signal?.throwIfAborted?.();
    const bounds = safeRecords.normalizeExportBounds(startAt, endAt);
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
    const scan = await safeRecords.scanCodexSafeRecords({
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
    safeMarkers.sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.markerId.localeCompare(right.markerId));
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
    resourceGuard.observeCanonicalBundle(new TextEncoder().encode(stableJson(bundle)).byteLength);
    const receipt = verifyPrivacySafeBundle(bundle, { createdAt: bundle.createdAt, forbiddenSourceValues });
    return { bundle, receipt, resourceUsage: resourceGuard.snapshot() };
  }

  function renderMetadataExportPreview({ bundle, receipt, resourceUsage = null }) {
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

  async function writeLocalMetadataBundle({
    bundle,
    receipt,
    outputFile,
    receiptFile,
    reviewPairStorage,
    reviewPairStorageValidator,
  } = {}) {
    if (!outputFile || !receiptFile) throw new Error("outputFile and receiptFile are required");
    const output = resolvePath(outputFile);
    const receiptOutput = resolvePath(receiptFile);
    const operationReviewPairStorage = reviewPairStorage === undefined
      ? undefined
      : reviewPairStoragePort({ reviewPairStorage, reviewPairStorageValidator });
    const writeOwnerOnlyPairNoClobber = operationReviewPairStorage?.writeOwnerOnlyPairNoClobber
      ?? (selectedPlatform === "windows"
        ? reviewedWindowsPairStorage?.writeOwnerOnlyPairNoClobber
        : configuredWriter);
    if (typeof writeOwnerOnlyPairNoClobber !== "function") {
      throw new TypeError("Windows review pair storage writer is required");
    }
    await writeOwnerOnlyPairNoClobber({
      firstPath: output,
      firstContent: stableJson(bundle),
      secondPath: receiptOutput,
      secondContent: stableJson(receipt),
    });
    return { outputFile: output, receiptFile: receiptOutput };
  }

  return Object.freeze({
    buildLocalMetadataBundle,
    renderMetadataExportPreview,
    writeLocalMetadataBundle,
  });
}
