import { randomUUID } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

export async function writeOwnerOnlyPairNoClobber({
  firstPath,
  firstContent,
  secondPath,
  secondContent,
} = {}, {
  linkFile = link,
} = {}) {
  if (typeof firstContent !== "string" || typeof secondContent !== "string") {
    throw new Error("Paired export contents must be strings");
  }
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (first === second) throw new Error("Bundle and privacy receipt paths must be distinct");
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
  await assertPathAbsent(first);
  await assertPathAbsent(second);

  const transactionId = `${process.pid}.${randomUUID()}`;
  const firstTemporary = `${first}.${transactionId}.tmp`;
  const secondTemporary = `${second}.${transactionId}.tmp`;
  let firstCommitted = false;
  let secondCommitted = false;
  try {
    await prepareOwnerOnlyFile(firstTemporary, firstContent);
    await prepareOwnerOnlyFile(secondTemporary, secondContent);
    await linkFile(secondTemporary, second);
    secondCommitted = true;
    await linkFile(firstTemporary, first);
    firstCommitted = true;
    for (const directory of new Set([firstDirectory, secondDirectory])) await syncDirectory(directory);
  } catch (error) {
    if (secondCommitted) await unlink(second).catch(() => {});
    if (firstCommitted) await unlink(first).catch(() => {});
    for (const directory of new Set([firstDirectory, secondDirectory])) await syncDirectory(directory).catch(() => {});
    throw error;
  } finally {
    await unlink(firstTemporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(secondTemporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
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
