import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_FILE_SYSTEM = Object.freeze({
  allocate(size) {
    return Buffer.allocUnsafe(size);
  },
  lstat,
  open,
  realpath,
});

function failureContext(createError) {
  if (typeof createError !== "function") {
    throw new TypeError("createError must be a function");
  }
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      const error = createError(code);
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      return error instanceof Error && issued.has(error);
    },
  });
}

function assertPositiveSafeInteger(value, code, failures) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failures.fail(code);
  }
}

function assertOwnerOnlyRegular(
  stats,
  label,
  maximumBytes,
  failures,
) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    failures.fail(`${label}_not_regular`);
  }
  if (stats.nlink !== 1) failures.fail(`${label}_link_count`);
  if (
    !Number.isSafeInteger(stats.size)
    || stats.size < 1
    || stats.size > maximumBytes
  ) {
    failures.fail(`${label}_size`);
  }
  if (
    typeof process.getuid === "function"
    && stats.uid !== process.getuid()
  ) {
    failures.fail(`${label}_owner`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    failures.fail(`${label}_permissions`);
  }
}

function assertOwnerControlledDirectory(stats, failures) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    failures.fail("parent_directory_type");
  }
  if (
    typeof process.getuid === "function"
    && stats.uid !== process.getuid()
  ) {
    failures.fail("parent_directory_owner");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    failures.fail("parent_directory_permissions");
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameReadVersion(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parentSnapshot(canonicalPath, stats) {
  return Object.freeze({
    canonicalPath,
    dev: stats.dev,
    ino: stats.ino,
  });
}

function sameParentIdentity(snapshot, canonicalPath, stats) {
  return canonicalPath === snapshot.canonicalPath
    && stats.dev === snapshot.dev
    && stats.ino === snapshot.ino;
}

function validatedFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem !== "object") {
    throw new TypeError("fileSystem must be an object");
  }
  for (const name of ["allocate", "lstat", "open", "realpath"]) {
    if (typeof fileSystem[name] !== "function") {
      throw new TypeError(`fileSystem.${name} must be a function`);
    }
  }
  return fileSystem;
}

async function inspectParent(parentPath, failures, fileSystem) {
  try {
    const canonicalPath = await fileSystem.realpath(parentPath);
    const stats = await fileSystem.lstat(canonicalPath);
    assertOwnerControlledDirectory(stats, failures);
    return parentSnapshot(canonicalPath, stats);
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("parent_directory");
  }
}

async function revalidateParent(
  requestedParentPath,
  snapshot,
  failures,
  fileSystem,
) {
  try {
    const canonicalPath = await fileSystem.realpath(requestedParentPath);
    const stats = await fileSystem.lstat(canonicalPath);
    assertOwnerControlledDirectory(stats, failures);
    if (!sameParentIdentity(snapshot, canonicalPath, stats)) {
      failures.fail("parent_directory_changed");
    }
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("parent_directory_changed");
  }
}

function allocateExact(size, fileSystem) {
  const bytes = fileSystem.allocate(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new TypeError(
      "fileSystem.allocate must return exact Uint8Array storage",
    );
  }
  return bytes;
}

async function readExactDescriptorBytes(
  handle,
  descriptorStats,
  label,
  failures,
  fileSystem,
) {
  const expectedSize = descriptorStats.size;
  const bytes = allocateExact(expectedSize, fileSystem);
  let offset = 0;
  while (offset < expectedSize) {
    const requestedBytes = expectedSize - offset;
    const result = await handle.read(
      bytes,
      offset,
      requestedBytes,
      offset,
    );
    if (
      !result
      || !Number.isSafeInteger(result.bytesRead)
      || result.bytesRead < 0
      || result.bytesRead > requestedBytes
      || result.bytesRead === 0
    ) {
      failures.fail(`${label}_changed_during_read`);
    }
    offset += result.bytesRead;
  }

  const growthProbe = allocateExact(1, fileSystem);
  const probeResult = await handle.read(
    growthProbe,
    0,
    1,
    expectedSize,
  );
  if (
    !probeResult
    || !Number.isSafeInteger(probeResult.bytesRead)
    || probeResult.bytesRead < 0
    || probeResult.bytesRead > 1
  ) {
    failures.fail(`${label}_read`);
  }
  if (probeResult.bytesRead !== 0) {
    failures.fail(`${label}_changed_during_read`);
  }
  return bytes;
}

async function readOwnerOnlyArtifact(
  path,
  requestedParentPath,
  parent,
  label,
  maximumBytes,
  failures,
  fileSystem,
) {
  await revalidateParent(
    requestedParentPath,
    parent,
    failures,
    fileSystem,
  );
  let pathStats;
  try {
    pathStats = await fileSystem.lstat(path);
  } catch {
    failures.fail(`${label}_missing`);
  }
  assertOwnerOnlyRegular(pathStats, label, maximumBytes, failures);
  let handle;
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const descriptorStats = await handle.stat();
    assertOwnerOnlyRegular(
      descriptorStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(descriptorStats, pathStats)) {
      failures.fail(`${label}_changed_during_open`);
    }
    await revalidateParent(
      requestedParentPath,
      parent,
      failures,
      fileSystem,
    );
    const bytes = await readExactDescriptorBytes(
      handle,
      descriptorStats,
      label,
      failures,
      fileSystem,
    );
    const postDescriptorStats = await handle.stat();
    assertOwnerOnlyRegular(
      postDescriptorStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(descriptorStats, postDescriptorStats)) {
      failures.fail(`${label}_changed_during_read`);
    }
    const postPathStats = await fileSystem.lstat(path);
    assertOwnerOnlyRegular(
      postPathStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(postDescriptorStats, postPathStats)) {
      failures.fail(`${label}_changed_during_read`);
    }
    await revalidateParent(
      requestedParentPath,
      parent,
      failures,
      fileSystem,
    );
    return bytes;
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail(`${label}_read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createOwnerOnlyLocalMetadataBundlePairReader({
  fileSystem = DEFAULT_FILE_SYSTEM,
} = {}) {
  const files = validatedFileSystem(fileSystem);
  return async function readOwnerOnlyLocalMetadataBundlePair({
    bundleFile,
    receiptFile,
    maximumBundleBytes,
    maximumReceiptBytes,
    createError,
  } = {}) {
    const failures = failureContext(createError);
    assertPositiveSafeInteger(
      maximumBundleBytes,
      "maximum_bundle_bytes",
      failures,
    );
    assertPositiveSafeInteger(
      maximumReceiptBytes,
      "maximum_receipt_bytes",
      failures,
    );
    if (!bundleFile || !receiptFile) failures.fail("paths_required");
    const bundlePath = resolve(bundleFile);
    const receiptPath = resolve(receiptFile);
    if (bundlePath === receiptPath) failures.fail("paths_not_distinct");

    const bundleParentPath = dirname(bundlePath);
    const receiptParentPath = dirname(receiptPath);
    const bundleParent = await inspectParent(
      bundleParentPath,
      failures,
      files,
    );
    const receiptParent = await inspectParent(
      receiptParentPath,
      failures,
      files,
    );
    if (bundleParent.canonicalPath !== receiptParent.canonicalPath) {
      failures.fail("paths_not_adjacent");
    }
    if (
      bundleParent.dev !== receiptParent.dev
      || bundleParent.ino !== receiptParent.ino
    ) {
      failures.fail("parent_directory_changed");
    }
    await revalidateParent(
      bundleParentPath,
      bundleParent,
      failures,
      files,
    );
    const canonicalBundlePath = join(
      bundleParent.canonicalPath,
      basename(bundlePath),
    );
    const canonicalReceiptPath = join(
      receiptParent.canonicalPath,
      basename(receiptPath),
    );

    const receiptBytes = await readOwnerOnlyArtifact(
      canonicalReceiptPath,
      receiptParentPath,
      bundleParent,
      "receipt",
      maximumReceiptBytes,
      failures,
      files,
    );
    const bundleBytes = await readOwnerOnlyArtifact(
      canonicalBundlePath,
      bundleParentPath,
      bundleParent,
      "bundle",
      maximumBundleBytes,
      failures,
      files,
    );
    return Object.freeze({ bundleBytes, receiptBytes });
  };
}

export const readOwnerOnlyLocalMetadataBundlePair =
  createOwnerOnlyLocalMetadataBundlePairReader();
