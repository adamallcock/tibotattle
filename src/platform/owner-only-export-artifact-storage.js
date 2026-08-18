import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";
import {
  assertOwnerControlledDirectory,
  lstatIfExists,
  syncDirectory,
} from "./owner-only-filesystem.js";

const REFLECT_APPLY = Reflect.apply;

function boundaryError(message) {
  return new Error(message);
}

function snapshotObject(value, message) {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    throw boundaryError(message);
  }
  return value;
}

function guardedRead(object, key, message) {
  // Public boundary values are data, not behavior.  In particular, do not
  // turn an accessor (or an inherited value) into a capability by reading it.
  // `snapshotObject` has already excluded Proxy objects before descriptor
  // reflection can trigger a proxy trap.
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw boundaryError(message);
  return descriptor.value;
}

function guardedFunction(value, message) {
  if (isProxy(value) || typeof value !== "function") throw boundaryError(message);
  return value;
}

function snapshotFileIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    nlink: stats.nlink,
    uid: stats.uid,
    mode: stats.mode,
  });
}

function sameFileIdentity(stats, expected) {
  return stats.dev === expected.dev && stats.ino === expected.ino
    && stats.size === expected.size && stats.nlink === expected.nlink
    && stats.uid === expected.uid && stats.mode === expected.mode;
}

function assertOwnerOnlyFileStats(stats, {
  label,
  maximumBytes,
  expectedBytes = null,
  maximumLinks = 1,
  exactMode = null,
  errorMessage = null,
} = {}) {
  const valid = stats.isFile() && !stats.isSymbolicLink()
    && stats.nlink >= 1 && stats.nlink <= maximumLinks
    && stats.size >= 1 && stats.size <= maximumBytes
    && (expectedBytes === null || stats.size === expectedBytes)
    && (typeof process.getuid !== "function" || stats.uid === process.getuid())
    && (process.platform === "win32" || (stats.mode & 0o077) === 0)
    && (exactMode === null
      || process.platform === "win32"
      || (stats.mode & 0o777) === exactMode);
  if (!valid) throw new Error(errorMessage ?? `Invalid owner-only export ${label}`);
}

async function invokeBoundaryCallable(callable, receiver, argumentsList, message) {
  try {
    return await REFLECT_APPLY(callable, receiver, argumentsList);
  } catch {
    throw boundaryError(message);
  }
}

/**
 * Create the durable receipt-first pair publisher and recovery owner.
 *
 * The canonical serializer and resource ceilings are injected by the
 * application composition root. This platform owner deliberately cannot
 * import export or application source.
 */
export function createOwnerOnlyExportArtifactStorageContext(configuration = {}) {
  const selected = snapshotObject(
    configuration,
    "Local export storage configuration is invalid",
  );
  const stableJson = guardedRead(
    selected,
    "stableJson",
    "Local export storage configuration is invalid",
  );
  const maximumCanonicalBundleBytes = guardedRead(
    selected,
    "maximumCanonicalBundleBytes",
    "Local export storage configuration is invalid",
  );
  const maximumEncodedArtifactBytes = guardedRead(
    selected,
    "maximumEncodedArtifactBytes",
    "Local export storage configuration is invalid",
  );
  const maximumDirectoryEntries = guardedRead(
    selected,
    "maximumDirectoryEntries",
    "Local export storage configuration is invalid",
  );
  const createResourceLimitError = guardedRead(
    selected,
    "createResourceLimitError",
    "Local export storage configuration is invalid",
  );
  const configuredDirectorySync = guardedRead(
    selected,
    "directorySync",
    "Local export storage configuration is invalid",
  );
  const configuredLockStat = guardedRead(
    selected,
    "lockStat",
    "Local export storage configuration is invalid",
  );
  const configuredRecoveryFileCloseFailpoint = guardedRead(
    selected,
    "recoveryFileCloseFailpoint",
    "Local export storage configuration is invalid",
  );
  if (typeof stableJson !== "function" || isProxy(stableJson)) {
    throw new TypeError("stableJson must be a function");
  }
  if (!Number.isSafeInteger(maximumCanonicalBundleBytes)
      || !Number.isSafeInteger(maximumEncodedArtifactBytes)
      || maximumCanonicalBundleBytes < 1
      || maximumEncodedArtifactBytes < 1) {
    throw new TypeError("owner-only export artifact resource limits must be positive integers");
  }
  if (!Number.isSafeInteger(maximumDirectoryEntries)
      || maximumDirectoryEntries < 1
      || typeof createResourceLimitError !== "function"
      || isProxy(createResourceLimitError)) {
    throw new TypeError("owner-only export artifact directory limits must be configured");
  }
  if (configuredDirectorySync !== undefined
      && (typeof configuredDirectorySync !== "function" || isProxy(configuredDirectorySync))) {
    throw new TypeError("directorySync must be a function when configured");
  }
  if (configuredLockStat !== undefined
      && (typeof configuredLockStat !== "function" || isProxy(configuredLockStat))) {
    throw new TypeError("lockStat must be a function when configured");
  }
  if (configuredRecoveryFileCloseFailpoint !== undefined
      && (typeof configuredRecoveryFileCloseFailpoint !== "function" || isProxy(configuredRecoveryFileCloseFailpoint))) {
    throw new TypeError("recoveryFileCloseFailpoint must be a function when configured");
  }

  async function synchronizeDirectory(directory) {
    if (configuredDirectorySync === undefined) return syncDirectory(directory);
    return invokeBoundaryCallable(
      configuredDirectorySync,
      undefined,
      [directory],
      "Local export storage directory synchronization failed",
    );
  }

  async function readNewLockStats(path) {
    if (configuredLockStat === undefined) return lstat(path);
    return invokeBoundaryCallable(
      configuredLockStat,
      undefined,
      [path],
      "Local export storage lock inspection failed",
    );
  }

  async function closeRecoveryFile(handle) {
    await handle.close();
    if (configuredRecoveryFileCloseFailpoint === undefined) return;
    return invokeBoundaryCallable(
      configuredRecoveryFileCloseFailpoint,
      undefined,
      [],
      "Local export storage recovery file close failed",
    );
  }

  function serializeManifest(manifest) {
    try {
      return REFLECT_APPLY(stableJson, undefined, [manifest]);
    } catch {
      throw boundaryError("Local export storage serializer failed");
    }
  }

  function boundedDirectoryEntries(directory, { sort = false } = {}) {
    return readBoundedDirectoryEntries(directory, {
      maximumEntries: maximumDirectoryEntries,
      sort,
      createLimitError: createResourceLimitError,
    });
  }

  const EXPORT_TRANSACTION_DIRECTORY = ".app-usagemonitor-export-transactions";
  const EXPORT_DESTINATION_LOCK = ".app-usagemonitor-export.lock";
  const EXPORT_DESTINATION_CLAIM_PREFIX = ".app-usagemonitor-export.lock.claim.";
  const EXPORT_TRANSACTION_SCHEMA = "owner-only-pair-transaction-v1";
  const MAX_LOCAL_FIRST_ARTIFACT_BYTES = Math.max(
    maximumCanonicalBundleBytes,
    maximumEncodedArtifactBytes,
  );
  const MAX_LOCAL_RECEIPT_BYTES = 1024 * 1024;
  const destinationStates = new WeakMap();

  function snapshotDirectoryIdentity(stats) {
    return Object.freeze({ dev: stats.dev, ino: stats.ino });
  }

  function sameDirectoryIdentity(stats, expected) {
    return stats.dev === expected.dev && stats.ino === expected.ino;
  }

  function assertOwnerControlledDirectoryStats(stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Export destination must be a real directory");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("Export destination must be owned by the current user");
    }
    if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
      throw new Error("Export destination must not be group- or world-writable");
    }
  }

  // The OS user is the local trust boundary. These path identity checks reject
  // other-UID, symlink, hardlink, and cooperative-process replacement, but
  // Node has no portable openat-style directory capability that could isolate
  // against malicious code already executing as this same user.
  async function assertPinnedDestination(state) {
    const current = await lstat(state.directory);
    assertOwnerControlledDirectoryStats(current);
    if (!sameDirectoryIdentity(current, state.identity)) {
      throw new Error("Owner-only export destination changed");
    }
    return current;
  }

  async function assertPinnedAbsentDestinationParent(state) {
    const current = await lstat(state.parentDirectory);
    assertOwnerControlledDirectoryStats(current);
    if (!sameDirectoryIdentity(current, state.parentIdentity)) {
      throw new Error("Owner-only export destination parent changed");
    }
    return current;
  }

  function requireDestination(destination) {
    const state = destinationStates.get(destination);
    if (!state) throw new Error("Owner-only export destination capability is invalid");
    return state;
  }

  function snapshotOptionalObject(value, message) {
    if (value === undefined) return Object.freeze({});
    return snapshotObject(value, message);
  }

  function snapshotPair(pair) {
    const selectedPair = snapshotOptionalObject(pair, "Paired export request is invalid");
    return Object.freeze({
      firstPath: guardedRead(selectedPair, "firstPath", "Paired export request is invalid"),
      firstContent: guardedRead(selectedPair, "firstContent", "Paired export request is invalid"),
      secondPath: guardedRead(selectedPair, "secondPath", "Paired export request is invalid"),
      secondContent: guardedRead(selectedPair, "secondContent", "Paired export request is invalid"),
    });
  }

  function snapshotDirectoryRequest(request, message) {
    const selectedRequest = snapshotOptionalObject(request, message);
    return Object.freeze({
      directory: guardedRead(selectedRequest, "directory", message),
    });
  }

  function snapshotArtifactRequest(request, message) {
    const selectedRequest = snapshotOptionalObject(request, message);
    const artifactBasename = guardedRead(selectedRequest, "basename", message);
    const maximumBytes = guardedRead(selectedRequest, "maximumBytes", message);
    if (!validBasename(artifactBasename)
        || (maximumBytes !== undefined
          && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
            || maximumBytes > MAX_LOCAL_FIRST_ARTIFACT_BYTES))) {
      throw boundaryError(message);
    }
    return Object.freeze({
      basename: artifactBasename,
      maximumBytes: maximumBytes ?? MAX_LOCAL_FIRST_ARTIFACT_BYTES,
    });
  }

  function snapshotDestinationPair(pair) {
    const selectedPair = snapshotOptionalObject(pair, "Paired export request is invalid");
    const firstBasename = guardedRead(selectedPair, "firstBasename", "Paired export request is invalid");
    const firstContent = guardedRead(selectedPair, "firstContent", "Paired export request is invalid");
    const secondBasename = guardedRead(selectedPair, "secondBasename", "Paired export request is invalid");
    const secondContent = guardedRead(selectedPair, "secondContent", "Paired export request is invalid");
    if (!validBasename(firstBasename) || !validBasename(secondBasename)
        || firstBasename === secondBasename) {
      throw boundaryError("Paired export request is invalid");
    }
    return Object.freeze({ firstBasename, firstContent, secondBasename, secondContent });
  }

  function snapshotOperationOptions(options) {
    const selectedOptions = snapshotOptionalObject(options, "Local export storage options are invalid");
    const linkFile = guardedRead(selectedOptions, "linkFile", "Local export storage options are invalid");
    const failpoint = guardedRead(selectedOptions, "failpoint", "Local export storage options are invalid");
    const lockFailpoint = guardedRead(selectedOptions, "lockFailpoint", "Local export storage options are invalid");
    if (linkFile !== undefined) guardedFunction(linkFile, "Local export storage options are invalid");
    if (failpoint !== undefined) guardedFunction(failpoint, "Local export storage options are invalid");
    if (lockFailpoint !== undefined) guardedFunction(lockFailpoint, "Local export storage options are invalid");
    return Object.freeze({
      linkFile: linkFile ?? link,
      failpoint: failpoint ?? (async () => {}),
      lockFailpoint: lockFailpoint ?? (async () => {}),
    });
  }

  async function callOperationPort(port, receiver, argumentsList) {
    // A port is read once at the public boundary. Preserve its operation error
    // after that point: it is the primary write/recovery result and callers
    // rely on it to decide whether a transaction must be replayed. Getter and
    // shape failures are still normalized during the snapshot above.
    return REFLECT_APPLY(port, receiver, argumentsList);
  }

  async function callFailpoint(options, marker) {
    return callOperationPort(
      options.failpoint,
      undefined,
      [marker],
    );
  }

  async function callLockFailpoint(options, marker) {
    return callOperationPort(
      options.lockFailpoint,
      undefined,
      [marker],
    );
  }

  async function callLinkFile(options, source, destination) {
    return callOperationPort(
      options.linkFile,
      undefined,
      [source, destination],
    );
  }
  
  function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
  }
  
  function pairContentByteLength(value) {
    if (typeof value === "string") return Buffer.byteLength(value, "utf8");
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
    throw new Error("Paired export contents must be strings, Buffers, or Uint8Arrays");
  }
  
  function normalizePairContent(value) {
    return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  }
  
  function validBasename(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255
      && basename(value) === value && value !== "." && value !== ".."
      && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
  }

  async function assertPathAbsent(path) {
    const stats = await lstatIfExists(path);
    if (!stats) return;
    throw new Error("Refusing to overwrite an existing local export artifact");
  }

  async function prepareOwnerOnlyFile(path, content) {
    const expectedBytes = Buffer.byteLength(content);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content);
      const written = await handle.stat();
      assertOwnerOnlyFileStats(written, {
        label: "staging artifact",
        maximumBytes: expectedBytes,
        expectedBytes,
        maximumLinks: 1,
        exactMode: 0o600,
      });
      const writtenIdentity = snapshotFileIdentity(written);
      const pathAfterWrite = await lstat(path);
      if (!sameFileIdentity(pathAfterWrite, writtenIdentity)) {
        throw new Error("Export staging artifact changed after write");
      }
      await handle.sync();
      const synced = await handle.stat();
      const pathAfterSync = await lstat(path);
      if (!sameFileIdentity(synced, writtenIdentity)
          || !sameFileIdentity(pathAfterSync, writtenIdentity)) {
        throw new Error("Export staging artifact changed after synchronization");
      }
    } finally {
      await handle.close();
    }
  }
  
  async function readOwnerOnlyRecoveryFile(path, {
    label,
    maximumBytes,
    expectedBytes = null,
    maximumLinks = 1,
  } = {}) {
    const pathStats = await lstat(path);
    assertOwnerOnlyFileStats(pathStats, {
      label: `recovery ${label}`,
      maximumBytes,
      expectedBytes,
      maximumLinks,
      errorMessage: `Invalid export recovery ${label}`,
    });
    const pathIdentity = snapshotFileIdentity(pathStats);
    let handle;
    let readCompleted = false;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const descriptorStats = await handle.stat();
      assertOwnerOnlyFileStats(descriptorStats, {
        label: `recovery ${label}`,
        maximumBytes,
        expectedBytes,
        maximumLinks,
        errorMessage: `Invalid export recovery ${label}`,
      });
      if (!sameFileIdentity(descriptorStats, pathIdentity)) {
        throw new Error(`Export recovery ${label} changed during open`);
      }
      // FileHandle.readFile reads until EOF.  A same-owner append between the
      // descriptor snapshot and that call could therefore exceed the bounded
      // allocation contract. Read exactly the validated descriptor size by
      // positioned chunks, then probe one byte past it before identity checks.
      const bytes = Buffer.allocUnsafe(descriptorStats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1
            || bytesRead > bytes.length - offset) {
          throw new Error(`Export recovery ${label} changed during read`);
        }
        offset += bytesRead;
      }
      const overflow = Buffer.allocUnsafe(1);
      const { bytesRead: overflowBytes } = await handle.read(
        overflow,
        0,
        overflow.length,
        descriptorStats.size,
      );
      if (overflowBytes !== 0) throw new Error(`Export recovery ${label} changed during read`);
      const descriptorAfterRead = await handle.stat();
      const pathAfterRead = await lstat(path);
      if (!sameFileIdentity(descriptorAfterRead, pathIdentity)
          || !sameFileIdentity(pathAfterRead, pathIdentity)) {
        throw new Error(`Export recovery ${label} changed during read`);
      }
      readCompleted = true;
      return { bytes, stats: descriptorStats };
    } finally {
      if (handle) {
        try {
          await closeRecoveryFile(handle);
        } catch {
          // A failed read remains the primary result. A successful read must not
          // report success when its descriptor could not be closed.
          if (readCompleted) {
            throw new Error("Local export storage recovery file close failed");
          }
        }
      }
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
    if (serializeManifest(manifest) !== bytes.toString("utf8")) throw new Error("Non-canonical export recovery manifest");
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
    if (manifest.artifacts.bundle.bytes > MAX_LOCAL_FIRST_ARTIFACT_BYTES
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
  
  async function cleanupPairTransaction(transactionDirectory, transactionRoot, destinationDirectory, manifest, options) {
    await unlink(join(transactionDirectory, "manifest.json"));
    await callFailpoint(options, "after_manifest_cleanup");
    await unlink(join(transactionDirectory, manifest.artifacts.bundle.stageName));
    await unlink(join(transactionDirectory, manifest.artifacts.receipt.stageName));
    await rmdir(transactionDirectory);
    await synchronizeDirectory(transactionRoot);
    await rmdir(transactionRoot).catch((error) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
    await synchronizeDirectory(destinationDirectory);
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
    await synchronizeDirectory(transactionRoot).catch(() => {});
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
  
  async function withExportDestinationLock(destinationDirectory, callback, options) {
    const lockPath = join(destinationDirectory, EXPORT_DESTINATION_LOCK);
    const target = `pid=${process.pid};token=${randomUUID()}`;
    const claimName = `${EXPORT_DESTINATION_CLAIM_PREFIX}${process.pid}.${randomUUID()}`;
    const claimPath = join(destinationDirectory, claimName);
    let lockOwnership = null;
    let claimOwnership = null;

    async function unlinkVerifiedOwnedLock(path, expectedStats, changedMessage) {
      const current = await lstatIfExists(path);
      if (!current) return false;
      if (!current.isSymbolicLink()
          || current.dev !== expectedStats.dev
          || current.ino !== expectedStats.ino
          || (typeof process.getuid === "function" && current.uid !== process.getuid())) {
        throw new Error(changedMessage);
      }
      await unlink(path);
      await synchronizeDirectory(destinationDirectory);
      return true;
    }

    async function releaseOwnedClaim() {
      if (!claimOwnership) return;
      const ownership = claimOwnership;
      claimOwnership = null;
      await unlinkVerifiedOwnedLock(
        claimPath,
        ownership,
        "Local export destination claim changed before release",
      );
    }

    async function releaseOwnedLock() {
      if (!lockOwnership) return;
      const ownership = lockOwnership;
      lockOwnership = null;
      await unlinkVerifiedOwnedLock(
        lockPath,
        ownership,
        "Local export destination lock changed before release",
      );
    }

    async function cleanupAfterFailedAcquisition(primaryError) {
      let cleanupError;
      for (const release of [releaseOwnedLock, releaseOwnedClaim]) {
        try {
          await release();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (!primaryError && cleanupError) throw cleanupError;
      return cleanupError;
    }

    async function throwAfterAcquisitionCleanup(error) {
      await cleanupAfterFailedAcquisition(error);
      if (error?.code === "ENOENT" || error?.code === "EEXIST") {
        throw new Error("Local export destination is busy");
      }
      throw error;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claimNames = (await boundedDirectoryEntries(destinationDirectory))
        .filter((name) => name.startsWith(EXPORT_DESTINATION_CLAIM_PREFIX));
      await callLockFailpoint(options, "after_claim_scan");
      if (claimNames.length > 1) throw new Error("Local export destination has conflicting lock claims");
      if (claimNames.length === 1 && claimNames[0] !== claimName) {
        const match = /^\.app-usagemonitor-export\.lock\.claim\.(\d+)\.([0-9a-f-]{36})$/.exec(claimNames[0]);
        if (!match) throw new Error("Local export destination has an invalid lock claim");
        const claimOwner = Number(match[1]);
        if (!Number.isSafeInteger(claimOwner) || claimOwner < 1 || processIsRunning(claimOwner)) {
          throw new Error("Local export destination is busy");
        }
        const staleClaim = await readExportDestinationLock(join(destinationDirectory, claimNames[0]));
        try {
          await rename(join(destinationDirectory, claimNames[0]), claimPath);
          // Record the inode before an awaited durability or failpoint boundary.
          claimOwnership = staleClaim.stats;
          await synchronizeDirectory(destinationDirectory);
          await callLockFailpoint(options, "after_claim_acquired");
        } catch (error) {
          await throwAfterAcquisitionCleanup(error);
        }
      }

      if (claimOwnership) {
        const current = await lstatIfExists(lockPath);
        if (current) {
          const existing = await readExportDestinationLock(lockPath);
          if (processIsRunning(existing.pid)) {
            const busy = new Error("Local export destination is busy");
            await cleanupAfterFailedAcquisition(busy);
            throw busy;
          }
          try {
            await unlinkVerifiedOwnedLock(
              lockPath,
              existing.stats,
              "Local export destination lock changed during claim handoff",
            );
          } catch (error) {
            await throwAfterAcquisitionCleanup(error);
          }
        }
        try {
          await symlink(target, lockPath);
          lockOwnership = await readNewLockStats(lockPath);
          await synchronizeDirectory(destinationDirectory);
          await releaseOwnedClaim();
          break;
        } catch (error) {
          await throwAfterAcquisitionCleanup(error);
        }
      }

      try {
        await symlink(target, lockPath);
        lockOwnership = await readNewLockStats(lockPath);
        await synchronizeDirectory(destinationDirectory);
        const postAcquireClaims = (await boundedDirectoryEntries(destinationDirectory))
          .filter((name) => name.startsWith(EXPORT_DESTINATION_CLAIM_PREFIX));
        if (postAcquireClaims.length > 0) {
          const busy = new Error("Local export destination is busy");
          await cleanupAfterFailedAcquisition(busy);
          throw busy;
        }
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          await throwAfterAcquisitionCleanup(error);
        }
        const existing = await readExportDestinationLock(lockPath);
        if (processIsRunning(existing.pid)) throw new Error("Local export destination is busy");
        try {
          await rename(lockPath, claimPath);
          // As above, acquire ownership before a failure-capable operation.
          claimOwnership = existing.stats;
          await synchronizeDirectory(destinationDirectory);
          await callLockFailpoint(options, "after_claim_acquired");
        } catch (claimError) {
          await throwAfterAcquisitionCleanup(claimError);
        }
      }
    }
    if (!lockOwnership) throw new Error("Unable to acquire local export destination lock");
    let result;
    let primaryError;
    try {
      result = await callback();
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      await cleanupAfterFailedAcquisition(primaryError);
      throw primaryError;
    }
    await releaseOwnedLock();
    return result;
  }
  
  async function withExportDestinationLease(directory, callback, options = undefined) {
    if (!directory) throw new Error("Export destination directory is required");
    if (typeof directory !== "string") throw new TypeError("Export destination directory is required");
    const leaseCallback = guardedFunction(callback, "Export destination lease callback is required");
    const selectedOptions = snapshotOperationOptions(options);
    const target = resolve(directory);
    await assertOwnerControlledDirectory(target);
    const canonicalTarget = await realpath(target);
    const canonicalStats = await lstat(canonicalTarget);
    return withExportDestinationLock(
      canonicalTarget,
      () => REFLECT_APPLY(leaseCallback, undefined, [canonicalTarget, canonicalStats]),
      selectedOptions,
    );
  }

  /**
   * Open a destination as an opaque, owner-only capability.  Inspection never
   * creates the requested directory: an absent destination remains absent
   * until the first publication explicitly needs it.
   */
  async function openOwnerOnlyExportDestination(request = undefined) {
    const selectedRequest = snapshotDirectoryRequest(
      request,
      "Export destination request is invalid",
    );
    if (typeof selectedRequest.directory !== "string" || !selectedRequest.directory) {
      throw new Error("Export destination directory is required");
    }
    const requested = resolve(selectedRequest.directory);
    const destinationStats = await lstatIfExists(requested);
    let state;
    if (destinationStats) {
      assertOwnerControlledDirectoryStats(destinationStats);
      const canonicalDirectory = await realpath(requested);
      const canonicalStats = await lstat(canonicalDirectory);
      assertOwnerControlledDirectoryStats(canonicalStats);
      if (!sameDirectoryIdentity(canonicalStats, snapshotDirectoryIdentity(destinationStats))) {
        throw new Error("Owner-only export destination changed during open");
      }
      state = {
        directory: canonicalDirectory,
        identity: snapshotDirectoryIdentity(canonicalStats),
        status: "present",
        parentDirectory: null,
        parentIdentity: null,
      };
    } else {
      const requestedName = basename(requested);
      if (!validBasename(requestedName)) {
        throw new Error("Export destination directory is invalid");
      }
      const parentDirectory = dirname(requested);
      const requestedParentStats = await lstat(parentDirectory);
      assertOwnerControlledDirectoryStats(requestedParentStats);
      const canonicalParent = await realpath(parentDirectory);
      const parentStats = await lstat(canonicalParent);
      assertOwnerControlledDirectoryStats(parentStats);
      if (!sameDirectoryIdentity(parentStats, snapshotDirectoryIdentity(requestedParentStats))) {
        throw new Error("Owner-only export destination parent changed during open");
      }
      state = {
        directory: join(canonicalParent, requestedName),
        identity: null,
        status: "absent",
        parentDirectory: canonicalParent,
        parentIdentity: snapshotDirectoryIdentity(parentStats),
      };
    }
    const destination = Object.freeze(Object.create(null));
    destinationStates.set(destination, state);
    return Object.freeze({ destination, status: state.status });
  }

  async function ensureWritableDestination(state) {
    if (state.status === "present") {
      await assertPinnedDestination(state);
      return state.directory;
    }
    await assertPinnedAbsentDestinationParent(state);
    try {
      await mkdir(state.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const destinationStats = await lstat(state.directory);
    assertOwnerControlledDirectoryStats(destinationStats);
    await assertPinnedAbsentDestinationParent(state);
    state.identity = snapshotDirectoryIdentity(destinationStats);
    state.status = "present";
    await assertPinnedDestination(state);
    return state.directory;
  }

  async function enumerateOwnerOnlyExportDestinationEntries(destination) {
    const state = requireDestination(destination);
    if (state.status === "absent") {
      await assertPinnedAbsentDestinationParent(state);
      return Object.freeze([]);
    }
    await assertPinnedDestination(state);
    const entries = await boundedDirectoryEntries(state.directory, { sort: true });
    await assertPinnedDestination(state);
    return Object.freeze([...entries]);
  }

  async function readOwnerOnlyExportArtifactIfPresent(destination, request = undefined) {
    const state = requireDestination(destination);
    const selectedRequest = snapshotArtifactRequest(
      request,
      "Owner-only export artifact request is invalid",
    );
    if (state.status === "absent") {
      await assertPinnedAbsentDestinationParent(state);
      return Object.freeze({ status: "absent" });
    }
    await assertPinnedDestination(state);
    const artifactPath = join(state.directory, selectedRequest.basename);
    const initial = await lstatIfExists(artifactPath);
    if (!initial) return Object.freeze({ status: "absent" });
    // Re-run the full lstat -> O_NOFOLLOW -> descriptor -> post-read sequence
    // rather than trusting the existence probe above.
    const { bytes } = await readOwnerOnlyRecoveryFile(artifactPath, {
      label: "artifact",
      maximumBytes: selectedRequest.maximumBytes,
      maximumLinks: 1,
    });
    await assertPinnedDestination(state);
    return Object.freeze({ status: "present", bytes: Buffer.from(bytes) });
  }

  async function projectOwnerOnlyExportArtifactPath(destination, request = undefined) {
    const state = requireDestination(destination);
    const selectedRequest = snapshotArtifactRequest(
      request,
      "Owner-only export artifact request is invalid",
    );
    if (state.status === "present") await assertPinnedDestination(state);
    else await assertPinnedAbsentDestinationParent(state);
    return join(state.directory, selectedRequest.basename);
  }
  
  async function unlinkSameInode(path, expectedStats) {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== expectedStats.dev || current.ino !== expectedStats.ino) {
      throw new Error("Export recovery destination changed before cleanup");
    }
    await unlink(path);
  }
  
  async function writeOwnerOnlyPairNoClobberUnlocked(pair, options) {
    const { firstPath, firstContent, secondPath, secondContent } = pair;
    const firstBytes = pairContentByteLength(firstContent);
    const secondBytes = pairContentByteLength(secondContent);
    if (firstBytes < 1 || firstBytes > MAX_LOCAL_FIRST_ARTIFACT_BYTES
        || secondBytes < 1 || secondBytes > MAX_LOCAL_RECEIPT_BYTES) {
      throw new Error("Paired export contents exceed local artifact bounds");
    }
    // Snapshot caller-owned binary views only after the no-allocation bounds
    // check so subsequent mutation cannot invalidate the staged digest.
    const normalizedFirstContent = normalizePairContent(firstContent);
    const normalizedSecondContent = normalizePairContent(secondContent);
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
      await prepareOwnerOnlyFile(bundleStage, normalizedFirstContent);
      await prepareOwnerOnlyFile(receiptStage, normalizedSecondContent);
      await synchronizeDirectory(transactionDirectory);
      transactionPrepared = true;
      await callFailpoint(options, "after_transaction_prepare");
      const manifest = {
        schemaVersion: EXPORT_TRANSACTION_SCHEMA,
        transactionId,
        artifacts: {
          bundle: {
            finalName: basename(firstResolved),
            stageName: basename(bundleStage),
            bytes: firstBytes,
            sha256: sha256(normalizedFirstContent),
          },
          receipt: {
            finalName: basename(secondResolved),
            stageName: basename(receiptStage),
            bytes: secondBytes,
            sha256: sha256(normalizedSecondContent),
          },
        },
      };
      await prepareOwnerOnlyFile(manifestPrepared, serializeManifest(manifest));
      await synchronizeDirectory(transactionDirectory);
      await callFailpoint(options, "after_manifest_prepare");
      await link(manifestPrepared, manifestPath);
      await synchronizeDirectory(transactionDirectory);
      await callFailpoint(options, "after_manifest_link");
      await unlink(manifestPrepared);
      await synchronizeDirectory(transactionDirectory);
      await synchronizeDirectory(transactionRoot);
      await callFailpoint(options, "after_manifest");
      await callLinkFile(options, receiptStage, secondResolved);
      await synchronizeDirectory(destinationDirectory);
      await callFailpoint(options, "after_receipt");
      await callLinkFile(options, bundleStage, firstResolved);
      await synchronizeDirectory(destinationDirectory);
      await callFailpoint(options, "after_bundle");
      await cleanupPairTransaction(transactionDirectory, transactionRoot, destinationDirectory, manifest, options);
    } catch (error) {
      if (!transactionPrepared) await abandonUncommittedTransaction(transactionDirectory, transactionRoot);
      throw error;
    }
  }
  
  async function writeOwnerOnlyPairNoClobber(pair = undefined, options = undefined) {
    const selectedPair = snapshotPair(pair);
    const selectedOptions = snapshotOperationOptions(options);
    const { firstPath, secondPath } = selectedPair;
    if (!firstPath || !secondPath || typeof firstPath !== "string" || typeof secondPath !== "string") {
      throw new Error("Bundle and privacy receipt paths are required");
    }
    const first = resolve(firstPath);
    const second = resolve(secondPath);
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
      ...selectedPair,
      firstPath: join(canonicalFirstDirectory, basename(first)),
      secondPath: join(canonicalSecondDirectory, basename(second)),
    };
    return withExportDestinationLock(canonicalFirstDirectory, () =>
      writeOwnerOnlyPairNoClobberUnlocked(canonicalPair, selectedOptions), selectedOptions);
  }
  
  async function writeOwnerOnlyPairNoClobberUnderLease(pair = undefined, options = undefined) {
    const selectedPair = snapshotPair(pair);
    const selectedOptions = snapshotOperationOptions(options);
    const { firstPath, secondPath } = selectedPair;
    if (!firstPath || !secondPath || typeof firstPath !== "string" || typeof secondPath !== "string") {
      throw new Error("Bundle and privacy receipt paths are required");
    }
    const first = resolve(firstPath);
    const second = resolve(secondPath);
    const firstDirectory = dirname(first);
    const secondDirectory = dirname(second);
    await assertOwnerControlledDirectory(firstDirectory);
    await assertOwnerControlledDirectory(secondDirectory);
    const canonicalFirstDirectory = await realpath(firstDirectory);
    const canonicalSecondDirectory = await realpath(secondDirectory);
    if (canonicalFirstDirectory !== canonicalSecondDirectory) {
      throw new Error("Bundle and privacy receipt must share one canonical destination directory");
    }
    return writeOwnerOnlyPairNoClobberUnlocked({
      ...selectedPair,
      firstPath: join(canonicalFirstDirectory, basename(first)),
      secondPath: join(canonicalSecondDirectory, basename(second)),
    }, selectedOptions);
  }
  
  async function recoverOwnerOnlyPairTransactionsUnlocked(request, options) {
    const { directory } = request;
    if (!directory) throw new Error("Export recovery directory is required");
    const destinationDirectory = resolve(directory);
    await assertOwnerControlledDirectory(destinationDirectory);
    const destinationResolved = await realpath(destinationDirectory);
    const transactionRoot = join(destinationResolved, EXPORT_TRANSACTION_DIRECTORY);
    const rootStats = await lstatIfExists(transactionRoot);
    if (!rootStats) return { recovered: 0, transactionsFound: 0 };
    await assertOwnerControlledDirectory(transactionRoot);
    const transactionNames = await boundedDirectoryEntries(transactionRoot, { sort: true });
    let recovered = 0;
    for (const transactionName of transactionNames) {
      if (!/^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionName)
          || basename(transactionName) !== transactionName) {
        throw new Error("Unexpected entry in export transaction directory");
      }
      const transactionDirectory = join(transactionRoot, transactionName);
      await assertOwnerControlledDirectory(transactionDirectory);
      const entries = await boundedDirectoryEntries(transactionDirectory, { sort: true });
      if (!entries.includes("manifest.json")) {
        if (entries.some((name) => !["bundle.stage", "manifest.prepared", "receipt.stage"].includes(name))) {
          throw new Error("Invalid manifestless export recovery transaction");
        }
        for (const name of entries) {
          await assertOwnerOnlyOrphan(join(transactionDirectory, name));
          await unlink(join(transactionDirectory, name));
        }
        await rmdir(transactionDirectory);
        await synchronizeDirectory(transactionRoot);
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
        await synchronizeDirectory(transactionDirectory);
      }
      const manifest = await readTransactionManifest(join(transactionDirectory, "manifest.json"));
      if (manifest.transactionId !== transactionName) throw new Error("Export recovery transaction identity mismatch");
      const bundleStage = join(transactionDirectory, manifest.artifacts.bundle.stageName);
      const receiptStage = join(transactionDirectory, manifest.artifacts.receipt.stageName);
      const bundleFinal = join(destinationResolved, manifest.artifacts.bundle.finalName);
      const receiptFinal = join(destinationResolved, manifest.artifacts.receipt.finalName);
      const bundleStats = await assertStagedArtifact(
        bundleStage,
        manifest.artifacts.bundle,
        MAX_LOCAL_FIRST_ARTIFACT_BYTES,
      );
      const receiptStats = await assertStagedArtifact(receiptStage, manifest.artifacts.receipt, MAX_LOCAL_RECEIPT_BYTES);
      let bundleState = await finalState(bundleFinal, bundleStats);
      let receiptState = await finalState(receiptFinal, receiptStats);
      if (bundleState === "conflict" || receiptState === "conflict") {
        throw new Error("Export recovery stopped at a conflicting destination artifact");
      }
      if (bundleState === "same_inode" && receiptState === "absent") {
        await unlinkSameInode(bundleFinal, bundleStats);
        await synchronizeDirectory(destinationResolved);
        bundleState = "absent";
      }
      if (receiptState === "absent") {
        await callLinkFile(options, receiptStage, receiptFinal);
        await synchronizeDirectory(destinationResolved);
        receiptState = "same_inode";
        await callFailpoint(options, "after_receipt");
      }
      if (bundleState === "absent") {
        await callLinkFile(options, bundleStage, bundleFinal);
        await synchronizeDirectory(destinationResolved);
        await callFailpoint(options, "after_bundle");
      }
      await cleanupPairTransaction(transactionDirectory, transactionRoot, destinationResolved, manifest, options);
      recovered += 1;
    }
    await rmdir(transactionRoot).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
    await synchronizeDirectory(destinationResolved);
    return { recovered, transactionsFound: transactionNames.length };
  }
  
  async function recoverOwnerOnlyPairTransactions(request = undefined, options = undefined) {
    const selectedRequest = snapshotDirectoryRequest(request, "Export recovery request is invalid");
    const selectedOptions = snapshotOperationOptions(options);
    const { directory } = selectedRequest;
    if (!directory) throw new Error("Export recovery directory is required");
    if (typeof directory !== "string") throw new Error("Export recovery directory is required");
    const destinationDirectory = resolve(directory);
    await assertOwnerControlledDirectory(destinationDirectory);
    const canonicalDirectory = await realpath(destinationDirectory);
    return withExportDestinationLock(canonicalDirectory, () =>
      recoverOwnerOnlyPairTransactionsUnlocked({ directory: canonicalDirectory }, selectedOptions), selectedOptions);
  }
  
  async function recoverOwnerOnlyPairTransactionsUnderLease(request = undefined, options = undefined) {
    const selectedRequest = snapshotDirectoryRequest(request, "Export recovery request is invalid");
    const selectedOptions = snapshotOperationOptions(options);
    const { directory } = selectedRequest;
    if (!directory) throw new Error("Export recovery directory is required");
    if (typeof directory !== "string") throw new Error("Export recovery directory is required");
    const destinationDirectory = resolve(directory);
    await assertOwnerControlledDirectory(destinationDirectory);
    const canonicalDirectory = await realpath(destinationDirectory);
    return recoverOwnerOnlyPairTransactionsUnlocked({ directory: canonicalDirectory }, selectedOptions);
  }

  async function recoverOwnerOnlyPairTransactionsForDestination(destination, options = undefined) {
    const state = requireDestination(destination);
    const selectedOptions = snapshotOperationOptions(options);
    if (state.status === "absent") {
      await assertPinnedAbsentDestinationParent(state);
      return { recovered: 0, transactionsFound: 0 };
    }
    await assertPinnedDestination(state);
    return withExportDestinationLock(state.directory, async () => {
      await assertPinnedDestination(state);
      const result = await recoverOwnerOnlyPairTransactionsUnlocked(
        { directory: state.directory },
        selectedOptions,
      );
      await assertPinnedDestination(state);
      return result;
    }, selectedOptions);
  }

  async function writeOwnerOnlyPairNoClobberForDestination(
    destination,
    pair = undefined,
    options = undefined,
  ) {
    const state = requireDestination(destination);
    const selectedPair = snapshotDestinationPair(pair);
    const selectedOptions = snapshotOperationOptions(options);
    const directory = await ensureWritableDestination(state);
    const result = await withExportDestinationLock(directory, async () => {
      await assertPinnedDestination(state);
      await writeOwnerOnlyPairNoClobberUnlocked({
        firstPath: join(directory, selectedPair.firstBasename),
        firstContent: selectedPair.firstContent,
        secondPath: join(directory, selectedPair.secondBasename),
        secondContent: selectedPair.secondContent,
      }, selectedOptions);
      await assertPinnedDestination(state);
    }, selectedOptions);
    // A formerly absent capability only becomes reusable after both the
    // publication and its post-write pinned-directory validation succeed.
    await assertPinnedDestination(state);
    return result;
  }
  
  
  return Object.freeze({
    enumerateOwnerOnlyExportDestinationEntries,
    openOwnerOnlyExportDestination,
    projectOwnerOnlyExportArtifactPath,
    readOwnerOnlyExportArtifactIfPresent,
    recoverOwnerOnlyPairTransactionsForDestination,
    recoverOwnerOnlyPairTransactions,
    recoverOwnerOnlyPairTransactionsUnderLease,
    withExportDestinationLease,
    writeOwnerOnlyPairNoClobberForDestination,
    writeOwnerOnlyPairNoClobber,
    writeOwnerOnlyPairNoClobberUnderLease,
  });
}
