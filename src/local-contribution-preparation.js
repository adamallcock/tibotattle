import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
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
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import { syncDirectory } from "./storage.js";

export const LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION =
  "local-contribution-preparation-result-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION =
  "local-contribution-preparation-error-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS = 60 * 60 * 1_000;

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

function latestHourCoverage(value) {
  const sourceStartAt = instant(value?.startAt);
  const endAt = instant(value?.endAt);
  if (sourceStartAt === null || endAt === null) fail("coverage_unavailable");
  const sourceStart = Date.parse(sourceStartAt);
  const end = Date.parse(endAt);
  if (end <= sourceStart) fail("coverage_invalid");
  const start = Math.max(sourceStart, end - LOCAL_CONTRIBUTION_PREPARATION_WINDOW_MS);
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

async function assertPathAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(code);
  }
  fail(code);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function publicResult({
  coveredAt,
  receipt,
  manifest,
  provenanceRetained,
}) {
  const recordCounts = receipt?.recordCounts ?? {};
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const batchCount = safeCount(manifest?.batchCount);
  let preparedBytes = 0;
  for (const file of files) {
    const next = preparedBytes + safeCount(file?.bytes);
    if (!Number.isSafeInteger(next)) fail("preparation_failed");
    preparedBytes = next;
  }
  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  if (checks.length > 32
      || receipt?.coveredAt?.startAt !== coveredAt.startAt
      || receipt?.coveredAt?.endAt !== coveredAt.endAt
      || manifest?.schemaVersion !== PREPARED_CONTRIBUTION_SET_VERSION
      || manifest?.eligibleSchemaVersion
        !== PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA) {
    fail("privacy_verification_failed");
  }
  const checksPassed = checks.filter((check) => check?.status === "passed").length;
  const checksFailed = checks.filter((check) => check?.status === "failed").length;
  if (receipt?.verdict !== "passed"
      || checksFailed !== 0
      || batchCount < 1
      || files.length !== batchCount) {
    fail("privacy_verification_failed");
  }
  return Object.freeze({
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
    status: "prepared",
    coveredAt: {
      startAt: coveredAt.startAt,
      endAt: coveredAt.endAt,
    },
    recordCounts: {
      usageEvents: safeCount(recordCounts.usageEvents),
      quotaSnapshots: safeCount(recordCounts.quotaSnapshots),
      activityMarkers: safeCount(recordCounts.activityMarkers),
    },
    privacy: {
      verdict: "passed",
      checksPassed,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: provenanceRetained === true,
    },
    prepared: {
      schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
      eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
      batchCount,
      bytes: preparedBytes,
    },
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  });
}

function mappedError(error, stage) {
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

export async function prepareLatestHourLocalContribution({
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
  uuid = randomUUID,
  renameDirectory = rename,
  syncParentDirectory = syncDirectory,
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
      || typeof uuid !== "function"
      || typeof renameDirectory !== "function"
      || typeof syncParentDirectory !== "function") {
    throw new TypeError("Local contribution preparation dependencies are invalid");
  }
  const coverage = latestHourCoverage(coveredAt);
  const preparationId = uuid();
  if (typeof preparationId !== "string" || !UUID_V4.test(preparationId)) {
    fail("preparation_failed");
  }
  const reviewRoot = await prepareOwnerOnlyDirectory(
    reviewArchiveDirectory,
    "review_archive_invalid",
  );
  const spoolRoot = await prepareOwnerOnlyDirectory(
    preparedSpoolDirectory,
    "prepared_spool_invalid",
  );
  const reviewDirectory = await createOwnerOnlyDirectory(
    join(reviewRoot, `review-${preparationId}`),
    "review_archive_invalid",
  );
  try {
    await syncParentDirectory(reviewRoot);
  } catch {
    fail("review_archive_invalid");
  }
  const stagingDirectory = join(spoolRoot, `.preparing-${preparationId}`);
  const publishedDirectory = join(spoolRoot, `prepared-set-${preparationId}`);
  await assertPathAbsent(stagingDirectory, "prepared_spool_invalid");
  await assertPathAbsent(publishedDirectory, "prepared_spool_invalid");

  const bundleFile = join(reviewDirectory, "review.umx.json");
  const receiptFile = join(
    reviewDirectory,
    "review.umx.json.privacy-receipt.json",
  );
  let selection;
  try {
    selection = selectIdentity({ explicitSecretFile });
  } catch (error) {
    throw mappedError(error, "identity");
  }
  if (!selection?.identityOptions) fail("identity_unavailable");

  try {
    return await withIdentityLease(
      selection.identityOptions,
      async (identity) => {
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
          });
        } catch (error) {
          throw mappedError(error, "build");
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
          });
        } catch (error) {
          throw mappedError(error, "build");
        }
        try {
          await writeBundle({
            ...built,
            outputFile: bundleFile,
            receiptFile,
          });
          const verifiedSource = await verifySource({
            bundleFile,
            receiptFile,
          });
          if (verifiedSource?.summary?.verdict !== "passed") {
            fail("privacy_verification_failed");
          }
        } catch (error) {
          throw mappedError(error, "verify_source");
        }
        try {
          await failpoint("after_review_pair", {
            coveredAt: coverage,
          });
        } catch (error) {
          throw mappedError(error, "failpoint");
        }
        let materialized;
        try {
          materialized = await materialize({
            bundleFile,
            receiptFile,
            outputDirectory: stagingDirectory,
            failpoint: (name, context) => failpoint(
              `materializer:${name}`,
              context,
            ),
          });
        } catch (error) {
          throw mappedError(error, "materialize");
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
          await failpoint("after_prepared_set_verified", {
            batchCount: stagingManifest.batchCount,
          });
          await failpoint("before_prepared_publish", {
            batchCount: stagingManifest.batchCount,
          });
          await renameDirectory(stagingDirectory, publishedDirectory);
          await syncParentDirectory(spoolRoot);
          await failpoint("after_prepared_publish", {
            batchCount: stagingManifest.batchCount,
          });
          const publishedManifest = await verifyPreparedSet({
            directory: publishedDirectory,
            builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
          });
          return publicResult({
            coveredAt: coverage,
            receipt: built.receipt,
            manifest: publishedManifest,
            provenanceRetained: true,
          });
        } catch (error) {
          throw mappedError(error, "publish");
        }
      },
    );
  } catch (error) {
    throw mappedError(error, "identity");
  }
}

export function createLocalContributionPreparationRunner({
  coverageProvider,
  ...options
} = {}) {
  if (typeof coverageProvider !== "function") {
    throw new TypeError("coverageProvider must be a function");
  }
  return async function runLocalContributionPreparation() {
    let coveredAt;
    try {
      coveredAt = await coverageProvider();
    } catch {
      fail("coverage_unavailable");
    }
    return prepareLatestHourLocalContribution({
      ...options,
      coveredAt,
    });
  };
}
