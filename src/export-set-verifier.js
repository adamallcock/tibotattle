import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadVerifiedLocalMetadataBundleBytes,
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import { decompressExportBytes } from "./export-compression.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
} from "./export-set-materializer.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2,
  EXPORT_SET_MANIFEST_VERSION_V0_1,
  EXPORT_SET_MANIFEST_VERSION_V0_2,
  exportSetChunkBasenames,
} from "./export-set-schema.js";
import { stableJson } from "./storage.js";

const MAXIMUM_MANIFEST_RECEIPT_BYTES = 1024 * 1024;
const FAMILY = Object.freeze([
  ["usageEvents", "eventTime", "eventId"],
  ["quotaSnapshots", "observedTime", "snapshotId"],
  ["activityMarkers", "observedTime", "markerId"],
]);

const SAFE_VERIFY_CODES = new Set([
  "directory",
  "manifest_missing",
  "manifest_type",
  "manifest_owner",
  "manifest_permissions",
  "manifest_links",
  "manifest_size",
  "manifest_changed",
  "manifest_json",
  "manifest_canonical",
  "manifest_schema",
  "manifest_receipt",
  "compatibility",
  "mixed_representation",
  "chunk_artifact_missing",
  "chunk_artifact_type",
  "chunk_artifact_owner",
  "chunk_artifact_permissions",
  "chunk_artifact_links",
  "chunk_artifact_size",
  "chunk_artifact_changed",
  "chunk_artifact_read",
  "chunk_artifact_digest",
  "chunk_receipt_missing",
  "chunk_receipt_type",
  "chunk_receipt_owner",
  "chunk_receipt_permissions",
  "chunk_receipt_links",
  "chunk_receipt_size",
  "chunk_receipt_changed",
  "chunk_receipt_read",
  "chunk_metadata",
  "chunk_shared_contract",
  "chunk_diagnostics",
  "chunk_order",
  "chunk_duplicate",
  "chunk_nonmaximal",
  "logical_digest",
  "verification_index",
]);

export class ExportSetVerificationError extends Error {
  constructor(code) {
    if (!SAFE_VERIFY_CODES.has(code)) throw new TypeError("Unknown export-set verification code");
    super(`Export-set verification failed (${code})`);
    this.name = "ExportSetVerificationError";
    this.code = `export_set_verify_${code}`;
  }
}

function fail(code) {
  throw new ExportSetVerificationError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertOwnerDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("directory");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("directory");
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) fail("directory");
}

function assertArtifactStats(stats, label, maximumBytes) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label}_type`);
  if (stats.nlink !== 1) fail(`${label}_links`);
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes) fail(`${label}_size`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail(`${label}_owner`);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail(`${label}_permissions`);
}

async function readCanonicalArtifact(path, label, maximumBytes) {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label}_missing`);
    fail(`${label}_changed`);
  }
  assertArtifactStats(pathStats, label, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    assertArtifactStats(stats, label, maximumBytes);
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino || stats.size !== pathStats.size) {
      fail(`${label}_changed`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size) fail(`${label}_changed`);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${label}_json`);
    }
    if (stableJson(value) !== bytes.toString("utf8")) fail(`${label}_canonical`);
    return { value, bytes };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readOwnerOnlyBytes(path, label, maximumBytes, expectedBytes) {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail(`${label}_missing`);
    fail(`${label}_changed`);
  }
  assertArtifactStats(pathStats, label, maximumBytes);
  if (pathStats.size !== expectedBytes) fail(`${label}_size`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    assertArtifactStats(stats, label, maximumBytes);
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino || stats.size !== pathStats.size) {
      fail(`${label}_changed`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size) fail(`${label}_changed`);
    return bytes;
  } catch (error) {
    if (error instanceof ExportSetVerificationError) throw error;
    fail(`${label}_read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function frameDigest(digest, family, record) {
  const frame = Buffer.from(stableJson({ family, record }), "utf8");
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(frame.length));
  digest.update(size);
  digest.update(frame);
}

function chunkRecords(bundle) {
  const rows = [];
  for (const [family, timeField, idField] of FAMILY) {
    for (const record of bundle.records[family]) {
      rows.push({ family, time: record[timeField], id: record[idField], record });
    }
  }
  return rows;
}

function sharedChunkContract(bundle) {
  return {
    compatibility: bundle.compatibility,
    participantId: bundle.participantId,
    createdAt: bundle.createdAt,
    coveredAt: bundle.coveredAt,
    sourceProviders: bundle.sourceProviders,
    clientPlatform: bundle.clientPlatform,
    transportReady: bundle.transportReady,
  };
}

function manifestSharedContract(manifest) {
  return {
    compatibility: manifest.compatibility,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    sourceProviders: manifest.sourceProviders,
    clientPlatform: manifest.clientPlatform,
    transportReady: manifest.transportReady,
  };
}

function firstRecordFitsPriorChunk(manifest, bundle, firstRow) {
  bundle.records[firstRow.family].push(firstRow.record);
  bundle.recordCounts[firstRow.family] += 1;
  let candidateBytes;
  try {
    candidateBytes = Buffer.from(stableJson(bundle), "utf8");
  } finally {
    bundle.records[firstRow.family].pop();
    bundle.recordCounts[firstRow.family] -= 1;
  }
  return candidateBytes.length <= manifest.chunking.maximumCanonicalBundleBytes;
}

async function createUniquenessIndex(resourceGuard, {
  maximumBytes = resourceGuard.limits.maximumWorkspaceBytes,
  temporaryRoot = tmpdir(),
} = {}) {
  const directory = await mkdtemp(join(temporaryRoot, "app-usagemonitor-set-verify-"));
  await chmod(directory, 0o700);
  const databaseFile = join(directory, "ids.sqlite3");
  const handle = await open(databaseFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  await handle.chmod(0o600);
  await handle.close();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("PRAGMA synchronous=FULL");
    database.exec("PRAGMA trusted_schema=OFF");
    database.enableDefensive?.(true);
    database.exec("CREATE TABLE ids(family TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(family, record_id)) STRICT");
    const insert = database.prepare("INSERT INTO ids(family, record_id) VALUES (?, ?)");
    let batchRecords = 0;
    let transactionOpen = true;
    database.exec("BEGIN IMMEDIATE");
    return {
      add(family, id) {
        try {
          insert.run(family, id);
          batchRecords += 1;
          if (batchRecords >= DEFAULT_EXPORT_RESOURCE_LIMITS.maximumSqliteBatchRecords) {
            database.exec("COMMIT");
            transactionOpen = false;
            const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
            const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
            const bytes = pageCount * pageSize;
            if (bytes > maximumBytes) throw new ExportResourceLimitError("workspace_bytes");
            resourceGuard.observeWorkspace(bytes);
            database.exec("BEGIN IMMEDIATE");
            transactionOpen = true;
            batchRecords = 0;
          }
        } catch (error) {
          if (error instanceof ExportResourceLimitError) throw error;
          if (String(error?.code).includes("CONSTRAINT") || /UNIQUE constraint/i.test(error?.message)) {
            fail("chunk_duplicate");
          }
          fail("verification_index");
        }
      },
      async close() {
        let failure = null;
        try {
          if (transactionOpen) {
            database.exec("COMMIT");
            transactionOpen = false;
          }
          const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
          const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
          const bytes = pageCount * pageSize;
          if (bytes > maximumBytes) throw new ExportResourceLimitError("workspace_bytes");
          resourceGuard.observeWorkspace(bytes);
        } catch (error) {
          failure = error;
        }
        try {
          database.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof ExportSetVerificationError) throw error;
    fail("verification_index");
  }
}

function assertManifestReceipt(receipt, manifestBytes, manifestVersion) {
  const receiptVersion = manifestVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
    ? EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2
    : EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1;
  const expected = {
    schemaVersion: receiptVersion,
    manifestSha256: sha256(manifestBytes),
    manifestBytes: manifestBytes.length,
    transportReady: false,
  };
  if (stableJson(receipt) !== stableJson(expected)) fail("manifest_receipt");
}

function manifestByteTotals(manifest) {
  if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2) {
    return {
      decoded: manifest.totals.decodedBundleBytes,
      encoded: manifest.totals.encodedArtifactBytes,
    };
  }
  return { decoded: manifest.totals.bundleBytes, encoded: 0 };
}

async function assertNoMixedRepresentation(root, manifestVersion) {
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    fail("directory");
  }
  const oppositePattern = manifestVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
    ? /^chunk-\d{6}\.bundle\.json$/
    : /^chunk-\d{6}\.bundle\.json\.gz$/;
  if (entries.some((name) => oppositePattern.test(name))) fail("mixed_representation");
}

async function loadVerifiedSetChunk({ root, manifest, entry, resourceGuard }) {
  const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
  resourceGuard.observeCanonicalBundle(entry.bundleBytes);
  if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_1) {
    return loadVerifiedLocalMetadataBundleFiles({
      bundleFile: join(root, names.bundle),
      receiptFile: join(root, names.receipt),
    });
  }

  resourceGuard.observeEncodedArtifact(entry.artifactBytes);
  const artifactBytes = await readOwnerOnlyBytes(
    join(root, names.bundle),
    "chunk_artifact",
    resourceGuard.limits.maximumEncodedArtifactBytes,
    entry.artifactBytes,
  );
  if (sha256(artifactBytes) !== entry.artifactSha256) fail("chunk_artifact_digest");

  const bundleBytes = decompressExportBytes(artifactBytes, {
    maximumEncodedBytes: entry.artifactBytes,
    maximumDecodedBytes: Math.min(entry.bundleBytes, resourceGuard.limits.maximumCanonicalBundleBytes),
  });
  if (bundleBytes.length !== entry.bundleBytes || sha256(bundleBytes) !== entry.bundleSha256) {
    fail("chunk_metadata");
  }

  const receiptBytes = await readOwnerOnlyBytes(
    join(root, names.receipt),
    "chunk_receipt",
    MAXIMUM_MANIFEST_RECEIPT_BYTES,
    entry.receiptBytes,
  );
  if (sha256(receiptBytes) !== entry.receiptSha256) fail("chunk_metadata");
  return loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes });
}

export async function verifyLocalExportSet({
  directory,
  resourceLimits = {},
  maximumVerificationIndexBytes = null,
  verificationTemporaryRoot = tmpdir(),
} = {}) {
  const root = resolve(directory);
  let directoryStats;
  try {
    directoryStats = await lstat(root);
  } catch {
    fail("directory");
  }
  assertOwnerDirectory(directoryStats);
  const manifestArtifact = await readCanonicalArtifact(
    join(root, EXPORT_SET_MANIFEST_BASENAME),
    "manifest",
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes,
  );
  const receiptArtifact = await readCanonicalArtifact(
    join(root, EXPORT_SET_MANIFEST_RECEIPT_BASENAME),
    "manifest",
    MAXIMUM_MANIFEST_RECEIPT_BYTES,
  );
  try {
    assertValidExportSetManifest(manifestArtifact.value);
  } catch {
    fail("manifest_schema");
  }
  const manifest = manifestArtifact.value;
  assertManifestReceipt(receiptArtifact.value, manifestArtifact.bytes, manifest.schemaVersion);
  if (stableJson(manifest.compatibility) !== stableJson(exportCompatibilityTuple())) fail("compatibility");
  await assertNoMixedRepresentation(root, manifest.schemaVersion);
  const resourceGuard = createExportResourceGuard({ scope: "export_set", limits: resourceLimits });
  const verificationIndexLimit = maximumVerificationIndexBytes ?? resourceGuard.limits.maximumWorkspaceBytes;
  if (!Number.isSafeInteger(verificationIndexLimit) || verificationIndexLimit < 1
      || verificationIndexLimit > resourceGuard.limits.maximumWorkspaceBytes) {
    throw new TypeError("maximumVerificationIndexBytes must fit the workspace resource policy");
  }
  resourceGuard.assertCoveredInterval(Date.parse(manifest.coveredAt.startAt), Date.parse(manifest.coveredAt.endAt));
  resourceGuard.observeSourcePlan(manifest.sourcePlan.sourceFiles, manifest.sourcePlan.sourceBytes);
  resourceGuard.observeChunkCount(manifest.chunks.length);
  resourceGuard.observeManifest(manifestArtifact.bytes.length);
  const declaredBytes = manifestByteTotals(manifest);
  resourceGuard.observeExportSetBytes(declaredBytes.decoded, declaredBytes.encoded);

  const unique = await createUniquenessIndex(resourceGuard, {
    maximumBytes: verificationIndexLimit,
    temporaryRoot: verificationTemporaryRoot,
  });
  const logical = createHash("sha256");
  logical.update("app-usagemonitor/export-set-logical-records/v1\0");
  let priorLast = null;
  let priorBundle = null;
  let priorCount = 0;
  let diagnostics = null;
  let actualDecodedBytes = 0;
  let actualEncodedBytes = 0;
  let actualReceiptBytes = 0;
  try {
    for (const entry of manifest.chunks) {
      const verified = await loadVerifiedSetChunk({ root, manifest, entry, resourceGuard });
      const bundle = verified.bundle;
      if (bundle.bundleId !== entry.bundleId
          || verified.bundleSha256 !== entry.bundleSha256
          || verified.bundleBytes.length !== entry.bundleBytes
          || verified.receiptSha256 !== entry.receiptSha256
          || verified.receiptBytes.length !== entry.receiptBytes
          || stableJson(bundle.recordCounts) !== stableJson(entry.recordCounts)) fail("chunk_metadata");
      actualDecodedBytes += verified.bundleBytes.length;
      actualReceiptBytes += verified.receiptBytes.length;
      if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2) actualEncodedBytes += entry.artifactBytes;
      resourceGuard.observeExportSetBytes(actualDecodedBytes, actualEncodedBytes);
      if (stableJson(sharedChunkContract(bundle)) !== stableJson(manifestSharedContract(manifest))) {
        fail("chunk_shared_contract");
      }
      if (diagnostics === null) diagnostics = stableJson(bundle.diagnostics);
      else if (stableJson(bundle.diagnostics) !== diagnostics) fail("chunk_diagnostics");

      const rows = chunkRecords(bundle);
      if (priorBundle && rows.length > 0 && priorCount < manifest.chunking.maximumRecordsPerChunk) {
        if (firstRecordFitsPriorChunk(manifest, priorBundle, rows[0])) fail("chunk_nonmaximal");
      }
      for (const row of rows) {
        resourceGuard.observeOutputRecord(Buffer.byteLength(stableJson(row.record)));
        const familyOrder = FAMILY.findIndex(([family]) => family === row.family);
        const key = [familyOrder, row.time, row.id];
        if (priorLast && (key[0] < priorLast[0]
            || (key[0] === priorLast[0] && key[1] < priorLast[1])
            || (key[0] === priorLast[0] && key[1] === priorLast[1] && key[2] <= priorLast[2]))) {
          fail("chunk_order");
        }
        unique.add(row.family, row.id);
        frameDigest(logical, row.family, row.record);
        priorLast = key;
      }
      priorBundle = bundle;
      priorCount = rows.length;
    }
    if (logical.digest("hex") !== manifest.totals.logicalRecordsSha256) fail("logical_digest");
    if (actualDecodedBytes !== declaredBytes.decoded
        || actualEncodedBytes !== declaredBytes.encoded
        || actualReceiptBytes !== manifest.totals.receiptBytes) fail("chunk_metadata");
  } finally {
    await unique.close();
  }

  return {
    verdict: "passed",
    schemaVersion: manifest.schemaVersion,
    contractStatus: manifest.compatibility.contract.status,
    chunkCount: manifest.chunks.length,
    recordCounts: structuredClone(manifest.totals.recordCounts),
    bundleBytes: declaredBytes.decoded,
    decodedBundleBytes: declaredBytes.decoded,
    encodedArtifactBytes: declaredBytes.encoded,
    transportReady: manifest.transportReady,
  };
}
