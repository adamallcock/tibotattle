import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function snapshotOptions(value, label) {
  const options = value === undefined ? {} : value;
  try {
    if (
      options === null
      || typeof options !== "object"
      || Array.isArray(options)
    ) {
      throw new TypeError(`${label} must be an object`);
    }
  } catch {
    throw new TypeError(`${label} must be an object`);
  }
  return options;
}

function readOption(options, property, fallback, message) {
  let value;
  try {
    value = options[property];
  } catch {
    throw new TypeError(message);
  }
  return value === undefined ? fallback : value;
}

function failureContext(createError) {
  const factory = requireFunction(createError, "createError");
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      let error;
      try {
        error = Reflect.apply(factory, undefined, [code]);
        if (!(error instanceof Error)) {
          throw new TypeError("createError must return an Error");
        }
      } catch {
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

function assertArtifactStats(stats, label, maximumBytes, failures) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    failures.fail(`${label}_type`);
  }
  if (stats.nlink !== 1) failures.fail(`${label}_links`);
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

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size;
}

export function createExportSetVerificationStorageContext(contextOptions = {}) {
  const options = snapshotOptions(
    contextOptions,
    "verification storage options",
  );
  const temporaryRoot = readOption(
    options,
    "temporaryRoot",
    tmpdir(),
    "verification storage temporaryRoot could not be read",
  );
  if (typeof temporaryRoot !== "string" || temporaryRoot.length < 1) {
    throw new TypeError("temporaryRoot must be a non-empty path");
  }

  async function inspectOwnerDirectory(operationOptions = {}) {
    const selected = snapshotOptions(
      operationOptions,
      "directory inspection options",
    );
    const directory = readOption(
      selected,
      "directory",
      undefined,
      "directory inspection directory could not be read",
    );
    const createError = readOption(
      selected,
      "createError",
      undefined,
      "directory inspection createError could not be read",
    );
    const failures = failureContext(createError);
    let root;
    try {
      root = resolve(directory);
    } catch {
      failures.fail("directory");
    }
    let stats;
    try {
      stats = await lstat(root);
    } catch {
      failures.fail("directory");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      failures.fail("directory");
    }
    if (
      typeof process.getuid === "function"
      && stats.uid !== process.getuid()
    ) {
      failures.fail("directory");
    }
    if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
      failures.fail("directory");
    }
    return root;
  }

  function artifactPath(root, basename) {
    return join(root, basename);
  }

  async function readCanonicalArtifact(operationOptions = {}) {
    const selected = snapshotOptions(
      operationOptions,
      "canonical artifact read options",
    );
    const root = readOption(selected, "root", undefined,
      "canonical artifact root could not be read");
    const basename = readOption(selected, "basename", undefined,
      "canonical artifact basename could not be read");
    const label = readOption(selected, "label", undefined,
      "canonical artifact label could not be read");
    const maximumBytes = readOption(selected, "maximumBytes", undefined,
      "canonical artifact maximumBytes could not be read");
    const canonicalJson = readOption(selected, "canonicalJson", undefined,
      "canonical artifact canonicalJson could not be read");
    const createError = readOption(selected, "createError", undefined,
      "canonical artifact createError could not be read");
    const failures = failureContext(createError);
    const canonicalize = requireFunction(canonicalJson, "canonicalJson");
    const path = artifactPath(root, basename);
    let pathStats;
    try {
      pathStats = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") failures.fail(`${label}_missing`);
      failures.fail(`${label}_changed`);
    }
    assertArtifactStats(pathStats, label, maximumBytes, failures);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const stats = await handle.stat();
      assertArtifactStats(stats, label, maximumBytes, failures);
      if (!sameIdentity(stats, pathStats)) failures.fail(`${label}_changed`);
      const bytes = await handle.readFile();
      if (bytes.length !== stats.size) failures.fail(`${label}_changed`);
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        failures.fail(`${label}_json`);
      }
      if (canonicalize(value) !== bytes.toString("utf8")) {
        failures.fail(`${label}_canonical`);
      }
      return { value, bytes };
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(`${label}_changed`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function readOwnerOnlyBytes(operationOptions = {}) {
    const selected = snapshotOptions(
      operationOptions,
      "owner-only byte read options",
    );
    const root = readOption(selected, "root", undefined,
      "owner-only byte root could not be read");
    const basename = readOption(selected, "basename", undefined,
      "owner-only byte basename could not be read");
    const label = readOption(selected, "label", undefined,
      "owner-only byte label could not be read");
    const maximumBytes = readOption(selected, "maximumBytes", undefined,
      "owner-only byte maximumBytes could not be read");
    const expectedBytes = readOption(selected, "expectedBytes", undefined,
      "owner-only byte expectedBytes could not be read");
    const createError = readOption(selected, "createError", undefined,
      "owner-only byte createError could not be read");
    const failures = failureContext(createError);
    const path = artifactPath(root, basename);
    let pathStats;
    try {
      pathStats = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") failures.fail(`${label}_missing`);
      failures.fail(`${label}_changed`);
    }
    assertArtifactStats(pathStats, label, maximumBytes, failures);
    if (pathStats.size !== expectedBytes) failures.fail(`${label}_size`);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const stats = await handle.stat();
      assertArtifactStats(stats, label, maximumBytes, failures);
      if (!sameIdentity(stats, pathStats)) failures.fail(`${label}_changed`);
      const bytes = await handle.readFile();
      if (bytes.length !== stats.size) failures.fail(`${label}_changed`);
      return bytes;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(`${label}_read`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function enumerateDirectory(operationOptions = {}) {
    const selected = snapshotOptions(
      operationOptions,
      "directory enumeration options",
    );
    const root = readOption(selected, "root", undefined,
      "directory enumeration root could not be read");
    const maximumEntries = readOption(selected, "maximumEntries", undefined,
      "directory enumeration maximumEntries could not be read");
    const createLimitError = readOption(selected, "createLimitError", undefined,
      "directory enumeration createLimitError could not be read");
    return readBoundedDirectoryEntries(root, {
      maximumEntries,
      createLimitError,
    });
  }

  async function createUniquenessIndex(operationOptions = {}) {
    const selected = snapshotOptions(
      operationOptions,
      "verification-index options",
    );
    const maximumBytes = readOption(selected, "maximumBytes", undefined,
      "verification-index maximumBytes could not be read");
    const batchLimitRecords = readOption(selected, "batchLimitRecords", undefined,
      "verification-index batchLimitRecords could not be read");
    const selectedTemporaryRoot = readOption(
      selected,
      "temporaryRoot",
      temporaryRoot,
      "verification-index temporaryRoot could not be read",
    );
    const observeWorkspace = readOption(selected, "observeWorkspace", undefined,
      "verification-index observeWorkspace could not be read");
    const createError = readOption(selected, "createError", undefined,
      "verification-index createError could not be read");
    const createLimitError = readOption(selected, "createLimitError", undefined,
      "verification-index createLimitError could not be read");
    const isResourceLimitError = readOption(
      selected,
      "isResourceLimitError",
      undefined,
      "verification-index isResourceLimitError could not be read",
    );
    const failures = failureContext(createError);
    const observe = requireFunction(observeWorkspace, "observeWorkspace");
    const limitError = requireFunction(createLimitError, "createLimitError");
    const reviewedResourceFailure = requireFunction(
      isResourceLimitError,
      "isResourceLimitError",
    );
    function isReviewedResourceFailure(error) {
      try {
        return reviewedResourceFailure(error) === true;
      } catch {
        return false;
      }
    }
    if (
      typeof selectedTemporaryRoot !== "string"
      || selectedTemporaryRoot.length < 1
    ) {
      throw new TypeError("temporaryRoot must be a non-empty path");
    }
    let directory = null;
    let setupHandle = null;
    let database = null;
    try {
      directory = await mkdtemp(
        join(selectedTemporaryRoot, "app-usagemonitor-set-verify-"),
      );
      await chmod(directory, 0o700);
      const databaseFile = join(directory, "ids.sqlite3");
      setupHandle = await open(
        databaseFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await setupHandle.chmod(0o600);
      await setupHandle.close();
      setupHandle = null;
      const { DatabaseSync } = await import("node:sqlite");
      database = new DatabaseSync(databaseFile);
      database.exec("PRAGMA journal_mode=DELETE");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA trusted_schema=OFF");
      database.enableDefensive?.(true);
      database.exec(
        "CREATE TABLE ids(family TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(family, record_id)) STRICT",
      );
      const insert = database.prepare(
        "INSERT INTO ids(family, record_id) VALUES (?, ?)",
      );
      let batchRecords = 0;
      let recordsIndexed = 0;
      let nonEmptyBatchCount = 0;
      let fullBatchCount = 0;
      let maximumBatchRecords = 0;
      let finalBatchRecords = 0;
      let transactionOpen = false;

      function observeDatabaseBytes() {
        const pageCount = Number(
          database.prepare("PRAGMA page_count").get().page_count,
        );
        const pageSize = Number(
          database.prepare("PRAGMA page_size").get().page_size,
        );
        const bytes = pageCount * pageSize;
        if (bytes > maximumBytes) {
          const error = limitError("workspace_bytes");
          if (!(error instanceof Error)) {
            throw new TypeError("createLimitError must return an Error");
          }
          throw error;
        }
        observe(bytes);
      }

      function beginTransaction() {
        if (transactionOpen) return;
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        batchRecords = 0;
      }

      function commitTransaction() {
        if (!transactionOpen) return;
        database.exec("COMMIT");
        transactionOpen = false;
        if (batchRecords > 0) {
          nonEmptyBatchCount += 1;
          if (batchRecords === batchLimitRecords) fullBatchCount += 1;
          maximumBatchRecords = Math.max(maximumBatchRecords, batchRecords);
          finalBatchRecords = batchRecords;
        }
        batchRecords = 0;
        observeDatabaseBytes();
      }

      return Object.freeze({
        add(family, id) {
          try {
            beginTransaction();
            insert.run(family, id);
            batchRecords += 1;
            recordsIndexed += 1;
            if (batchRecords >= batchLimitRecords) commitTransaction();
          } catch (error) {
            if (isReviewedResourceFailure(error)) throw error;
            if (
              String(error?.code).includes("CONSTRAINT")
              || /UNIQUE constraint/i.test(error?.message)
            ) {
              failures.fail("chunk_duplicate");
            }
            failures.fail("verification_index");
          }
        },
        async close() {
          let failure = null;
          try {
            commitTransaction();
            if (recordsIndexed === 0) observeDatabaseBytes();
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
          if (failure) {
            if (
              failures.issued(failure)
              || isReviewedResourceFailure(failure)
            ) {
              throw failure;
            }
            failures.fail("verification_index");
          }
          return {
            batchLimitRecords,
            recordsIndexed,
            nonEmptyBatchCount,
            fullBatchCount,
            maximumBatchRecords,
            finalBatchRecords,
          };
        },
      });
    } catch (error) {
      await setupHandle?.close().catch(() => {});
      try {
        database?.close();
      } catch {
        // The safe verification-index failure below owns this boundary.
      }
      if (directory !== null) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (failures.issued(error) || isReviewedResourceFailure(error)) {
        throw error;
      }
      failures.fail("verification_index");
    }
  }

  return Object.freeze({
    artifactPath,
    createSha256Digest() {
      return createHash("sha256");
    },
    createUniquenessIndex,
    enumerateDirectory,
    inspectOwnerDirectory,
    readCanonicalArtifact,
    readOwnerOnlyBytes,
    sha256Hex(value) {
      return createHash("sha256").update(value).digest("hex");
    },
    clock: () => Date.now(),
    rss: () => process.memoryUsage().rss,
    defaultTemporaryRoot: temporaryRoot,
  });
}
