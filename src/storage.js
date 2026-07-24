import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";

export function defaultDataFile() {
  return resolve(process.cwd(), ".usage-monitor", "observations.jsonl");
}

export function defaultTransitionFile() {
  return resolve(process.cwd(), ".usage-monitor", "transitions-v0.3.2.json");
}

export function frozenTransitionFile() {
  return resolve(process.cwd(), ".usage-monitor", "transitions-v0.3.json");
}

export function defaultTransitionAuditFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-transition-miner-audit-v0.3.2.md`);
}

export function defaultInferenceFile() {
  return resolve(process.cwd(), ".usage-monitor", "inference-v0.3.2.json");
}

export function defaultInferenceReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-interval-inference-report-v0.3.2.md`);
}

export function defaultContaminationFile() {
  return resolve(process.cwd(), ".usage-monitor", "contamination-v0.3.2.json");
}

export function defaultContaminationReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-contamination-report-v0.3.2.md`);
}

export function defaultToolMechanismFile() {
  return resolve(process.cwd(), ".usage-monitor", "tool-mechanisms-v0.3.json");
}

export function defaultToolMechanismReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-tool-mechanism-report.md`);
}

export function defaultCorrectionsFile() {
  return resolve(process.cwd(), ".usage-monitor", "corrections-v0.3.jsonl");
}

export function defaultEffectiveObservationsFile() {
  return resolve(process.cwd(), ".usage-monitor", "effective-observations-v0.3.json");
}

export function defaultCorrectionReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-correction-report.md`);
}

export function defaultExperimentResultsFile() {
  return resolve(process.cwd(), ".usage-monitor", "experiment-results.jsonl");
}

export function defaultWeeklyHistoryFile() {
  return resolve(process.cwd(), ".usage-monitor", "weekly-limit-history-v0.1.json");
}

export function defaultWeeklyHistoryReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-weekly-limit-history-v0.1.md`);
}

export function defaultPlanTimelineFile() {
  return resolve(process.cwd(), ".usage-monitor", "account-plan-timeline-v0.1.json");
}

export function defaultProviderUiObservationFile() {
  return resolve(process.cwd(), ".usage-monitor", "provider-ui-observations-v0.1.jsonl");
}

export function defaultProviderCrosscheckFile() {
  return resolve(process.cwd(), ".usage-monitor", "provider-crosscheck-v0.1.json");
}

export function defaultLocalHistoryFile() {
  return resolve(process.cwd(), ".usage-monitor", "local-history-v0.1.json");
}

export function defaultLocalHistoryCacheValidationFile() {
  return resolve(process.cwd(), ".usage-monitor", "local-history-cache-validation-v0.1.json");
}

export function defaultProviderCrosscheckReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-provider-crosscheck-v0.1.md`);
}

export function defaultMonitoringQualityFile() {
  return resolve(process.cwd(), ".usage-monitor", "monitoring-quality-v0.1.json");
}

export function defaultMonitoringQualityReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-monitoring-quality-v0.1.md`);
}

export function defaultWeeklyCalibrationFile() {
  return resolve(process.cwd(), ".usage-monitor", "weekly-calibration-v0.2.json");
}

export function defaultWeeklyCalibrationReportFile(endAt) {
  const date = new Date(endAt).toISOString().slice(0, 10);
  return resolve(process.cwd(), ".usage-monitor", `${date}-weekly-calibration-v0.2.md`);
}

export function defaultActivityMarkerFile() {
  return resolve(process.cwd(), ".usage-monitor", "activity-markers-v0.1.jsonl");
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeOwnerOnlyAtomic(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "w", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export async function writeJsonOwnerOnlyAtomic(path, value) {
  await writeOwnerOnlyAtomic(path, stableJson(value));
}

async function assertPathAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Refusing to overwrite an existing local export artifact");
}

async function prepareOwnerOnlyFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw new Error("Export staging artifact must be a single-link regular file");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("Export staging artifact must be owned by the current user");
    }
  } finally {
    await handle.close();
  }
}

async function assertOwnerControlledDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Export destination must be a real directory");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Export destination must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error("Export destination must not be group- or world-writable");
  }
}

const EXPORT_TRANSACTION_DIRECTORY = ".app-usagemonitor-export-transactions";
const EXPORT_DESTINATION_LOCK = ".app-usagemonitor-export.lock";
const EXPORT_DESTINATION_CLAIM_PREFIX = ".app-usagemonitor-export.lock.claim.";
const EXPORT_TRANSACTION_SCHEMA = "owner-only-pair-transaction-v1";
const MAX_LOCAL_BUNDLE_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes;
const MAX_LOCAL_RECEIPT_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validBasename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && basename(value) === value && value !== "." && value !== "..";
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOwnerOnlyRecoveryFile(path, {
  label,
  maximumBytes,
  expectedBytes = null,
  maximumLinks = 1,
} = {}) {
  const pathStats = await lstat(path);
  const valid = pathStats.isFile() && !pathStats.isSymbolicLink()
    && pathStats.nlink >= 1 && pathStats.nlink <= maximumLinks
    && pathStats.size >= 1 && pathStats.size <= maximumBytes
    && (expectedBytes === null || pathStats.size === expectedBytes)
    && (typeof process.getuid !== "function" || pathStats.uid === process.getuid())
    && (process.platform === "win32" || (pathStats.mode & 0o077) === 0);
  if (!valid) throw new Error(`Invalid export recovery ${label}`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStats = await handle.stat();
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino
        || descriptorStats.size !== pathStats.size || descriptorStats.nlink !== pathStats.nlink) {
      throw new Error(`Export recovery ${label} changed during open`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== descriptorStats.size) throw new Error(`Export recovery ${label} changed during read`);
    return { bytes, stats: descriptorStats };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readTransactionManifest(path) {
  const { bytes } = await readOwnerOnlyRecoveryFile(path, {
    label: "manifest",
    maximumBytes: 64 * 1024,
    maximumLinks: 2,
  });
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid export recovery manifest JSON");
  }
  if (stableJson(manifest) !== bytes.toString("utf8")) throw new Error("Non-canonical export recovery manifest");
  const exactKeys = ["artifacts", "schemaVersion", "transactionId"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || Object.keys(manifest).sort().join("\0") !== exactKeys.join("\0")
      || manifest.schemaVersion !== EXPORT_TRANSACTION_SCHEMA
      || typeof manifest.transactionId !== "string"
      || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)
      || Object.keys(manifest.artifacts).sort().join("\0") !== "bundle\0receipt") {
    throw new Error("Invalid export recovery manifest shape");
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
        || Object.keys(artifact).sort().join("\0") !== "bytes\0finalName\0sha256\0stageName"
        || !validBasename(artifact.finalName) || !validBasename(artifact.stageName)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("Invalid export recovery artifact declaration");
    }
  }
  if (manifest.artifacts.bundle.finalName === manifest.artifacts.receipt.finalName
      || manifest.artifacts.bundle.finalName === EXPORT_TRANSACTION_DIRECTORY
      || manifest.artifacts.receipt.finalName === EXPORT_TRANSACTION_DIRECTORY
      || manifest.artifacts.bundle.stageName !== "bundle.stage"
      || manifest.artifacts.receipt.stageName !== "receipt.stage") {
    throw new Error("Invalid export recovery artifact collision");
  }
  if (manifest.artifacts.bundle.bytes > MAX_LOCAL_BUNDLE_BYTES
      || manifest.artifacts.receipt.bytes > MAX_LOCAL_RECEIPT_BYTES) {
    throw new Error("Invalid export recovery artifact size");
  }
  return manifest;
}

async function assertOwnerOnlyOrphan(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink < 1 || stats.nlink > 2
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    throw new Error("Invalid pre-commit export recovery artifact");
  }
  return stats;
}

async function assertStagedArtifact(path, expected, maximumBytes) {
  const { bytes, stats } = await readOwnerOnlyRecoveryFile(path, {
    label: "stage",
    maximumBytes,
    expectedBytes: expected.bytes,
    maximumLinks: 2,
  });
  if (sha256(bytes) !== expected.sha256) throw new Error("Invalid export recovery stage digest");
  return stats;
}

async function finalState(path, stageStats) {
  const stats = await lstatIfExists(path);
  if (!stats) return "absent";
  if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== stageStats.dev || stats.ino !== stageStats.ino) return "conflict";
  return "same_inode";
}

async function cleanupPairTransaction(transactionDirectory, transactionRoot, destinationDirectory, manifest, failpoint = async () => {}) {
  await unlink(join(transactionDirectory, "manifest.json"));
  await failpoint("after_manifest_cleanup");
  await unlink(join(transactionDirectory, manifest.artifacts.bundle.stageName));
  await unlink(join(transactionDirectory, manifest.artifacts.receipt.stageName));
  await rmdir(transactionDirectory);
  await syncDirectory(transactionRoot);
  await rmdir(transactionRoot).catch((error) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
  await syncDirectory(destinationDirectory);
}

async function abandonUncommittedTransaction(transactionDirectory, transactionRoot) {
  for (const name of ["manifest.json", "manifest.prepared", "bundle.stage", "receipt.stage"]) {
    await unlink(join(transactionDirectory, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rmdir(transactionDirectory).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(transactionRoot).catch(() => {});
  await rmdir(transactionRoot).catch((error) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readExportDestinationLock(path) {
  const stats = await lstat(path);
  if (!stats.isSymbolicLink() || stats.nlink < 1 || stats.nlink > 2
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    throw new Error("Local export destination has an invalid lock");
  }
  const target = await readlink(path);
  const match = /^pid=(\d+);token=([0-9a-f-]{36})$/.exec(target);
  if (!match) throw new Error("Local export destination has an invalid lock");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Local export destination has an invalid lock");
  return { pid, stats };
}

async function withExportDestinationLock(destinationDirectory, callback, {
  lockFailpoint = async () => {},
} = {}) {
  const lockPath = join(destinationDirectory, EXPORT_DESTINATION_LOCK);
  const target = `pid=${process.pid};token=${randomUUID()}`;
  const claimName = `${EXPORT_DESTINATION_CLAIM_PREFIX}${process.pid}.${randomUUID()}`;
  const claimPath = join(destinationDirectory, claimName);
  let lockStats;
  let ownsClaim = false;
  async function releaseOwnedClaim() {
    if (!ownsClaim) return;
    const stats = await lstatIfExists(claimPath);
    if (stats) {
      if (!stats.isSymbolicLink() || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
        throw new Error("Local export destination claim changed before release");
      }
      await unlink(claimPath);
      await syncDirectory(destinationDirectory);
    }
    ownsClaim = false;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const claimNames = (await readdir(destinationDirectory))
      .filter((name) => name.startsWith(EXPORT_DESTINATION_CLAIM_PREFIX));
    await lockFailpoint("after_claim_scan");
    if (claimNames.length > 1) throw new Error("Local export destination has conflicting lock claims");
    if (claimNames.length === 1 && claimNames[0] !== claimName) {
      const match = /^\.app-usagemonitor-export\.lock\.claim\.(\d+)\.([0-9a-f-]{36})$/.exec(claimNames[0]);
      if (!match) throw new Error("Local export destination has an invalid lock claim");
      const claimOwner = Number(match[1]);
      if (!Number.isSafeInteger(claimOwner) || claimOwner < 1 || processIsRunning(claimOwner)) {
        throw new Error("Local export destination is busy");
      }
      await readExportDestinationLock(join(destinationDirectory, claimNames[0]));
      try {
        await rename(join(destinationDirectory, claimNames[0]), claimPath);
        await syncDirectory(destinationDirectory);
        ownsClaim = true;
        await lockFailpoint("after_claim_acquired");
      } catch (error) {
        if (error.code === "ENOENT") throw new Error("Local export destination is busy");
        throw error;
      }
    }

    if (ownsClaim) {
      const current = await lstatIfExists(lockPath);
      if (current) {
        const existing = await readExportDestinationLock(lockPath);
        if (processIsRunning(existing.pid)) {
          await releaseOwnedClaim();
          throw new Error("Local export destination is busy");
        }
        await unlink(lockPath);
        await syncDirectory(destinationDirectory);
      }
      try {
        await symlink(target, lockPath);
        lockStats = await lstat(lockPath);
        await syncDirectory(destinationDirectory);
        await unlink(claimPath);
        await syncDirectory(destinationDirectory);
        ownsClaim = false;
        break;
      } catch (error) {
        await releaseOwnedClaim();
        if (error.code === "EEXIST") throw new Error("Local export destination is busy");
        throw error;
      }
    }

    try {
      await symlink(target, lockPath);
      lockStats = await lstat(lockPath);
      await syncDirectory(destinationDirectory);
      const postAcquireClaims = (await readdir(destinationDirectory))
        .filter((name) => name.startsWith(EXPORT_DESTINATION_CLAIM_PREFIX));
      if (postAcquireClaims.length > 0) {
        const current = await lstat(lockPath);
        if (current.dev !== lockStats.dev || current.ino !== lockStats.ino) {
          throw new Error("Local export destination lock changed during claim handoff");
        }
        await unlink(lockPath);
        await syncDirectory(destinationDirectory);
        lockStats = null;
        throw new Error("Local export destination is busy");
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readExportDestinationLock(lockPath);
      if (processIsRunning(existing.pid)) throw new Error("Local export destination is busy");
      try {
        await rename(lockPath, claimPath);
        await syncDirectory(destinationDirectory);
        ownsClaim = true;
        await lockFailpoint("after_claim_acquired");
      } catch (claimError) {
        if (claimError.code === "ENOENT") throw new Error("Local export destination is busy");
        throw claimError;
      }
    }
  }
  if (!lockStats) throw new Error("Unable to acquire local export destination lock");
  try {
    return await callback();
  } finally {
    const current = await lstatIfExists(lockPath);
    if (!current || current.dev !== lockStats.dev || current.ino !== lockStats.ino) {
      throw new Error("Local export destination lock changed before release");
    }
    await unlink(lockPath);
    await syncDirectory(destinationDirectory);
  }
}

async function unlinkSameInode(path, expectedStats) {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== expectedStats.dev || current.ino !== expectedStats.ino) {
    throw new Error("Export recovery destination changed before cleanup");
  }
  await unlink(path);
}

async function writeOwnerOnlyPairNoClobberUnlocked({
  firstPath,
  firstContent,
  secondPath,
  secondContent,
} = {}, {
  linkFile = link,
  failpoint = async () => {},
} = {}) {
  if (typeof firstContent !== "string" || typeof secondContent !== "string") {
    throw new Error("Paired export contents must be strings");
  }
  const firstBytes = Buffer.byteLength(firstContent, "utf8");
  const secondBytes = Buffer.byteLength(secondContent, "utf8");
  if (firstBytes < 1 || firstBytes > MAX_LOCAL_BUNDLE_BYTES
      || secondBytes < 1 || secondBytes > MAX_LOCAL_RECEIPT_BYTES) {
    throw new Error("Paired export contents exceed local artifact bounds");
  }
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (first === second) throw new Error("Bundle and privacy receipt paths must be distinct");
  if (!validBasename(basename(first)) || !validBasename(basename(second))
      || basename(first) === EXPORT_TRANSACTION_DIRECTORY || basename(second) === EXPORT_TRANSACTION_DIRECTORY) {
    throw new Error("Bundle and privacy receipt names are not valid local artifact names");
  }
  const firstDirectory = dirname(first);
  const secondDirectory = dirname(second);
  await mkdir(firstDirectory, { recursive: true, mode: 0o700 });
  await mkdir(secondDirectory, { recursive: true, mode: 0o700 });
  await assertOwnerControlledDirectory(firstDirectory);
  await assertOwnerControlledDirectory(secondDirectory);
  const firstResolved = join(await realpath(firstDirectory), basename(first));
  const secondResolved = join(await realpath(secondDirectory), basename(second));
  if (firstResolved === secondResolved) throw new Error("Bundle and privacy receipt paths must be distinct");
  if (dirname(firstResolved) !== dirname(secondResolved)) {
    throw new Error("Bundle and privacy receipt must share one canonical destination directory");
  }
  await assertPathAbsent(firstResolved);
  await assertPathAbsent(secondResolved);

  const destinationDirectory = dirname(firstResolved);
  const transactionRoot = join(destinationDirectory, EXPORT_TRANSACTION_DIRECTORY);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await assertOwnerControlledDirectory(transactionRoot);
  await chmod(transactionRoot, 0o700);
  await assertOwnerControlledDirectory(transactionRoot);
  const transactionId = `${process.pid}.${randomUUID()}`;
  const transactionDirectory = join(transactionRoot, transactionId);
  await mkdir(transactionDirectory, { mode: 0o700 });
  const bundleStage = join(transactionDirectory, "bundle.stage");
  const receiptStage = join(transactionDirectory, "receipt.stage");
  const manifestPath = join(transactionDirectory, "manifest.json");
  const manifestPrepared = join(transactionDirectory, "manifest.prepared");
  let transactionPrepared = false;
  try {
    await prepareOwnerOnlyFile(bundleStage, firstContent);
    await prepareOwnerOnlyFile(receiptStage, secondContent);
    await syncDirectory(transactionDirectory);
    transactionPrepared = true;
    await failpoint("after_transaction_prepare");
    const manifest = {
      schemaVersion: EXPORT_TRANSACTION_SCHEMA,
      transactionId,
      artifacts: {
        bundle: {
          finalName: basename(firstResolved),
          stageName: basename(bundleStage),
          bytes: firstBytes,
          sha256: sha256(firstContent),
        },
        receipt: {
          finalName: basename(secondResolved),
          stageName: basename(receiptStage),
          bytes: secondBytes,
          sha256: sha256(secondContent),
        },
      },
    };
    await prepareOwnerOnlyFile(manifestPrepared, stableJson(manifest));
    await syncDirectory(transactionDirectory);
    await failpoint("after_manifest_prepare");
    await link(manifestPrepared, manifestPath);
    await syncDirectory(transactionDirectory);
    await failpoint("after_manifest_link");
    await unlink(manifestPrepared);
    await syncDirectory(transactionDirectory);
    await syncDirectory(transactionRoot);
    await failpoint("after_manifest");
    await linkFile(receiptStage, secondResolved);
    await syncDirectory(destinationDirectory);
    await failpoint("after_receipt");
    await linkFile(bundleStage, firstResolved);
    await syncDirectory(destinationDirectory);
    await failpoint("after_bundle");
    await cleanupPairTransaction(transactionDirectory, transactionRoot, destinationDirectory, manifest, failpoint);
  } catch (error) {
    if (!transactionPrepared) await abandonUncommittedTransaction(transactionDirectory, transactionRoot);
    throw error;
  }
}

export async function writeOwnerOnlyPairNoClobber(pair = {}, options = {}) {
  if (!pair.firstPath || !pair.secondPath) throw new Error("Bundle and privacy receipt paths are required");
  const first = resolve(pair.firstPath);
  const second = resolve(pair.secondPath);
  const firstDirectory = dirname(first);
  const secondDirectory = dirname(second);
  await mkdir(firstDirectory, { recursive: true, mode: 0o700 });
  await mkdir(secondDirectory, { recursive: true, mode: 0o700 });
  await assertOwnerControlledDirectory(firstDirectory);
  await assertOwnerControlledDirectory(secondDirectory);
  const canonicalFirstDirectory = await realpath(firstDirectory);
  const canonicalSecondDirectory = await realpath(secondDirectory);
  if (canonicalFirstDirectory !== canonicalSecondDirectory) {
    throw new Error("Bundle and privacy receipt must share one canonical destination directory");
  }
  const canonicalPair = {
    ...pair,
    firstPath: join(canonicalFirstDirectory, basename(first)),
    secondPath: join(canonicalSecondDirectory, basename(second)),
  };
  return withExportDestinationLock(canonicalFirstDirectory, () =>
    writeOwnerOnlyPairNoClobberUnlocked(canonicalPair, options), options);
}

async function recoverOwnerOnlyPairTransactionsUnlocked({ directory } = {}, {
  linkFile = link,
  failpoint = async () => {},
} = {}) {
  if (!directory) throw new Error("Export recovery directory is required");
  const destinationDirectory = resolve(directory);
  await assertOwnerControlledDirectory(destinationDirectory);
  const destinationResolved = await realpath(destinationDirectory);
  const transactionRoot = join(destinationResolved, EXPORT_TRANSACTION_DIRECTORY);
  const rootStats = await lstatIfExists(transactionRoot);
  if (!rootStats) return { recovered: 0, transactionsFound: 0 };
  await assertOwnerControlledDirectory(transactionRoot);
  const transactionNames = (await readdir(transactionRoot)).sort();
  let recovered = 0;
  for (const transactionName of transactionNames) {
    if (!/^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionName)
        || basename(transactionName) !== transactionName) {
      throw new Error("Unexpected entry in export transaction directory");
    }
    const transactionDirectory = join(transactionRoot, transactionName);
    await assertOwnerControlledDirectory(transactionDirectory);
    const entries = (await readdir(transactionDirectory)).sort();
    if (!entries.includes("manifest.json")) {
      if (entries.some((name) => !["bundle.stage", "manifest.prepared", "receipt.stage"].includes(name))) {
        throw new Error("Invalid manifestless export recovery transaction");
      }
      for (const name of entries) {
        await assertOwnerOnlyOrphan(join(transactionDirectory, name));
        await unlink(join(transactionDirectory, name));
      }
      await rmdir(transactionDirectory);
      await syncDirectory(transactionRoot);
      recovered += 1;
      continue;
    }
    if (entries.some((name) => !["bundle.stage", "manifest.json", "manifest.prepared", "receipt.stage"].includes(name))
        || !entries.includes("bundle.stage") || !entries.includes("receipt.stage")) {
      throw new Error("Unexpected entry in export recovery transaction");
    }
    if (entries.includes("manifest.prepared")) {
      const manifestStats = await lstat(join(transactionDirectory, "manifest.json"));
      const preparedStats = await assertOwnerOnlyOrphan(join(transactionDirectory, "manifest.prepared"));
      if (manifestStats.dev !== preparedStats.dev || manifestStats.ino !== preparedStats.ino) {
        throw new Error("Export recovery manifest publication mismatch");
      }
      await unlink(join(transactionDirectory, "manifest.prepared"));
      await syncDirectory(transactionDirectory);
    }
    const manifest = await readTransactionManifest(join(transactionDirectory, "manifest.json"));
    if (manifest.transactionId !== transactionName) throw new Error("Export recovery transaction identity mismatch");
    const bundleStage = join(transactionDirectory, manifest.artifacts.bundle.stageName);
    const receiptStage = join(transactionDirectory, manifest.artifacts.receipt.stageName);
    const bundleFinal = join(destinationResolved, manifest.artifacts.bundle.finalName);
    const receiptFinal = join(destinationResolved, manifest.artifacts.receipt.finalName);
    const bundleStats = await assertStagedArtifact(bundleStage, manifest.artifacts.bundle, MAX_LOCAL_BUNDLE_BYTES);
    const receiptStats = await assertStagedArtifact(receiptStage, manifest.artifacts.receipt, MAX_LOCAL_RECEIPT_BYTES);
    let bundleState = await finalState(bundleFinal, bundleStats);
    let receiptState = await finalState(receiptFinal, receiptStats);
    if (bundleState === "conflict" || receiptState === "conflict") {
      throw new Error("Export recovery stopped at a conflicting destination artifact");
    }
    if (bundleState === "same_inode" && receiptState === "absent") {
      await unlinkSameInode(bundleFinal, bundleStats);
      await syncDirectory(destinationResolved);
      bundleState = "absent";
    }
    if (receiptState === "absent") {
      await linkFile(receiptStage, receiptFinal);
      await syncDirectory(destinationResolved);
      receiptState = "same_inode";
      await failpoint("after_receipt");
    }
    if (bundleState === "absent") {
      await linkFile(bundleStage, bundleFinal);
      await syncDirectory(destinationResolved);
      await failpoint("after_bundle");
    }
    await cleanupPairTransaction(transactionDirectory, transactionRoot, destinationResolved, manifest, failpoint);
    recovered += 1;
  }
  await rmdir(transactionRoot).catch((error) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
  await syncDirectory(destinationResolved);
  return { recovered, transactionsFound: transactionNames.length };
}

export async function recoverOwnerOnlyPairTransactions({ directory } = {}, options = {}) {
  if (!directory) throw new Error("Export recovery directory is required");
  const destinationDirectory = resolve(directory);
  await assertOwnerControlledDirectory(destinationDirectory);
  const canonicalDirectory = await realpath(destinationDirectory);
  return withExportDestinationLock(canonicalDirectory, () =>
    recoverOwnerOnlyPairTransactionsUnlocked({ directory: canonicalDirectory }, options), options);
}

export async function appendObservation(path, observation) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(observation)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export function serializeJsonLines(records) {
  if (!Array.isArray(records) || records.length === 0) return "";
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

export async function appendOwnerOnlyText(path, content, { sync = false } = {}) {
  if (typeof content !== "string" || content.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  if (sync) {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
  }
  await chmod(path, 0o600);
  if (sync) await syncDirectory(dirname(path));
}

export async function unlinkDurably(path) {
  await unlink(path);
  await syncDirectory(dirname(path));
}

export async function truncateDurably(path, length) {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendJsonLinesOwnerOnly(path, records) {
  await appendOwnerOnlyText(path, serializeJsonLines(records));
}

export async function withOwnerOnlyFileLock(lockPath, callback) {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Correction ledger lock is already held at ${lockPath}`);
    throw error;
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function readJsonIfExists(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readObservations(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on ${path} line ${index + 1}: ${error.message}`);
      }
    });
}
