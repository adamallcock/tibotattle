import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOCAL_REVIEW_INSTALL_RECEIPT_VERSION =
  "usage-monitor-local-review-install-receipt-v0.1";
const MAXIMUM_INSTALL_FILE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_INSTALL_TOTAL_BYTES = 512 * 1024 * 1024;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code, message = "Local review installation operation failed") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertSafeRelativePath(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || isAbsolute(value)
      || value.split("/").some((part) => part === "" || part === "." || part === "..")
      || value.includes("\\")) {
    fail("LOCAL_REVIEW_INSTALL_INVALID_INVENTORY");
  }
  return value;
}

async function readRegularFile(path, {
  ownerOnly = false,
  maximumBytes = 16 * 1024 * 1024,
} = {}) {
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") fail("LOCAL_REVIEW_INSTALL_FILE_MISSING");
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("LOCAL_REVIEW_INSTALL_UNSAFE_FILE");
  }
  if (ownerOnly && (stat.mode & 0o077) !== 0) {
    fail("LOCAL_REVIEW_INSTALL_UNSAFE_PERMISSIONS");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size > maximumBytes) {
    fail("LOCAL_REVIEW_INSTALL_FILE_TOO_LARGE");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      fail("LOCAL_REVIEW_INSTALL_FILE_CHANGED");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifyFileEvidence(path, {
  bytes,
  sha256: expectedSha256,
}) {
  if (!Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > MAXIMUM_INSTALL_FILE_BYTES
      || typeof expectedSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    fail("LOCAL_REVIEW_INSTALL_INVALID_INVENTORY");
  }
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") fail("LOCAL_REVIEW_INSTALL_FILE_MISSING");
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("LOCAL_REVIEW_INSTALL_UNSAFE_FILE");
  }
  if (stat.size !== bytes) fail("LOCAL_REVIEW_INSTALL_INTEGRITY_MISMATCH");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      fail("LOCAL_REVIEW_INSTALL_FILE_CHANGED");
    }
    while (position < bytes) {
      const length = Math.min(buffer.byteLength, bytes - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1) {
        fail("LOCAL_REVIEW_INSTALL_FILE_CHANGED");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      fail("LOCAL_REVIEW_INSTALL_FILE_CHANGED");
    }
  } finally {
    buffer.fill(0);
    await handle.close();
  }
  if (hash.digest("hex") !== expectedSha256) {
    fail("LOCAL_REVIEW_INSTALL_INTEGRITY_MISMATCH");
  }
}

async function canonicalAbsentTarget(target) {
  if (typeof target !== "string" || !isAbsolute(target)) {
    fail("LOCAL_REVIEW_INSTALL_TARGET_NOT_ABSOLUTE");
  }
  const normalized = resolve(target);
  if (normalized === sep || basename(normalized).length === 0) {
    fail("LOCAL_REVIEW_INSTALL_TARGET_TOO_BROAD");
  }
  const parent = dirname(normalized);
  const canonicalParent = await realpath(parent);
  const canonicalTarget = join(canonicalParent, basename(normalized));
  try {
    await lstat(canonicalTarget);
    fail("LOCAL_REVIEW_INSTALL_TARGET_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return canonicalTarget;
}

async function canonicalInstalledTarget(target) {
  if (typeof target !== "string" || !isAbsolute(target)) {
    fail("LOCAL_REVIEW_INSTALL_TARGET_NOT_ABSOLUTE");
  }
  const normalized = resolve(target);
  if (normalized === sep || basename(normalized).length === 0) {
    fail("LOCAL_REVIEW_INSTALL_TARGET_TOO_BROAD");
  }
  const canonical = await realpath(normalized).catch((error) => {
    if (error.code === "ENOENT") fail("LOCAL_REVIEW_INSTALL_TARGET_MISSING");
    throw error;
  });
  const stat = await lstat(canonical);
  const requestedStat = await lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink() || requestedStat.isSymbolicLink()) {
    fail("LOCAL_REVIEW_INSTALL_TARGET_UNSAFE");
  }
  return canonical;
}

function normalizeManifest(value) {
  if (value?.schemaVersion !== "usage-monitor-local-review-artifact-manifest-v0.1"
      || typeof value.artifactVersion !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.artifactVersion)
      || value.platform?.os !== "darwin"
      || value.platform?.architecture !== "arm64"
      || value.localOnly !== true
      || value.transportReady !== false
      || !Array.isArray(value.inventory)
      || value.inventory.length < 1
      || value.inventory.length > 512) {
    fail("LOCAL_REVIEW_INSTALL_INVALID_MANIFEST");
  }
  const seen = new Set();
  let totalBytes = 0;
  const inventory = value.inventory.map((row) => {
    const path = assertSafeRelativePath(row?.path);
    if (seen.has(path)
        || !/^[a-f0-9]{64}$/.test(row?.sha256)
        || !Number.isSafeInteger(row?.bytes)
        || row.bytes < 0
        || row.bytes > MAXIMUM_INSTALL_FILE_BYTES
        || ![0o600, 0o644, 0o700, 0o755].includes(row?.mode)) {
      fail("LOCAL_REVIEW_INSTALL_INVALID_INVENTORY");
    }
    seen.add(path);
    totalBytes += row.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAXIMUM_INSTALL_TOTAL_BYTES) {
      fail("LOCAL_REVIEW_INSTALL_INVALID_INVENTORY");
    }
    return Object.freeze({
      path,
      sha256: row.sha256,
      bytes: row.bytes,
      mode: row.mode,
    });
  });
  return Object.freeze({
    artifactVersion: value.artifactVersion,
    archiveSha256: value.archiveSha256 ?? null,
    inventory: Object.freeze(inventory),
  });
}

async function readManifest(artifactRoot) {
  const root = await realpath(resolve(artifactRoot));
  const bytes = await readRegularFile(join(root, "artifact-manifest.json"));
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    fail("LOCAL_REVIEW_INSTALL_INVALID_MANIFEST");
  }
  return { root, bytes, manifest: normalizeManifest(parsed) };
}

async function verifyInventory(root, inventory) {
  for (const row of inventory) {
    const source = join(root, row.path);
    await verifyFileEvidence(source, row);
  }
}

export async function verifyLocalReviewArtifact({ artifactRoot } = {}) {
  const { root, bytes: manifestBytes, manifest } = await readManifest(artifactRoot);
  await verifyInventory(root, manifest.inventory);
  return Object.freeze({
    status: "verified",
    artifactVersion: manifest.artifactVersion,
    root,
    manifestSha256: sha256(manifestBytes),
    fileCount: manifest.inventory.length + 1,
    payloadBytes: manifest.inventory.reduce((sum, row) => sum + row.bytes, 0)
      + manifestBytes.byteLength,
    localOnly: true,
    transportReady: false,
  });
}

async function writeOwnerOnlyAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parentDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    let current = dirname(path);
    while (current !== ".") {
      directories.add(current);
      current = dirname(current);
    }
  }
  return [...directories].sort((a, b) => {
    const depth = (value) => value.split("/").length;
    return depth(a) - depth(b) || a.localeCompare(b);
  });
}

export async function installLocalReviewArtifact({
  artifactRoot,
  target,
} = {}) {
  const canonicalTarget = await canonicalAbsentTarget(target);
  const { root, bytes: manifestBytes, manifest } = await readManifest(artifactRoot);
  await verifyInventory(root, manifest.inventory);

  await mkdir(canonicalTarget, { mode: 0o700 });
  await chmod(canonicalTarget, 0o700);
  const paths = [
    ...manifest.inventory.map((row) => row.path),
    "artifact-manifest.json",
  ];
  const directories = parentDirectories(paths);
  const createdFiles = [];
  try {
    for (const directory of directories) {
      await mkdir(join(canonicalTarget, directory), { mode: 0o700 });
      await chmod(join(canonicalTarget, directory), 0o700);
    }

    for (const row of manifest.inventory) {
      const destination = join(canonicalTarget, row.path);
      createdFiles.push(destination);
      await copyFile(join(root, row.path), destination, constants.COPYFILE_EXCL);
      await chmod(destination, row.mode);
      try {
        await verifyFileEvidence(destination, row);
      } catch {
        fail("LOCAL_REVIEW_INSTALL_COPY_MISMATCH");
      }
    }
    const manifestPath = join(canonicalTarget, "artifact-manifest.json");
    createdFiles.push(manifestPath);
    await writeOwnerOnlyAtomic(manifestPath, manifestBytes);

    const installedFiles = [
      ...manifest.inventory,
      {
        path: "artifact-manifest.json",
        sha256: sha256(manifestBytes),
        bytes: manifestBytes.byteLength,
        mode: 0o600,
      },
    ].sort((left, right) => left.path.localeCompare(right.path));
    const receipt = {
      schemaVersion: LOCAL_REVIEW_INSTALL_RECEIPT_VERSION,
      artifactVersion: manifest.artifactVersion,
      target: canonicalTarget,
      installedFiles,
      ordinaryUninstallPreservesParticipantIdentity: true,
      secureErasureClaimed: false,
    };
    const receiptBytes = Buffer.from(stableJson(receipt));
    const receiptPath = join(canonicalTarget, ".install-receipt.json");
    createdFiles.push(receiptPath);
    await writeOwnerOnlyAtomic(receiptPath, receiptBytes);
    return Object.freeze({
      status: "installed",
      artifactVersion: manifest.artifactVersion,
      target: canonicalTarget,
      installedFiles: installedFiles.length + 1,
      receiptSha256: sha256(receiptBytes),
      participantIdentityPreservedOnUninstall: true,
    });
  } catch (error) {
    try {
      for (const path of createdFiles.reverse()) {
        await unlink(path).catch((cleanupError) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        });
      }
      for (const directory of [...directories].reverse()) {
        await rmdir(join(canonicalTarget, directory)).catch((cleanupError) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        });
      }
      await rmdir(canonicalTarget);
    } catch {
      fail("LOCAL_REVIEW_INSTALL_ROLLBACK_FAILED");
    }
    throw error;
  }
}

async function readInstallReceipt(target) {
  const canonicalTarget = await canonicalInstalledTarget(target);
  const path = join(canonicalTarget, ".install-receipt.json");
  const bytes = await readRegularFile(path, { ownerOnly: true });
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail("LOCAL_REVIEW_UNINSTALL_INVALID_RECEIPT");
  }
  if (value?.schemaVersion !== LOCAL_REVIEW_INSTALL_RECEIPT_VERSION
      || value.target !== canonicalTarget
      || value.ordinaryUninstallPreservesParticipantIdentity !== true
      || value.secureErasureClaimed !== false
      || !Array.isArray(value.installedFiles)
      || value.installedFiles.length < 1
      || value.installedFiles.length > 512) {
    fail("LOCAL_REVIEW_UNINSTALL_INVALID_RECEIPT");
  }
  const seen = new Set();
  let totalBytes = 0;
  const installedFiles = value.installedFiles.map((row) => {
    const pathValue = assertSafeRelativePath(row?.path);
    if (seen.has(pathValue)
        || !/^[a-f0-9]{64}$/.test(row?.sha256)
        || !Number.isSafeInteger(row?.bytes)
        || row.bytes < 0
        || row.bytes > MAXIMUM_INSTALL_FILE_BYTES) {
      fail("LOCAL_REVIEW_UNINSTALL_INVALID_RECEIPT");
    }
    seen.add(pathValue);
    totalBytes += row.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAXIMUM_INSTALL_TOTAL_BYTES) {
      fail("LOCAL_REVIEW_UNINSTALL_INVALID_RECEIPT");
    }
    return { path: pathValue, sha256: row.sha256, bytes: row.bytes };
  });
  return {
    canonicalTarget,
    receiptPath: path,
    receiptBytes: bytes,
    installedFiles,
    confirmationToken: sha256(bytes).slice(0, 16).toUpperCase(),
  };
}

async function assertExactInstalledTree(target, installedFiles) {
  const expectedFiles = new Set([
    ...installedFiles.map((row) => row.path),
    ".install-receipt.json",
  ]);
  const expectedDirectories = new Set(
    parentDirectories([...expectedFiles]),
  );
  const actualFiles = new Set();
  const actualDirectories = new Set();
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = relativeDirectory
      ? join(target, relativeDirectory)
      : target;
    const entries = await readdir(directory, { withFileTypes: true });
    if (actualFiles.size + actualDirectories.size + entries.length > 1_024) {
      fail("LOCAL_REVIEW_UNINSTALL_UNEXPECTED_ENTRY");
    }
    for (const entry of entries) {
      const path = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        fail("LOCAL_REVIEW_UNINSTALL_UNEXPECTED_ENTRY");
      }
      if (entry.isDirectory()) {
        actualDirectories.add(path);
        pending.push(path);
      } else if (entry.isFile()) {
        actualFiles.add(path);
      } else {
        fail("LOCAL_REVIEW_UNINSTALL_UNEXPECTED_ENTRY");
      }
    }
  }
  if (actualFiles.size !== expectedFiles.size
      || actualDirectories.size !== expectedDirectories.size
      || [...actualFiles].some((path) => !expectedFiles.has(path))
      || [...actualDirectories].some((path) => !expectedDirectories.has(path))) {
    fail("LOCAL_REVIEW_UNINSTALL_UNEXPECTED_ENTRY");
  }
}

export async function planLocalReviewUninstall({ target } = {}) {
  const state = await readInstallReceipt(target);
  await assertExactInstalledTree(state.canonicalTarget, state.installedFiles);
  let totalBytes = state.receiptBytes.byteLength;
  for (const row of state.installedFiles) {
    try {
      await verifyFileEvidence(join(state.canonicalTarget, row.path), row);
    } catch {
      fail("LOCAL_REVIEW_UNINSTALL_MODIFIED_FILE");
    }
    totalBytes += row.bytes;
  }
  return Object.freeze({
    status: "ready",
    target: state.canonicalTarget,
    fileCount: state.installedFiles.length + 1,
    totalBytes,
    confirmationToken: state.confirmationToken,
    participantIdentityPreserved: true,
    secureErasureClaimed: false,
  });
}

export async function uninstallLocalReviewArtifact({
  target,
  confirmationToken,
} = {}) {
  const state = await readInstallReceipt(target);
  if (typeof confirmationToken !== "string") {
    fail("LOCAL_REVIEW_UNINSTALL_CONFIRMATION_REQUIRED");
  }
  if (confirmationToken !== state.confirmationToken) {
    fail("LOCAL_REVIEW_UNINSTALL_CONFIRMATION_INVALID");
  }
  await planLocalReviewUninstall({ target: state.canonicalTarget });

  const descending = [...state.installedFiles]
    .sort((left, right) => right.path.localeCompare(left.path));
  for (const row of descending) {
    await unlink(join(state.canonicalTarget, row.path));
  }
  await unlink(state.receiptPath);
  const directories = parentDirectories(state.installedFiles.map((row) => row.path))
    .sort((left, right) => {
      const depth = (value) => value.split("/").length;
      return depth(right) - depth(left) || right.localeCompare(left);
    });
  for (const directory of directories) {
    await rmdir(join(state.canonicalTarget, directory));
  }
  await rmdir(state.canonicalTarget);
  return Object.freeze({
    status: "uninstalled",
    target: state.canonicalTarget,
    deletedFiles: state.installedFiles.length + 1,
    participantIdentityPreserved: true,
    secureErasureClaimed: false,
  });
}

export function assertPathInsideArtifact(root, path) {
  const value = relative(root, path);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== "..";
}
