import { constants } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import { stableJson } from "./export/canonical-json.js";
import {
  assertOwnerControlledDirectory,
  createOwnerOnlyExportArtifactStorageContext,
  defaultActivityMarkerFile,
  lstatIfExists,
  syncDirectory,
} from "./platform/index.js";

export { defaultActivityMarkerFile };
export { syncDirectory };

export { stableJson };

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

const MAX_OWNER_ONLY_NO_CLOBBER_BYTES = 1024 * 1024;

/**
 * Durably publish one bounded owner-only file without creating its parent or
 * replacing any existing directory entry.
 */
export async function writeOwnerOnlyNoClobberDurable(path, content, {
  maximumBytes = MAX_OWNER_ONLY_NO_CLOBBER_BYTES,
  failpoint = async () => {},
} = {}) {
  if (!path) throw new Error("Owner-only publication path is required");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAX_OWNER_ONLY_NO_CLOBBER_BYTES) {
    throw new TypeError("Owner-only publication bound must be at most 1 MiB");
  }
  if (typeof failpoint !== "function") throw new TypeError("Owner-only publication failpoint must be a function");
  let contentBytes;
  if (typeof content === "string") contentBytes = Buffer.byteLength(content, "utf8");
  else if (Buffer.isBuffer(content) || content instanceof Uint8Array) contentBytes = content.byteLength;
  else throw new TypeError("Owner-only publication content must be a string, Buffer, or Uint8Array");
  if (contentBytes > maximumBytes) throw new Error("Owner-only publication content exceeds its byte bound");

  // Snapshot caller-owned views only after the allocation-free size check.
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const requested = resolve(path);
  const parent = dirname(requested);
  await assertOwnerControlledDirectory(parent);
  const canonicalParent = await realpath(parent);
  const target = join(canonicalParent, basename(requested));
  let handle = null;
  let createdIdentity = null;
  let durable = false;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const opened = await handle.stat();
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await failpoint("after_file_sync");
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1 || written.size !== contentBytes
        || (typeof process.getuid === "function" && written.uid !== process.getuid())
        || (process.platform !== "win32" && (written.mode & 0o077) !== 0)) {
      throw new Error("Owner-only publication file failed validation");
    }
    const published = await lstat(target);
    if (!published.isFile() || published.isSymbolicLink()
        || published.dev !== written.dev || published.ino !== written.ino
        || published.nlink !== written.nlink || published.size !== written.size
        || (typeof process.getuid === "function" && published.uid !== process.getuid())
        || (process.platform !== "win32" && (published.mode & 0o077) !== 0)) {
      throw new Error("Owner-only publication path changed before durability");
    }
    await handle.close();
    handle = null;
    await syncDirectory(canonicalParent);
    durable = true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!durable && createdIdentity) {
      const current = await lstatIfExists(target);
      if (current && current.isFile() && !current.isSymbolicLink()
          && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
        await unlink(target);
        await syncDirectory(canonicalParent);
      }
    }
    throw error;
  }
}

const OWNER_ONLY_EXPORT_ARTIFACT_STORAGE =
  createOwnerOnlyExportArtifactStorageContext({
    stableJson,
    maximumCanonicalBundleBytes:
      DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
    maximumEncodedArtifactBytes:
      DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes,
    maximumDirectoryEntries:
      DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
    createResourceLimitError: (code) => new ExportResourceLimitError(code),
  });

export const {
  recoverOwnerOnlyPairTransactions,
  recoverOwnerOnlyPairTransactionsUnderLease,
  withExportDestinationLease,
  writeOwnerOnlyPairNoClobber,
  writeOwnerOnlyPairNoClobberUnderLease,
} = OWNER_ONLY_EXPORT_ARTIFACT_STORAGE;

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
