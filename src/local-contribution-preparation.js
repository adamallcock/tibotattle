import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import { readBoundedJsonLines } from "./bounded-jsonl.js";
import {
  defaultExportStateDirectory,
  withParticipantSecretLease,
} from "./export-identity.js";
import {
  selectProductionParticipantIdentity,
} from "./export-identity-production.js";
import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
} from "./export-resource-policy.js";
import {
  buildLocalMetadataBundle,
  writeLocalMetadataBundle,
} from "./metadata-exporter.js";
import {
  materializeTelemetryContributions,
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "./telemetry-contribution-builder.js";
import {
  PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
  PREPARED_CONTRIBUTION_SET_VERSION,
  preparedContributionSetId,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import { syncDirectory } from "./storage.js";

export const LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION =
  "local-contribution-preparation-result-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION =
  "local-contribution-preparation-error-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS = 60 * 60 * 1_000;
export const LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS = 24;
export const LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS = 1;
export const LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS =
  Object.freeze([1, 24, 7 * 24]);
export const LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS =
  7 * 24 * 60 * 60 * 1_000;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUBLIC_ERROR_CODES = new Set([
  "coverage_unavailable",
  "coverage_invalid",
  "identity_unavailable",
  "no_safe_records",
  "export_too_large",
  "privacy_verification_failed",
  "review_archive_invalid",
  "prepared_spool_invalid",
  "preparation_aborted",
  "preparation_failed",
]);

export class LocalContributionPreparationError extends Error {
  constructor(code) {
    if (!PUBLIC_ERROR_CODES.has(code)) {
      throw new TypeError("Unknown local contribution preparation error");
    }
    super("Local contribution preparation failed");
    this.name = "LocalContributionPreparationError";
    this.code = code;
  }
}

function fail(code) {
  throw new LocalContributionPreparationError(code);
}

function instant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? normalized : null;
}

function normalizedLookbackHours(value) {
  if (!LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS.includes(value)) {
    fail("coverage_invalid");
  }
  return value;
}

function boundedRecentCoverage(
  value,
  lookbackHours,
  {
    acceptedThroughAt = null,
    replayOverlapHours =
      LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS,
  } = {},
) {
  const sourceStartAt = instant(value?.startAt);
  const endAt = instant(value?.endAt);
  if (sourceStartAt === null || endAt === null) fail("coverage_unavailable");
  const sourceStart = Date.parse(sourceStartAt);
  const end = Date.parse(endAt);
  if (end <= sourceStart) fail("coverage_invalid");
  const requestedWindowMs = normalizedLookbackHours(lookbackHours)
    * 60 * 60 * 1_000;
  if (acceptedThroughAt !== null) {
    const acceptedThrough = instant(acceptedThroughAt);
    if (acceptedThrough === null
        || !Number.isSafeInteger(replayOverlapHours)
        || replayOverlapHours < 0
        || replayOverlapHours > lookbackHours) {
      fail("coverage_invalid");
    }
    const acceptedThroughMs = Date.parse(acceptedThrough);
    if (end <= acceptedThroughMs) fail("no_safe_records");
    const overlapMs = replayOverlapHours * 60 * 60 * 1_000;
    const start = Math.max(
      sourceStart,
      acceptedThroughMs - overlapMs,
    );
    const boundedEnd = Math.min(end, start + requestedWindowMs);
    if (start >= boundedEnd || boundedEnd <= acceptedThroughMs) {
      fail("no_safe_records");
    }
    return {
      startAt: new Date(start).toISOString(),
      endAt: new Date(boundedEnd).toISOString(),
    };
  }
  const start = Math.max(sourceStart, end - requestedWindowMs);
  if (start >= end) fail("coverage_invalid");
  return {
    startAt: new Date(start).toISOString(),
    endAt,
  };
}

function assertOwnerOnlyDirectory(stats, code) {
  if (!stats.isDirectory()
      || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail(code);
  }
}

async function prepareOwnerOnlyDirectory(path, code) {
  const requested = resolve(path);
  try {
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const requestedStats = await lstat(requested);
    assertOwnerOnlyDirectory(requestedStats, code);
    const canonical = await realpath(requested);
    const canonicalStats = await lstat(canonical);
    assertOwnerOnlyDirectory(canonicalStats, code);
    if (requestedStats.dev !== canonicalStats.dev
        || requestedStats.ino !== canonicalStats.ino) {
      fail(code);
    }
    return canonical;
  } catch (error) {
    if (error instanceof LocalContributionPreparationError) throw error;
    fail(code);
  }
}

async function createOwnerOnlyDirectory(path, code) {
  try {
    await mkdir(path, { mode: 0o700 });
    const stats = await lstat(path);
    assertOwnerOnlyDirectory(stats, code);
  } catch (error) {
    if (error instanceof LocalContributionPreparationError) throw error;
    fail(code);
  }
  return path;
}

async function ownerOnlyDirectoryExists(path, code) {
  try {
    const before = await lstat(path);
    assertOwnerOnlyDirectory(before, code);
    const canonical = await realpath(path);
    const after = await lstat(canonical);
    assertOwnerOnlyDirectory(after, code);
    if (before.dev !== after.dev
        || before.ino !== after.ino
        || canonical !== resolve(path)) {
      fail(code);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error instanceof LocalContributionPreparationError) throw error;
    fail(code);
  }
}

async function assertPathAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code);
  }
  fail(code);
}

async function removeEmptyOwnerOnlyDirectory(path, parentDirectory) {
  if (typeof path !== "string" || path.length === 0) return;
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()
        || stats.isSymbolicLink()
        || (typeof process.getuid === "function" && stats.uid !== process.getuid())
        || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      return;
    }
    // rmdir is deliberately used instead of recursive removal: completed
    // privacy review pairs and partially materialized staging sets are crash
    // evidence and must survive. Only an unpublished directory that is still
    // empty can be reclaimed here.
    await rmdir(path);
    await syncDirectory(parentDirectory).catch(() => {});
  } catch (error) {
    if (error?.code === "ENOENT"
        || error?.code === "ENOTEMPTY"
        || error?.code === "EEXIST") {
      return;
    }
    // Cleanup is best-effort and must never replace the fixed, content-free
    // preparation error that caused it.
  }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const RECORD_COUNT_FIELDS = Object.freeze([
  "usageEvents",
  "quotaSnapshots",
  "activityMarkers",
]);

function verifiedRecordCounts(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("privacy_verification_failed");
  }
  const counts = {};
  for (const field of RECORD_COUNT_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      fail("privacy_verification_failed");
    }
    counts[field] = value[field];
  }
  return counts;
}

function matchingRecordCounts(left, right) {
  return RECORD_COUNT_FIELDS.every((field) => left[field] === right[field]);
}

function aggregatePreparedRecordCounts(manifest) {
  if (!Array.isArray(manifest?.files)) {
    fail("privacy_verification_failed");
  }
  const aggregate = {
    usageEvents: 0,
    quotaSnapshots: 0,
    activityMarkers: 0,
  };
  for (const file of manifest.files) {
    const counts = verifiedRecordCounts(file?.recordCounts);
    for (const field of RECORD_COUNT_FIELDS) {
      const next = aggregate[field] + counts[field];
      if (!Number.isSafeInteger(next)) {
        fail("privacy_verification_failed");
      }
      aggregate[field] = next;
    }
  }
  return aggregate;
}

function verifiedSourceEvidence(verifiedSource, coveredAt) {
  const summary = verifiedSource?.summary;
  const bundle = verifiedSource?.bundle;
  const receipt = verifiedSource?.receipt;
  const recordCounts = verifiedRecordCounts(bundle?.recordCounts);
  const summaryCounts = verifiedRecordCounts(summary?.recordCounts);
  const receiptCounts = verifiedRecordCounts(receipt?.recordCounts);
  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  if (summary?.verdict !== "passed"
      || receipt?.verdict !== "passed"
      || summary?.transportReady !== false
      || receipt?.transportReady !== false
      || checks.length > 32
      || bundle?.coveredAt?.startAt !== coveredAt.startAt
      || bundle?.coveredAt?.endAt !== coveredAt.endAt
      || receipt?.coveredAt?.startAt !== coveredAt.startAt
      || receipt?.coveredAt?.endAt !== coveredAt.endAt
      || !matchingRecordCounts(recordCounts, summaryCounts)
      || !matchingRecordCounts(recordCounts, receiptCounts)) {
    fail("privacy_verification_failed");
  }
  return { checks, recordCounts };
}

function assertPreparedCountsMatchSource({
  verifiedSource,
  coveredAt,
  manifest,
}) {
  const source = verifiedSourceEvidence(verifiedSource, coveredAt);
  const prepared = aggregatePreparedRecordCounts(manifest);
  if (!matchingRecordCounts(source.recordCounts, prepared)) {
    fail("privacy_verification_failed");
  }
  return source;
}

function recoveredCoverage({
  verifiedSource,
  currentCoverage,
  acceptedThroughAt,
  lookbackHours,
  replayOverlapHours,
}) {
  const value = verifiedSource?.bundle?.coveredAt;
  const startAt = instant(value?.startAt);
  const endAt = instant(value?.endAt);
  if (startAt === null
      || endAt === null
      || Date.parse(startAt) >= Date.parse(endAt)
      || Date.parse(endAt) > Date.parse(currentCoverage.endAt)
      || Date.parse(endAt) - Date.parse(startAt)
        > lookbackHours * 60 * 60 * 1_000) {
    fail("privacy_verification_failed");
  }
  if (acceptedThroughAt === null) {
    if (startAt !== currentCoverage.startAt
        || endAt !== currentCoverage.endAt) {
      fail("privacy_verification_failed");
    }
  } else {
    const accepted = Date.parse(acceptedThroughAt);
    const minimumStart =
      accepted - replayOverlapHours * 60 * 60 * 1_000;
    if (Date.parse(endAt) <= accepted
        || Date.parse(startAt) < minimumStart) {
      fail("privacy_verification_failed");
    }
  }
  return { startAt, endAt };
}

function publicResult({
  coveredAt,
  verifiedSource,
  manifest,
  provenanceRetained,
}) {
  const source = assertPreparedCountsMatchSource({
    verifiedSource,
    coveredAt,
    manifest,
  });
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const batchCount = safeCount(manifest?.batchCount);
  let preparedBytes = 0;
  for (const file of files) {
    const next = preparedBytes + safeCount(file?.bytes);
    if (!Number.isSafeInteger(next)) fail("preparation_failed");
    preparedBytes = next;
  }
  const checks = source.checks;
  if (manifest?.schemaVersion !== PREPARED_CONTRIBUTION_SET_VERSION
      || manifest?.eligibleSchemaVersion
        !== PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA) {
    fail("privacy_verification_failed");
  }
  const checksPassed = checks.filter((check) => check?.status === "passed").length;
  const checksFailed = checks.filter((check) => check?.status === "failed").length;
  if (checksFailed !== 0
      || batchCount < 1
      || files.length !== batchCount) {
    fail("privacy_verification_failed");
  }
  const prepared = {
    schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
    eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
    batchCount,
    bytes: preparedBytes,
  };
  Object.defineProperty(prepared, "preparedSetId", {
    value: preparedContributionSetId(manifest),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(prepared);
  return Object.freeze({
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
    status: "prepared",
    coveredAt: {
      startAt: coveredAt.startAt,
      endAt: coveredAt.endAt,
    },
    recordCounts: {
      usageEvents: source.recordCounts.usageEvents,
      quotaSnapshots: source.recordCounts.quotaSnapshots,
      activityMarkers: source.recordCounts.activityMarkers,
    },
    privacy: {
      verdict: "passed",
      checksPassed,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: provenanceRetained === true,
    },
    prepared,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  });
}

function mappedError(error, stage, signal = null) {
  if (signal?.aborted) {
    return new LocalContributionPreparationError("preparation_aborted");
  }
  if (error instanceof LocalContributionPreparationError) return error;
  const code = typeof error?.code === "string" ? error.code : "";
  if (code.startsWith("export_resource_")
      || code === "batch_count_invalid"
      || code === "batch_too_large") {
    return new LocalContributionPreparationError("export_too_large");
  }
  if (code === "bundle_empty") {
    return new LocalContributionPreparationError("no_safe_records");
  }
  if (stage === "identity") {
    return new LocalContributionPreparationError("identity_unavailable");
  }
  if (stage === "verify_source"
      || code.startsWith("bundle_")
      || code.startsWith("receipt_")
      || code === "privacy_gate"
      || (stage === "build"
        && typeof error?.message === "string"
        && error.message.startsWith("Privacy verification failed closed ("))) {
    return new LocalContributionPreparationError(
      "privacy_verification_failed",
    );
  }
  return new LocalContributionPreparationError("preparation_failed");
}

function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}

function throwIfPreparationAborted(signal) {
  if (signal?.aborted) fail("preparation_aborted");
}

export function projectLocalContributionPreparationError(error) {
  const code = error instanceof LocalContributionPreparationError
    ? error.code
    : "preparation_failed";
  return Object.freeze({
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
    status: "failed",
    errorCode: PUBLIC_ERROR_CODES.has(code) ? code : "preparation_failed",
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  });
}

export function defaultLocalContributionPreparationDirectories(options = {}) {
  const state = defaultExportStateDirectory(options);
  return Object.freeze({
    reviewArchiveDirectory: join(
      state,
      "local-contribution-reviews-v0.1",
    ),
    preparedSpoolDirectory: join(
      state,
      "local-contribution-prepared-v0.1",
    ),
  });
}

export async function prepareRecentLocalContribution({
  lookbackHours = LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS,
  acceptedThroughAt = null,
  replayOverlapHours =
    LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS,
  coveredAt,
  codexHome = join(homedir(), ".codex"),
  activityFile = resolve(
    process.cwd(),
    ".usage-monitor",
    "activity-markers-v0.1.jsonl",
  ),
  reviewArchiveDirectory =
    defaultLocalContributionPreparationDirectories().reviewArchiveDirectory,
  preparedSpoolDirectory =
    defaultLocalContributionPreparationDirectories().preparedSpoolDirectory,
  explicitSecretFile = null,
  failpoint = async () => {},
  createResourceGuard = createExportResourceGuard,
  readActivityMarkers = readBoundedJsonLines,
  selectIdentity = selectProductionParticipantIdentity,
  withIdentityLease = withParticipantSecretLease,
  buildBundle = buildLocalMetadataBundle,
  writeBundle = writeLocalMetadataBundle,
  verifySource = loadVerifiedLocalMetadataBundleFiles,
  materialize = materializeTelemetryContributions,
  verifyPreparedSet = verifyPreparedContributionSet,
  beforePreparedPublish = async () => {},
  preparationId = null,
  uuid = randomUUID,
  renameDirectory = rename,
  syncParentDirectory = syncDirectory,
  signal = null,
} = {}) {
  if (typeof failpoint !== "function"
      || typeof createResourceGuard !== "function"
      || typeof readActivityMarkers !== "function"
      || typeof selectIdentity !== "function"
      || typeof withIdentityLease !== "function"
      || typeof buildBundle !== "function"
      || typeof writeBundle !== "function"
      || typeof verifySource !== "function"
      || typeof materialize !== "function"
      || typeof verifyPreparedSet !== "function"
      || typeof beforePreparedPublish !== "function"
      || typeof uuid !== "function"
      || typeof renameDirectory !== "function"
      || typeof syncParentDirectory !== "function"
      || !validAbortSignal(signal)) {
    throw new TypeError("Local contribution preparation dependencies are invalid");
  }
  throwIfPreparationAborted(signal);
  const coverage = boundedRecentCoverage(coveredAt, lookbackHours, {
    acceptedThroughAt,
    replayOverlapHours,
  });
  const selectedPreparationId = preparationId ?? uuid();
  if (typeof selectedPreparationId !== "string"
      || !UUID_V4.test(selectedPreparationId)) {
    fail("preparation_failed");
  }
  const reviewRoot = await prepareOwnerOnlyDirectory(
    reviewArchiveDirectory,
    "review_archive_invalid",
  );
  throwIfPreparationAborted(signal);
  const spoolRoot = await prepareOwnerOnlyDirectory(
    preparedSpoolDirectory,
    "prepared_spool_invalid",
  );
  throwIfPreparationAborted(signal);
  const reviewDirectory = join(
    reviewRoot,
    `review-${selectedPreparationId}`,
  );
  const stagingDirectory = join(
    spoolRoot,
    `.preparing-${selectedPreparationId}`,
  );
  const publishedDirectory = join(
    spoolRoot,
    `prepared-set-${selectedPreparationId}`,
  );
  const bundleFile = join(reviewDirectory, "review.umx.json");
  const receiptFile = join(
    reviewDirectory,
    "review.umx.json.privacy-receipt.json",
  );
  let stagingCleanupAllowed = false;

  try {
    const reviewExists = await ownerOnlyDirectoryExists(
      reviewDirectory,
      "review_archive_invalid",
    );
    const stagingExists = await ownerOnlyDirectoryExists(
      stagingDirectory,
      "prepared_spool_invalid",
    );
    const publishedExists = await ownerOnlyDirectoryExists(
      publishedDirectory,
      "prepared_spool_invalid",
    );
    if (publishedExists && (stagingExists || !reviewExists)) {
      fail("preparation_failed");
    }
    if (stagingExists && !reviewExists) {
      fail("preparation_failed");
    }
    if (reviewExists) {
      let recoveredSource;
      let recoveredAt;
      try {
        recoveredSource = await verifySource({
          bundleFile,
          receiptFile,
        });
        throwIfPreparationAborted(signal);
        recoveredAt = recoveredCoverage({
          verifiedSource: recoveredSource,
          currentCoverage: coverage,
          acceptedThroughAt,
          lookbackHours,
          replayOverlapHours,
        });
      } catch (error) {
        throw mappedError(error, "verify_source", signal);
      }

      let recoveredManifest;
      if (publishedExists) {
        try {
          recoveredManifest = await verifyPreparedSet({
            directory: publishedDirectory,
            builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
          });
          throwIfPreparationAborted(signal);
          assertPreparedCountsMatchSource({
            verifiedSource: recoveredSource,
            coveredAt: recoveredAt,
            manifest: recoveredManifest,
          });
          const recoveredPreparedSetId =
            preparedContributionSetId(recoveredManifest);
          await beforePreparedPublish(Object.freeze({
            coveredAt: Object.freeze({ ...recoveredAt }),
            preparedSetId: recoveredPreparedSetId,
          }));
          throwIfPreparationAborted(signal);
          return publicResult({
            coveredAt: recoveredAt,
            verifiedSource: recoveredSource,
            manifest: recoveredManifest,
            provenanceRetained: true,
          });
        } catch (error) {
          throw mappedError(error, "publish", signal);
        }
      }

      if (!stagingExists) {
        try {
          await materialize({
            bundleFile,
            receiptFile,
            outputDirectory: stagingDirectory,
            signal,
            failpoint: (name, context) => failpoint(
              `materializer:${name}`,
              { ...context, signal },
            ),
          });
          throwIfPreparationAborted(signal);
        } catch (error) {
          throw mappedError(error, "materialize", signal);
        }
      }
      try {
        recoveredManifest = await verifyPreparedSet({
          directory: stagingDirectory,
          builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
        });
        throwIfPreparationAborted(signal);
        assertPreparedCountsMatchSource({
          verifiedSource: recoveredSource,
          coveredAt: recoveredAt,
          manifest: recoveredManifest,
        });
        const recoveredPreparedSetId =
          preparedContributionSetId(recoveredManifest);
        await beforePreparedPublish(Object.freeze({
          coveredAt: Object.freeze({ ...recoveredAt }),
          preparedSetId: recoveredPreparedSetId,
        }));
        throwIfPreparationAborted(signal);
        await renameDirectory(stagingDirectory, publishedDirectory);
        await syncParentDirectory(spoolRoot);
        throwIfPreparationAborted(signal);
        const publishedManifest = await verifyPreparedSet({
          directory: publishedDirectory,
          builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
        });
        throwIfPreparationAborted(signal);
        return publicResult({
          coveredAt: recoveredAt,
          verifiedSource: recoveredSource,
          manifest: publishedManifest,
          provenanceRetained: true,
        });
      } catch (error) {
        throw mappedError(error, "publish", signal);
      }
    }
    await createOwnerOnlyDirectory(
      reviewDirectory,
      "review_archive_invalid",
    );
    try {
      await syncParentDirectory(reviewRoot);
      throwIfPreparationAborted(signal);
    } catch {
      throwIfPreparationAborted(signal);
      fail("review_archive_invalid");
    }
    await assertPathAbsent(stagingDirectory, "prepared_spool_invalid");
    await assertPathAbsent(publishedDirectory, "prepared_spool_invalid");
    stagingCleanupAllowed = true;
    let selection;
    try {
      selection = selectIdentity({ explicitSecretFile });
    } catch (error) {
      throw mappedError(error, "identity", signal);
    }
    if (!selection?.identityOptions) fail("identity_unavailable");

    return await withIdentityLease(
      selection.identityOptions,
      async (identity) => {
        throwIfPreparationAborted(signal);
        if (!identity?.secret) fail("identity_unavailable");
        let resourceGuard;
        let activityMarkers;
        try {
          resourceGuard = createResourceGuard();
          resourceGuard.assertCoveredInterval(
            Date.parse(coverage.startAt),
            Date.parse(coverage.endAt),
          );
          activityMarkers = await readActivityMarkers(activityFile, {
            maximumFileBytes:
              DEFAULT_EXPORT_RESOURCE_LIMITS.maximumExpandedRecordBytes,
            maximumLineBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumLineBytes,
            maximumRecords: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
            resourceGuard,
            signal,
          });
          throwIfPreparationAborted(signal);
        } catch (error) {
          throw mappedError(error, "build", signal);
        }
        let built;
        try {
          built = await buildBundle({
            startAt: coverage.startAt,
            endAt: coverage.endAt,
            codexHome,
            secret: identity.secret,
            activityMarkers,
            createdAt: coverage.endAt,
            resourceGuard,
            signal,
          });
          throwIfPreparationAborted(signal);
        } catch (error) {
          throw mappedError(error, "build", signal);
        }
        let verifiedSource;
        try {
          await writeBundle({
            ...built,
            outputFile: bundleFile,
            receiptFile,
          });
          throwIfPreparationAborted(signal);
          verifiedSource = await verifySource({
            bundleFile,
            receiptFile,
          });
          throwIfPreparationAborted(signal);
          if (verifiedSource?.summary?.verdict !== "passed") {
            fail("privacy_verification_failed");
          }
        } catch (error) {
          throw mappedError(error, "verify_source", signal);
        }
        try {
          await failpoint("after_review_pair", {
            coveredAt: coverage,
            signal,
          });
          throwIfPreparationAborted(signal);
        } catch (error) {
          throw mappedError(error, "failpoint", signal);
        }
        let materialized;
        try {
          materialized = await materialize({
            bundleFile,
            receiptFile,
            outputDirectory: stagingDirectory,
            signal,
            failpoint: (name, context) => failpoint(
              `materializer:${name}`,
              { ...context, signal },
            ),
          });
          throwIfPreparationAborted(signal);
        } catch (error) {
          throw mappedError(error, "materialize", signal);
        }
        if (materialized?.sourcePrivacyVerdict !== "passed"
            || materialized?.sourceTransportReady !== false) {
          fail("privacy_verification_failed");
        }
        let stagingManifest;
        try {
          stagingManifest = await verifyPreparedSet({
            directory: stagingDirectory,
            builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
          });
          throwIfPreparationAborted(signal);
          assertPreparedCountsMatchSource({
            verifiedSource,
            coveredAt: coverage,
            manifest: stagingManifest,
          });
          const stagingPreparedSetId =
            preparedContributionSetId(stagingManifest);
          await beforePreparedPublish(Object.freeze({
            coveredAt: Object.freeze({ ...coverage }),
            preparedSetId: stagingPreparedSetId,
          }));
          throwIfPreparationAborted(signal);
          await failpoint("after_prepared_set_verified", {
            batchCount: stagingManifest.batchCount,
            preparedSetId: stagingPreparedSetId,
            signal,
          });
          throwIfPreparationAborted(signal);
          await failpoint("before_prepared_publish", {
            batchCount: stagingManifest.batchCount,
            signal,
          });
          throwIfPreparationAborted(signal);
          await renameDirectory(stagingDirectory, publishedDirectory);
          await syncParentDirectory(spoolRoot);
          throwIfPreparationAborted(signal);
          await failpoint("after_prepared_publish", {
            batchCount: stagingManifest.batchCount,
            signal,
          });
          throwIfPreparationAborted(signal);
          const publishedManifest = await verifyPreparedSet({
            directory: publishedDirectory,
            builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
          });
          throwIfPreparationAborted(signal);
          const publishedSource = await verifySource({
            bundleFile,
            receiptFile,
          });
          throwIfPreparationAborted(signal);
          return publicResult({
            coveredAt: coverage,
            verifiedSource: publishedSource,
            manifest: publishedManifest,
            provenanceRetained: true,
          });
        } catch (error) {
          throw mappedError(error, "publish", signal);
        }
      },
    );
  } catch (error) {
    if (stagingCleanupAllowed) {
      await removeEmptyOwnerOnlyDirectory(stagingDirectory, spoolRoot);
    }
    await removeEmptyOwnerOnlyDirectory(reviewDirectory, reviewRoot);
    throw mappedError(error, "identity", signal);
  }
}

export function prepareLatestHourLocalContribution(options = {}) {
  return prepareRecentLocalContribution({
    ...options,
    lookbackHours: 1,
  });
}

export function createLocalContributionPreparationRunner({
  coverageProvider,
  prepare = prepareRecentLocalContribution,
  ...options
} = {}) {
  if (typeof coverageProvider !== "function") {
    throw new TypeError("coverageProvider must be a function");
  }
  if (typeof prepare !== "function") {
    throw new TypeError("prepare must be a function");
  }
  return async function runLocalContributionPreparation({
    lookbackHours =
      LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS,
    acceptedThroughAt = null,
    replayOverlapHours =
      LOCAL_CONTRIBUTION_PREPARATION_REPLAY_OVERLAP_HOURS,
    beforePreparedPublish = async () => {},
    preparationId = null,
    signal = null,
  } = {}) {
    normalizedLookbackHours(lookbackHours);
    if (acceptedThroughAt !== null && instant(acceptedThroughAt) === null) {
      throw new TypeError("acceptedThroughAt must be a canonical timestamp or null");
    }
    if (!Number.isSafeInteger(replayOverlapHours)
        || replayOverlapHours < 0
        || replayOverlapHours > lookbackHours) {
      throw new TypeError("replayOverlapHours is invalid");
    }
    if (!validAbortSignal(signal)) {
      throw new TypeError("signal must be an AbortSignal or null");
    }
    if (typeof beforePreparedPublish !== "function") {
      throw new TypeError("beforePreparedPublish must be a function");
    }
    if (preparationId !== null
        && (typeof preparationId !== "string"
          || !UUID_V4.test(preparationId))) {
      throw new TypeError("preparationId must be a UUIDv4 or null");
    }
    throwIfPreparationAborted(signal);
    let coveredAt;
    try {
      coveredAt = await coverageProvider();
      throwIfPreparationAborted(signal);
    } catch {
      throwIfPreparationAborted(signal);
      fail("coverage_unavailable");
    }
    try {
      const result = await prepare({
        ...options,
        coveredAt,
        lookbackHours,
        acceptedThroughAt,
        replayOverlapHours,
        beforePreparedPublish,
        preparationId,
        signal,
      });
      throwIfPreparationAborted(signal);
      return result;
    } catch (error) {
      throw mappedError(error, "build", signal);
    }
  };
}
