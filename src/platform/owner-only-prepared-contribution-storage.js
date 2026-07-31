import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { syncDirectory } from "./owner-only-filesystem.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function failureContext(createError) {
  const factory = requireFunction(createError, "createError");
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      let error;
      try {
        error = Reflect.apply(factory, undefined, [code]);
      } catch {
        throw new TypeError("createError must return an Error");
      }
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      try {
        return error instanceof Error && issued.has(error);
      } catch {
        return false;
      }
    },
  });
}

function safeStatsSize(stats) {
  if (typeof stats.size !== "bigint"
      || stats.size < 0n
      || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(stats.size);
}

function currentUid() {
  return typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : null;
}

function ownerMode(stats) {
  return Number(stats.mode & 0o777n);
}

function assertDirectory(stats, failures, code) {
  const uid = currentUid();
  if (!stats.isDirectory()
      || stats.isSymbolicLink()
      || (uid !== null && stats.uid !== uid)
      || (process.platform !== "win32"
        && ownerMode(stats) !== DIRECTORY_MODE)) {
    failures.fail(code);
  }
}

function assertFile(stats, maximumBytes, failures, code) {
  const size = safeStatsSize(stats);
  const uid = currentUid();
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1n
      || size === null
      || size < 1
      || size > maximumBytes
      || (uid !== null && stats.uid !== uid)
      || (process.platform !== "win32" && ownerMode(stats) !== FILE_MODE)) {
    failures.fail(code);
  }
  return size;
}

function sameSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function statPath(path) {
  return lstat(path, { bigint: true });
}

async function statHandle(handle) {
  return handle.stat({ bigint: true });
}

async function readExact(handle, size, failures, changedCode) {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    let result;
    try {
      result = await handle.read(bytes, offset, size - offset, offset);
    } catch {
      bytes.fill(0);
      failures.fail(changedCode);
    }
    if (result.bytesRead < 1) {
      bytes.fill(0);
      failures.fail(changedCode);
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  try {
    const result = await handle.read(probe, 0, 1, size);
    if (result.bytesRead !== 0) {
      bytes.fill(0);
      failures.fail(changedCode);
    }
  } catch {
    bytes.fill(0);
    failures.fail(changedCode);
  } finally {
    probe.fill(0);
  }
  return bytes;
}

function contentBytes(content, failures) {
  try {
    if (typeof content === "string") return Buffer.from(content, "utf8");
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      return Buffer.from(content);
    }
  } catch {
    // Collapse hostile typed-array and coercion failures below.
  }
  failures.fail("publication_invalid");
}

export function createOwnerOnlyPreparedContributionStorageContext({
  uuid = randomUUID,
  processId = process.pid,
} = {}) {
  requireFunction(uuid, "uuid");
  if (!Number.isSafeInteger(processId) || processId < 0) {
    throw new TypeError("processId must be a non-negative safe integer");
  }

  async function canonicalDirectory(directory, {
    createError,
    code = "directory_invalid",
  } = {}) {
    const failures = failureContext(createError);
    let requested;
    try {
      requested = resolve(directory);
    } catch {
      failures.fail(code);
    }
    try {
      const before = await statPath(requested);
      assertDirectory(before, failures, code);
      const canonical = await realpath(requested);
      const canonicalStats = await statPath(canonical);
      const after = await statPath(requested);
      assertDirectory(canonicalStats, failures, code);
      assertDirectory(after, failures, code);
      if (!sameSnapshot(before, after)
          || before.dev !== canonicalStats.dev
          || before.ino !== canonicalStats.ino) {
        failures.fail(code);
      }
      return canonical;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(code);
    }
  }

  async function readOwnerOnlyFile({
    directory,
    name,
    maximumBytes,
    createError,
    missingCode = "file_missing",
    changedCode = "file_changed",
  } = {}) {
    const failures = failureContext(createError);
    if (typeof directory !== "string"
        || basename(name) !== name
        || !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 1) {
      failures.fail(changedCode);
    }
    const path = join(directory, name);
    let handle;
    let bytes;
    let primary;
    try {
      let pathBefore;
      try {
        pathBefore = await statPath(path);
      } catch (error) {
        if (error?.code === "ENOENT") failures.fail(missingCode);
        failures.fail(changedCode);
      }
      const size = assertFile(
        pathBefore,
        maximumBytes,
        failures,
        "file_invalid",
      );
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const opened = await statHandle(handle);
      assertFile(opened, maximumBytes, failures, "file_invalid");
      if (!sameSnapshot(pathBefore, opened)) failures.fail(changedCode);
      bytes = await readExact(handle, size, failures, changedCode);
      const openedAfter = await statHandle(handle);
      const pathAfter = await statPath(path);
      assertFile(openedAfter, maximumBytes, failures, "file_invalid");
      assertFile(pathAfter, maximumBytes, failures, "file_invalid");
      if (!sameSnapshot(opened, openedAfter)
          || !sameSnapshot(openedAfter, pathAfter)) {
        failures.fail(changedCode);
      }
    } catch (error) {
      primary = error;
    }
    try {
      await handle?.close();
    } catch {
      if (primary === undefined) failures.fail(changedCode);
    }
    if (primary !== undefined) {
      bytes?.fill(0);
      if (failures.issued(primary)) throw primary;
      failures.fail(changedCode);
    }
    return bytes;
  }

  async function readDirectoryEntries({
    directory,
    maximumEntries,
    createError,
    code = "directory_invalid",
  } = {}) {
    const failures = failureContext(createError);
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      failures.fail(code);
    }
    let handle;
    const entries = [];
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        if (entries.length >= maximumEntries) failures.fail(code);
        entries.push(entry.name);
      }
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(code);
    } finally {
      await handle?.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") failures.fail(code);
      });
    }
    return entries;
  }

  async function publishOwnerOnlyFile({
    directory,
    name,
    content,
    maximumBytes,
    createError,
    failpoint = async () => {},
  } = {}) {
    const failures = failureContext(createError);
    requireFunction(failpoint, "failpoint");
    const root = await canonicalDirectory(directory, { createError });
    if (basename(name) !== name
        || !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 1) {
      failures.fail("publication_invalid");
    }
    const bytes = contentBytes(content, failures);
    if (bytes.length < 1 || bytes.length > maximumBytes) {
      bytes.fill(0);
      failures.fail("publication_invalid");
    }
    const path = join(root, name);
    let handle;
    let writtenSnapshot = null;
    let durable = false;
    let primary;
    let failpointFailure;
    try {
      handle = await open(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | NOFOLLOW,
        FILE_MODE,
      );
      await handle.chmod(FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      writtenSnapshot = await statHandle(handle);
      const writtenSize = assertFile(
        writtenSnapshot,
        maximumBytes,
        failures,
        "publication_invalid",
      );
      if (writtenSize !== bytes.length) failures.fail("publication_invalid");
      try {
        await failpoint("after_file_sync");
      } catch (error) {
        failpointFailure = error;
        throw error;
      }
      await handle.close();
      handle = null;
      const pathStats = await statPath(path);
      assertFile(pathStats, maximumBytes, failures, "publication_invalid");
      if (!sameSnapshot(pathStats, writtenSnapshot)) {
        failures.fail("publication_invalid");
      }
      await syncDirectory(root);
      durable = true;
    } catch (error) {
      primary = error;
    }
    try {
      await handle?.close();
    } catch {
      if (primary === undefined) primary = new Error("close_failed");
    }
    if (!durable && writtenSnapshot !== null) {
      try {
        const current = await statPath(path);
        if (current.isFile()
            && !current.isSymbolicLink()
            && current.dev === writtenSnapshot.dev
            && current.ino === writtenSnapshot.ino) {
          await unlink(path);
          await syncDirectory(root);
        }
      } catch {
        // Preserve the primary failure and leave crash evidence in place.
      }
    }
    const result = Object.freeze({
      basename: name,
      bytes: bytes.length,
    });
    bytes.fill(0);
    if (primary !== undefined) {
      if (primary === failpointFailure || failures.issued(primary)) {
        throw primary;
      }
      failures.fail("publication_invalid");
    }
    return result;
  }

  async function publishManifest({
    directory,
    manifestBasename,
    content,
    maximumBytes,
    createError,
    failpoint = async () => {},
  } = {}) {
    const failures = failureContext(createError);
    requireFunction(failpoint, "failpoint");
    const root = await canonicalDirectory(directory, { createError });
    const selectedUuid = uuid();
    if (typeof selectedUuid !== "string" || selectedUuid.length < 1) {
      failures.fail("publication_invalid");
    }
    const stageName =
      `.prepared-contribution-set.${processId}.${selectedUuid}.stage`;
    const stage = await publishOwnerOnlyFile({
      directory: root,
      name: stageName,
      content,
      maximumBytes,
      createError,
      failpoint: async () => {},
    });
    const stagePath = join(root, stageName);
    const manifestPath = join(root, manifestBasename);
    let committed = false;
    let primary;
    let failpointFailure;
    try {
      try {
        await failpoint("after_manifest_stage");
      } catch (error) {
        failpointFailure = error;
        throw error;
      }
      await link(stagePath, manifestPath);
      committed = true;
      await syncDirectory(root);
      try {
        await failpoint("after_manifest_commit");
      } catch (error) {
        failpointFailure = error;
        throw error;
      }
      await unlink(stagePath);
      await syncDirectory(root);
    } catch (error) {
      primary = error;
    }
    try {
      await unlink(stagePath);
      await syncDirectory(root);
    } catch (error) {
      if (error?.code !== "ENOENT" && primary === undefined) primary = error;
    }
    if (primary !== undefined) {
      if (primary === failpointFailure || failures.issued(primary)) {
        throw primary;
      }
      failures.fail("publication_invalid");
    }
    if (!committed) failures.fail("publication_invalid");
    return Object.freeze({
      basename: manifestBasename,
      bytes: stage.bytes,
    });
  }

  async function prepareOwnerOnlyDirectory(path, code, createError) {
    const failures = failureContext(createError);
    let requested;
    try {
      requested = resolve(path);
      await mkdir(requested, { recursive: true, mode: DIRECTORY_MODE });
      const before = await statPath(requested);
      assertDirectory(before, failures, code);
      const canonical = await realpath(requested);
      const canonicalStats = await statPath(canonical);
      const after = await statPath(requested);
      assertDirectory(canonicalStats, failures, code);
      assertDirectory(after, failures, code);
      if (!sameSnapshot(before, after)
          || before.dev !== canonicalStats.dev
          || before.ino !== canonicalStats.ino) {
        failures.fail(code);
      }
      return canonical;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(code);
    }
  }

  async function createOwnerOnlyDirectory(path, code, createError) {
    const failures = failureContext(createError);
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      const stats = await statPath(path);
      assertDirectory(stats, failures, code);
      return path;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(code);
    }
  }

  async function ownerOnlyDirectoryExists(path, code, createError) {
    const failures = failureContext(createError);
    try {
      const before = await statPath(path);
      assertDirectory(before, failures, code);
      const canonical = await realpath(path);
      const after = await statPath(canonical);
      assertDirectory(after, failures, code);
      if (before.dev !== after.dev
          || before.ino !== after.ino
          || canonical !== resolve(path)) {
        failures.fail(code);
      }
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (failures.issued(error)) throw error;
      failures.fail(code);
    }
  }

  async function assertPathAbsent(path, code, createError) {
    const failures = failureContext(createError);
    try {
      await statPath(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      failures.fail(code);
    }
    failures.fail(code);
  }

  async function removeEmptyOwnerOnlyDirectory(
    path,
    parentDirectory,
    createError,
  ) {
    if (typeof path !== "string" || path.length === 0) return;
    const failures = failureContext(createError);
    try {
      const stats = await statPath(path);
      assertDirectory(stats, failures, "preparation_failed");
      await rmdir(path);
      await syncDirectory(parentDirectory).catch(() => {});
    } catch (error) {
      if (error?.code === "ENOENT"
          || error?.code === "ENOTEMPTY"
          || error?.code === "EEXIST"
          || failures.issued(error)) {
        return;
      }
      // Best effort: never replace the fixed preparation failure.
    }
  }

  return Object.freeze({
    assertPathAbsent,
    canonicalDirectory,
    createOwnerOnlyDirectory,
    ownerOnlyDirectoryExists,
    prepareOwnerOnlyDirectory,
    publishManifest,
    publishOwnerOnlyFile,
    readDirectoryEntries,
    readOwnerOnlyFile,
    removeEmptyOwnerOnlyDirectory,
    renameDirectory: rename,
    sha256Hex(value) {
      return createHash("sha256").update(value).digest("hex");
    },
    syncDirectory,
  });
}
