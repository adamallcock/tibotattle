#!/usr/bin/env node
/**
 * Reconciles a stopped native collector-state copy into an Electron
 * collector-state copy. It is deliberately not a migration entrypoint:
 * callers must first make three private, stopped-state copies in one 0700
 * directory. The live application paths are never accepted by this tool.
 *
 * Default mode is read-only. `--apply-to-private-copy` appends only source
 * record multiplicities missing from the Electron copy and leaves the
 * Electron checkpoint and all other metadata unchanged.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  forEachLocalCollectorRecord,
  inspectLocalCollectorStateStorage,
  openLocalCollectorStateSession,
  readLocalCollectorState,
} from "../src/local-collector-state.js";
import { stableJson, syncDirectory } from "../src/storage.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCHEMA = "tibotattle-native-electron-collector-reconciliation-v1";
const PROOF_SCHEMA = "tibotattle-native-electron-collector-conservation-r9-v1";
const PROOF_INSPECTION = "read-only";
const PROOF_SCOPE = "stopped-native-r9-versus-current-electron";
const MAX_PROOF_BYTES = 256 * 1024;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const COPY_NAMES = Object.freeze({
  native: "native-local-collector-state-v1.sqlite",
  electron: "electron-local-collector-state-v1.sqlite",
  electronBefore: "electron-local-collector-state-before-reconcile.sqlite",
});
const RECEIPT_NAME = "collector-reconciliation-receipt-v1.json";

function fail(message, code = "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointDigest(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? sha256(stableJson(value))
    : null;
}

function metaDigest(value) {
  return sha256(stableJson(value));
}

function recordKey(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("collector record is invalid", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_STATE_INVALID");
  }
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  return `${kind}\0${sha256(stableJson(record))}`;
}

function safeAbsolutePath(value, option) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${option} must be an absolute path`);
  }
  const path = resolve(value);
  if (path === value || value.startsWith("/")) return path;
  fail(`${option} must be an absolute path`);
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

async function privateRegularFile(path, { maximumBytes = Number.MAX_SAFE_INTEGER } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("private reconciliation input is unavailable", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_UNAVAILABLE");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size < 1 || metadata.size > maximumBytes
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("private reconciliation input is unsafe", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_UNSAFE");
  }
  await realpath(path).catch(() => fail(
    "private reconciliation input cannot be resolved",
    "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_UNSAFE",
  ));
  return metadata;
}

async function privateDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("copy root is unavailable", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_COPY_ROOT_UNAVAILABLE");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("copy root is unsafe", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_COPY_ROOT_UNSAFE");
  }
  return await realpath(path).catch(() => fail(
    "copy root cannot be resolved", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_COPY_ROOT_UNSAFE",
  ));
}

function copyPaths(copyRoot) {
  return Object.freeze({
    native: join(copyRoot, COPY_NAMES.native),
    electron: join(copyRoot, COPY_NAMES.electron),
    electronBefore: join(copyRoot, COPY_NAMES.electronBefore),
    receipt: join(copyRoot, RECEIPT_NAME),
  });
}

async function regularProof(path) {
  await privateRegularFile(path, { maximumBytes: MAX_PROOF_BYTES });
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("identity conservation proof is invalid", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_PROOF_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== PROOF_SCHEMA || value.inspection !== PROOF_INSPECTION
      || value.scope !== PROOF_SCOPE || value.saltMatches !== true
      || !Number.isSafeInteger(value.nativeRows) || value.nativeRows < 0
      || !Number.isSafeInteger(value.electronRows) || value.electronRows < 0) {
    fail("identity conservation proof is not accepted", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_PROOF_INVALID");
  }
  return Object.freeze({ nativeRows: value.nativeRows, electronRows: value.electronRows });
}

async function hashFile(path) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      fail("private reconciliation input changed", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_CHANGED");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) {
      fail("private reconciliation input changed", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_CHANGED");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function stateSummary(stateFile) {
  const [state, storage] = await Promise.all([
    readLocalCollectorState({ stateFile, includeRecords: false }),
    inspectLocalCollectorStateStorage({ stateFile }),
  ]);
  if (state.status !== "available" || storage.status !== "available"
      || checkpointDigest(state.checkpoint) === null) {
    fail("collector-state copy is incomplete", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_STATE_INVALID");
  }
  return Object.freeze({
    recordCount: storage.recordCount,
    checkpointDigest: checkpointDigest(state.checkpoint),
    accountingCacheDigest: metaDigest(state.accountingCache),
    legacyRefreshUseDigest: metaDigest(state.legacyRefreshUse),
    migrationDigest: metaDigest(state.migration),
    checkpoint: state.checkpoint,
  });
}

async function multiset(stateFile) {
  const counts = new Map();
  const result = await forEachLocalCollectorRecord({
    stateFile,
    onRecord(record) {
      const key = recordKey(record);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  });
  if (result.status !== "available") {
    fail("collector-state copy is unavailable", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_STATE_INVALID");
  }
  return counts;
}

async function missingRecords({ sourceFile, destinationFile, onMissing = null }) {
  const available = await multiset(destinationFile);
  let sourceRecords = 0;
  let missing = 0;
  const sourceResult = await forEachLocalCollectorRecord({
    stateFile: sourceFile,
    async onRecord(record) {
      sourceRecords += 1;
      const key = recordKey(record);
      const count = available.get(key) ?? 0;
      if (count > 0) {
        if (count === 1) available.delete(key);
        else available.set(key, count - 1);
        return;
      }
      missing += 1;
      if (onMissing !== null) await onMissing(record);
    },
  });
  if (sourceResult.status !== "available") {
    fail("source collector-state copy is unavailable", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_SOURCE_UNAVAILABLE");
  }
  return Object.freeze({ sourceRecords, missing });
}

function sameStateMetadata(left, right) {
  return left.checkpointDigest === right.checkpointDigest
    && left.accountingCacheDigest === right.accountingCacheDigest
    && left.legacyRefreshUseDigest === right.legacyRefreshUseDigest
    && left.migrationDigest === right.migrationDigest;
}

async function readReceipt(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("reconciliation receipt is unavailable", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_RECEIPT_UNSAFE");
  }
  fail("reconciliation receipt already exists", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_RECEIPT_EXISTS");
}

async function writeReceipt(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, FILE_MODE);
    await handle.writeFile(`${stableJson(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("reconciliation receipt temporary path exists", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_RECEIPT_UNSAFE");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    // POSIX rename replaces an existing destination. Link the fsynced temporary
    // file into place instead so an interrupted or concurrent run cannot
    // overwrite a receipt that belongs to another private-copy attempt.
    await link(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code === "EEXIST") {
      fail("reconciliation receipt already exists", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_RECEIPT_EXISTS");
    }
    throw error;
  }
  await unlink(temporary);
  await chmod(path, FILE_MODE);
  await syncDirectory(dirname(path));
}

async function updateReceipt(path, value) {
  const temporary = `${path}.${process.pid}.update`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, FILE_MODE);
    await handle.writeFile(`${stableJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await rename(temporary, path);
  await chmod(path, FILE_MODE);
  await syncDirectory(dirname(path));
}

function contentFreeResult({ source, destination, missing, applied, inserted = 0, conservation = null }) {
  return Object.freeze({
    schema: SCHEMA,
    status: applied ? "reconciled_private_copy" : "planned_private_copy_only",
    sourceRecordCount: source.recordCount,
    destinationRecordCountBefore: destination.recordCount,
    missingSourceRecordMultiplicity: missing,
    identitySaltProven: true,
    destinationCheckpointPreserved: applied ? conservation?.checkpointPreserved ?? false : null,
    destinationMetadataPreserved: applied ? conservation?.metadataPreserved ?? false : null,
    destinationExistingRecordsPreserved: applied ? conservation?.existingRecordsPreserved ?? false : null,
    insertedRecordMultiplicity: inserted,
    destinationRecordCountAfter: conservation?.recordCountAfter ?? destination.recordCount,
  });
}

async function preflight({ copyRoot, conservationProof }) {
  const root = await privateDirectory(safeAbsolutePath(copyRoot, "--copy-root"));
  const paths = copyPaths(root);
  await Promise.all(Object.values(COPY_NAMES).map((name) => privateRegularFile(join(root, name))));
  await readReceipt(paths.receipt);
  const proofPath = safeAbsolutePath(
    conservationProof ?? join(root, "collector-conservation.json"),
    "--conservation-proof",
  );
  const proof = await regularProof(proofPath);
  const [native, electron, electronBefore] = await Promise.all([
    stateSummary(paths.native), stateSummary(paths.electron), stateSummary(paths.electronBefore),
  ]);
  if (proof.nativeRows !== native.recordCount || proof.electronRows !== electron.recordCount
      || electronBefore.recordCount !== electron.recordCount || !sameStateMetadata(electronBefore, electron)) {
    fail("private copies do not match the accepted conservation proof", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_PROOF_MISMATCH");
  }
  const [electronHash, beforeHash] = await Promise.all([hashFile(paths.electron), hashFile(paths.electronBefore)]);
  if (electronHash !== beforeHash) {
    fail("Electron baseline copy does not match destination copy", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_BASELINE_MISMATCH");
  }
  const nativeHash = await hashFile(paths.native);
  return Object.freeze({ root, paths, native, electron, electronBefore, baselineHash: beforeHash, nativeHash });
}

export async function planNativeElectronCollectorReconciliation(options = {}) {
  const prepared = await preflight(options);
  const missing = await missingRecords({ sourceFile: prepared.paths.native, destinationFile: prepared.paths.electron });
  if (missing.sourceRecords !== prepared.native.recordCount) {
    fail("source collector-state copy changed during inspection", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_CHANGED");
  }
  return contentFreeResult({ source: prepared.native, destination: prepared.electron, missing: missing.missing, applied: false });
}

export async function reconcileNativeElectronCollectorPrivateCopy({
  copyRoot,
  conservationProof = null,
  confirmAppendOnlyPrivateCopy = false,
} = {}) {
  if (confirmAppendOnlyPrivateCopy !== true) {
    fail("private-copy reconciliation requires explicit confirmation", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_CONFIRMATION_REQUIRED");
  }
  const prepared = await preflight({ copyRoot, conservationProof });
  const initialMissing = await missingRecords({ sourceFile: prepared.paths.native, destinationFile: prepared.paths.electron });
  if (initialMissing.sourceRecords !== prepared.native.recordCount
      || await hashFile(prepared.paths.native) !== prepared.nativeHash) {
    fail("source collector-state copy changed during inspection", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_CHANGED");
  }
  let receipt = {
    schema: SCHEMA,
    status: "preflight_passed",
    sourceRecordCount: prepared.native.recordCount,
    destinationRecordCountBefore: prepared.electron.recordCount,
    missingSourceRecordMultiplicity: initialMissing.missing,
    identitySaltProven: true,
    destinationCheckpointDigest: prepared.electron.checkpointDigest,
    destinationBaselineSha256: prepared.baselineHash,
  };
  await writeReceipt(prepared.paths.receipt, receipt);
  const session = await openLocalCollectorStateSession({ stateFile: prepared.paths.electron });
  let batch = [];
  try {
    const appendedScan = await missingRecords({
      sourceFile: prepared.paths.native,
      destinationFile: prepared.paths.electron,
      async onMissing(record) {
        batch.push(record);
        if (batch.length >= 256) {
          session.commit({ checkpoint: prepared.electron.checkpoint, records: batch });
          batch = [];
        }
      },
    });
    if (batch.length > 0) session.commit({ checkpoint: prepared.electron.checkpoint, records: batch });
    if (appendedScan.sourceRecords !== prepared.native.recordCount
        || await hashFile(prepared.paths.native) !== prepared.nativeHash) {
      fail("source collector-state copy changed during append", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_INPUT_CHANGED");
    }
    receipt = { ...receipt, status: "append_committed", insertedRecordMultiplicity: session.inserted };
    await updateReceipt(prepared.paths.receipt, receipt);
  } finally {
    await session.close();
  }
  const [destinationAfter, baselineAfterHash] = await Promise.all([
    stateSummary(prepared.paths.electron), hashFile(prepared.paths.electronBefore),
  ]);
  const [baselineMissing, sourceMissing] = await Promise.all([
    missingRecords({ sourceFile: prepared.paths.electronBefore, destinationFile: prepared.paths.electron }),
    missingRecords({ sourceFile: prepared.paths.native, destinationFile: prepared.paths.electron }),
  ]);
  const conservation = {
    checkpointPreserved: destinationAfter.checkpointDigest === prepared.electron.checkpointDigest,
    metadataPreserved: sameStateMetadata(destinationAfter, prepared.electron),
    existingRecordsPreserved: baselineMissing.missing === 0 && baselineAfterHash === prepared.baselineHash,
    recordCountAfter: destinationAfter.recordCount,
  };
  if (!conservation.checkpointPreserved || !conservation.metadataPreserved
      || !conservation.existingRecordsPreserved || sourceMissing.missing !== 0
      || destinationAfter.recordCount !== prepared.electron.recordCount + session.inserted
      || session.inserted !== initialMissing.missing) {
    fail("private-copy reconciliation conservation failed", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_CONSERVATION_FAILED");
  }
  const result = contentFreeResult({
    source: prepared.native,
    destination: prepared.electron,
    missing: initialMissing.missing,
    applied: true,
    inserted: session.inserted,
    conservation,
  });
  await updateReceipt(prepared.paths.receipt, { ...receipt, status: "verified", result });
  return result;
}

export function parseNativeElectronCollectorReconciliationArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("collector reconciliation arguments must be an array");
  const options = { copyRoot: null, conservationProof: null, apply: false, confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--copy-root") options.copyRoot = argv[++index] ?? null;
    else if (value === "--conservation-proof") options.conservationProof = argv[++index] ?? null;
    else if (value === "--apply-to-private-copy") options.apply = true;
    else if (value === "--confirm-append-only-private-copy") options.confirm = true;
    else fail("collector reconciliation arguments are invalid");
  }
  if (typeof options.copyRoot !== "string" || options.copyRoot.length === 0) {
    fail("collector reconciliation requires --copy-root");
  }
  if (options.confirm && !options.apply) fail("confirmation requires --apply-to-private-copy");
  if (options.apply && !options.confirm) {
    fail("private-copy reconciliation requires --confirm-append-only-private-copy", "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_CONFIRMATION_REQUIRED");
  }
  return Object.freeze(options);
}

async function main() {
  const options = parseNativeElectronCollectorReconciliationArguments(process.argv.slice(2));
  const result = options.apply
    ? await reconcileNativeElectronCollectorPrivateCopy({
      copyRoot: options.copyRoot,
      conservationProof: options.conservationProof,
      confirmAppendOnlyPrivateCopy: options.confirm,
    })
    : await planNativeElectronCollectorReconciliation({
      copyRoot: options.copyRoot,
      conservationProof: options.conservationProof,
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && samePath(resolve(process.argv[1]), SCRIPT_FILE)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "NATIVE_ELECTRON_COLLECTOR_RECONCILIATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
