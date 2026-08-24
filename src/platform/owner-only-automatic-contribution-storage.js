import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, win32 } from "node:path";

import { syncDirectory } from "./owner-only-filesystem.js";
import {
  isWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "./windows-protected-state-store.js";
import {
  isWindowsCompanionInstanceLeaseContext,
  isWindowsCompanionInstanceLeaseError,
} from "./windows-companion-instance-lease.js";

const INSTANCE_LOCK_SCHEMA_VERSION =
  "automatic-contribution-instance-lock-v0.1";
const INSTANCE_LOCK_KEYS = Object.freeze([
  "createdAt",
  "nonce",
  "pid",
  "schemaVersion",
]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function nullableTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function timestamp(value, failures) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) failures.fail("configuration_invalid");
  return date.toISOString();
}

function assertOwnerOnlyDirectory(stats, failures, code) {
  if (!stats.isDirectory()
      || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    failures.fail(code);
  }
}

function assertOwnerOnlyFile(stats, maximumBytes, failures, code) {
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || stats.size < 1
      || stats.size > maximumBytes
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    failures.fail(code);
  }
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validInstanceLockPayload(value) {
  return exactKeys(value, INSTANCE_LOCK_KEYS)
    && value.schemaVersion === INSTANCE_LOCK_SCHEMA_VERSION
    && Number.isSafeInteger(value.pid)
    && value.pid >= 1
    && value.pid <= 2_147_483_647
    && nullableTimestamp(value.createdAt) !== null
    && UUID_V4.test(value.nonce);
}

function normalizedPlatform(platform) {
  if (typeof platform !== "string" || platform.length < 1) {
    throw new TypeError("platform must be a non-empty string");
  }
  // A Windows process must not be able to opt into the ordinary Node
  // filesystem path by passing a different platform label.  The explicit
  // platform argument is retained for Mac/Linux contract tests that exercise
  // the Windows routing branch with a synthetic protected-store adapter.
  if (process.platform === "win32" && platform !== "win32") {
    throw new TypeError("platform downgrade is not permitted on Windows");
  }
  return platform;
}

function protectedStoreErrorCode(error) {
  try {
    return isWindowsProtectedStateStoreError(error) && typeof error.code === "string"
      ? error.code
      : "";
  } catch {
    return "";
  }
}

function isProtectedStoreMissing(error) {
  return protectedStoreErrorCode(error)
    === "windows_protected_state_store_missing";
}

function isProtectedStoreAlreadyExists(error) {
  return protectedStoreErrorCode(error)
    === "windows_protected_state_store_already_exists";
}

function windowsChildReference(settingsFile, store, failures) {
  let selected;
  let root;
  try {
    if (typeof settingsFile !== "string" || settingsFile.length < 1) {
      failures.fail("configuration_invalid");
    }
    if (!isWindowsProtectedStateStore(store)
        || store.contractVersion !== "windows-protected-state-store-v1"
        || typeof store.rootPath !== "string") {
      // A missing or unqualified Windows store is an operational boundary
      // failure, not permission to use the POSIX path implementation.
      failures.fail("settings_unavailable");
    }
    const raw = settingsFile.replaceAll("/", "\\");
    const rootRaw = store.rootPath.replaceAll("/", "\\");
    // Do not let win32.normalize turn a caller-supplied traversal into a
    // seemingly valid direct child. The protected store repeats this check,
    // but the storage port must bind the caller's state path before invoking
    // any operation on the store.
    if (raw.includes("\0") || rootRaw.includes("\0")
        || raw.split("\\").some((component) => component === "." || component === "..")) {
      failures.fail("configuration_invalid");
    }
    selected = win32.normalize(raw);
    root = win32.normalize(rootRaw);
    if (!win32.isAbsolute(selected)
        || !win32.isAbsolute(root)
        || win32.dirname(selected).toLowerCase() !== root.toLowerCase()) {
      failures.fail("configuration_invalid");
    }
    const child = win32.basename(selected);
    if (child.length < 1
        || child === "."
        || child === ".."
        || child.includes("\\")
        || child.includes("/")) {
      failures.fail("configuration_invalid");
    }
    return Object.freeze({
      child,
      path: win32.join(root, child),
      root,
      store,
    });
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("configuration_invalid");
  }
}

function assertProtectedRecord(record, expectedPath, maximumBytes, failures) {
  let data;
  let path;
  try {
    data = record?.data;
    path = record?.path;
  } catch {
    failures.fail("settings_unavailable");
  }
  if ((!Buffer.isBuffer(data) && !(data instanceof Uint8Array))
      || data.byteLength < 1
      || data.byteLength > maximumBytes
      || typeof path !== "string"
      || win32.normalize(path).toLowerCase()
        !== win32.normalize(expectedPath).toLowerCase()) {
    failures.fail("settings_unavailable");
  }
  return Buffer.from(data);
}

export function createOwnerOnlyAutomaticContributionStorageContext({
  createError,
  uuid = randomUUID,
  processId = process.pid,
  defaultProcessLiveness = defaultProcessIsAlive,
  platform = process.platform,
  windowsProtectedStateStore = null,
  windowsCompanionInstanceLease = null,
} = {}) {
  const failures = failureContext(createError);
  const createUuid = requireFunction(uuid, "uuid");
  const runtimePlatform = normalizedPlatform(platform);
  if (runtimePlatform === "win32"
      && windowsProtectedStateStore !== null
      && !isWindowsProtectedStateStore(windowsProtectedStateStore)) {
    throw new TypeError("windowsProtectedStateStore must be repository branded");
  }
  if (runtimePlatform === "win32"
      && windowsCompanionInstanceLease !== null
      && !isWindowsCompanionInstanceLeaseContext(windowsCompanionInstanceLease)) {
    throw new TypeError("windowsCompanionInstanceLease must be repository branded");
  }
  const processIsAliveByDefault = requireFunction(
    defaultProcessLiveness,
    "defaultProcessLiveness",
  );
  if (!Number.isSafeInteger(processId)
      || processId < 1
      || processId > 2_147_483_647) {
    throw new TypeError("processId must be a positive 32-bit integer");
  }

  function nextUuid(code) {
    let value;
    try {
      value = Reflect.apply(createUuid, undefined, []);
    } catch {
      failures.fail(code);
    }
    if (typeof value !== "string" || !UUID_V4.test(value)) failures.fail(code);
    return value;
  }

  function protectedStateTarget(settingsFile) {
    let target;
    try {
      target = windowsChildReference(
        settingsFile,
        windowsProtectedStateStore,
        failures,
      );
      target.store.ensureProtectedDirectory();
      return target;
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    }
  }

  function assertProtectedOperation(result, expectedPath) {
    let path;
    try {
      path = result?.path;
    } catch {
      failures.fail("settings_unavailable");
    }
    if (typeof path !== "string"
        || win32.normalize(path).toLowerCase()
          !== win32.normalize(expectedPath).toLowerCase()) {
      failures.fail("settings_unavailable");
    }
  }

  function readProtectedSettingsText({ settingsFile, maximumBytes }) {
    const target = protectedStateTarget(settingsFile);
    let bytes;
    try {
      const record = target.store.read(target.child);
      bytes = assertProtectedRecord(
        record,
        target.path,
        maximumBytes,
        failures,
      );
      return bytes.toString("utf8");
    } catch (error) {
      if (isProtectedStoreMissing(error)) return null;
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally {
      bytes?.fill(0);
    }
  }

  function writeProtectedSettingsText({ settingsFile, text, maximumBytes }) {
    const target = protectedStateTarget(settingsFile);
    let payload;
    try {
      payload = Buffer.from(text, "utf8");
      if (payload.length < 1 || payload.length > maximumBytes) {
        failures.fail("settings_unavailable");
      }
      try {
        const created = target.store.create(target.child, payload);
        assertProtectedOperation(created, target.path);
        return;
      } catch (error) {
        if (!isProtectedStoreAlreadyExists(error)) throw error;
      }

      // Replacement is identity-bound.  A caller cannot turn the create
      // race into an unqualified path overwrite by supplying a reader/writer
      // pair or by reusing an identity from another child.
      let current;
      let currentBytes;
      try {
        current = target.store.read(target.child);
        currentBytes = assertProtectedRecord(
          current,
          target.path,
          maximumBytes,
          failures,
        );
        const replaced = target.store.replace(
          target.child,
          current.identity,
          payload,
        );
        assertProtectedOperation(replaced, target.path);
      } finally {
        currentBytes?.fill(0);
      }
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally {
      payload?.fill(0);
    }
  }

  async function canonicalTarget(path, unavailableCode) {
    if (typeof path !== "string" || path.length < 1) {
      failures.fail("configuration_invalid");
    }
    const requested = resolve(path);
    const requestedParent = dirname(requested);
    try {
      await mkdir(requestedParent, { recursive: true, mode: 0o700 });
      const before = await lstat(requestedParent);
      assertOwnerOnlyDirectory(before, failures, unavailableCode);
      const canonicalParent = await realpath(requestedParent);
      const after = await lstat(canonicalParent);
      assertOwnerOnlyDirectory(after, failures, unavailableCode);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        failures.fail(unavailableCode);
      }
      return {
        parent: canonicalParent,
        file: join(canonicalParent, basename(requested)),
      };
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail(unavailableCode);
    }
  }

  async function readSettingsText({ settingsFile, maximumBytes } = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    if (runtimePlatform === "win32") {
      return readProtectedSettingsText({ settingsFile, maximumBytes });
    }
    const target = await canonicalTarget(settingsFile, "settings_unavailable");
    let handle;
    let bytes;
    try {
      handle = await open(
        target.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = await handle.stat();
      assertOwnerOnlyFile(
        before,
        maximumBytes,
        failures,
        "settings_unavailable",
      );
      bytes = await handle.readFile();
      const after = await handle.stat();
      assertOwnerOnlyFile(
        after,
        maximumBytes,
        failures,
        "settings_unavailable",
      );
      if (before.dev !== after.dev
          || before.ino !== after.ino
          || before.size !== after.size
          || bytes.length !== after.size) {
        failures.fail("settings_unavailable");
      }
      return bytes.toString("utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally {
      bytes?.fill(0);
      await handle?.close().catch(() => {});
    }
  }

  async function writeSettingsText({
    settingsFile,
    text,
    maximumBytes,
  } = {}) {
    if (typeof text !== "string"
        || !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    if (runtimePlatform === "win32") {
      return writeProtectedSettingsText({ settingsFile, text, maximumBytes });
    }
    const target = await canonicalTarget(settingsFile, "settings_unavailable");
    try {
      const existing = await lstat(target.file);
      assertOwnerOnlyFile(
        existing,
        maximumBytes,
        failures,
        "settings_unavailable",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (failures.issued(error)) throw error;
        failures.fail("settings_unavailable");
      }
    }
    const temporaryNonce = nextUuid("settings_unavailable");
    const temporary = join(
      target.parent,
      `.${basename(target.file)}.${processId}.${temporaryNonce}.tmp`,
    );
    let handle;
    let payload;
    try {
      payload = Buffer.from(text, "utf8");
      if (payload.length < 1 || payload.length > maximumBytes) {
        failures.fail("settings_unavailable");
      }
      handle = await open(
        temporary,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(payload);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target.file);
      await chmod(target.file, 0o600);
      const finalStats = await lstat(target.file);
      assertOwnerOnlyFile(
        finalStats,
        maximumBytes,
        failures,
        "settings_unavailable",
      );
      await syncDirectory(target.parent);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally {
      payload?.fill(0);
    }
  }

  async function canonicalInstanceLockTarget(lockFile) {
    return canonicalTarget(lockFile, "instance_lock_unavailable");
  }

  async function readInstanceLock(target, maximumBytes) {
    let handle;
    let bytes;
    try {
      handle = await open(
        target.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = await handle.stat();
      assertOwnerOnlyFile(
        before,
        maximumBytes,
        failures,
        "instance_lock_unavailable",
      );
      bytes = await handle.readFile();
      const after = await handle.stat();
      assertOwnerOnlyFile(
        after,
        maximumBytes,
        failures,
        "instance_lock_unavailable",
      );
      if (before.dev !== after.dev
          || before.ino !== after.ino
          || before.size !== after.size
          || bytes.length !== after.size) {
        failures.fail("instance_lock_unavailable");
      }
      let payload;
      try {
        payload = JSON.parse(bytes.toString("utf8"));
      } catch {
        failures.fail("instance_lock_unavailable");
      }
      if (!validInstanceLockPayload(payload)) {
        failures.fail("instance_lock_unavailable");
      }
      return {
        payload,
        identity: { dev: after.dev, ino: after.ino },
      };
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      if (failures.issued(error)) throw error;
      failures.fail("instance_lock_unavailable");
    } finally {
      bytes?.fill(0);
      await handle?.close().catch(() => {});
    }
  }

  async function acquireInstanceLock({
    lockFile,
    pid = processId,
    now = () => new Date(),
    processIsAlive = processIsAliveByDefault,
    maximumBytes,
    windowsCompanionInstanceLease: requestedWindowsCompanionInstanceLease =
      windowsCompanionInstanceLease,
  } = {}) {
    if (!Number.isSafeInteger(pid)
        || pid < 1
        || pid > 2_147_483_647
        || typeof now !== "function"
        || typeof processIsAlive !== "function"
        || !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    if (runtimePlatform === "win32") {
      if (!isWindowsCompanionInstanceLeaseContext(requestedWindowsCompanionInstanceLease)) {
        // The ordinary JSON lock is not a valid Windows process-wide mutex.
        // Never fall back to O_EXCL and an unlink race on this platform.
        failures.fail("instance_lock_unavailable");
      }
      const createdAt = timestamp(now(), failures);
      let lease;
      try {
        lease = requestedWindowsCompanionInstanceLease.acquire();
      } catch (error) {
        if (isWindowsCompanionInstanceLeaseError(error)) {
          if (error.code === "windows_companion_instance_lease_contended") {
            failures.fail("instance_active");
          }
          failures.fail("instance_lock_unavailable");
        }
        failures.fail("instance_lock_unavailable");
      }
      const recovered = requestedWindowsCompanionInstanceLease.wasAbandoned(lease);
      let releasePromise = null;
      return Object.freeze({
        schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
        pid,
        createdAt,
        recovered,
        release() {
          if (releasePromise === null) {
            releasePromise = Promise.resolve().then(() => {
              try {
                requestedWindowsCompanionInstanceLease.release(lease);
              } catch (error) {
                if (isWindowsCompanionInstanceLeaseError(error)) {
                  failures.fail("instance_lock_unavailable");
                }
                failures.fail("instance_lock_unavailable");
              }
            });
          }
          return releasePromise;
        },
      });
    }
    const target = await canonicalInstanceLockTarget(lockFile);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const payload = {
        schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
        pid,
        createdAt: timestamp(now(), failures),
        nonce: nextUuid("instance_lock_unavailable"),
      };
      let handle;
      let created = false;
      let bytes;
      try {
        handle = await open(
          target.file,
          constants.O_WRONLY
            | constants.O_CREAT
            | constants.O_EXCL
            | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        created = true;
        bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
        if (bytes.length > maximumBytes) {
          failures.fail("instance_lock_unavailable");
        }
        await handle.writeFile(bytes);
        await handle.chmod(0o600);
        await handle.sync();
        const stats = await handle.stat();
        assertOwnerOnlyFile(
          stats,
          maximumBytes,
          failures,
          "instance_lock_unavailable",
        );
        if (stats.size !== bytes.length) {
          failures.fail("instance_lock_unavailable");
        }
        const identity = { dev: stats.dev, ino: stats.ino };
        await handle.close();
        handle = null;
        bytes.fill(0);
        bytes = null;
        await syncDirectory(target.parent);
        let releasePromise = null;
        return Object.freeze({
          schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
          pid,
          createdAt: payload.createdAt,
          release() {
            if (releasePromise !== null) return releasePromise;
            releasePromise = (async () => {
              let current;
              try {
                current = await readInstanceLock(target, maximumBytes);
              } catch (error) {
                try {
                  await lstat(target.file);
                } catch (missing) {
                  if (missing?.code === "ENOENT") return;
                }
                throw error;
              }
              if (current.identity.dev !== identity.dev
                  || current.identity.ino !== identity.ino
                  || current.payload.pid !== pid
                  || current.payload.nonce !== payload.nonce) {
                failures.fail("instance_lock_unavailable");
              }
              const pathStats = await lstat(target.file);
              if (pathStats.dev !== identity.dev
                  || pathStats.ino !== identity.ino) {
                failures.fail("instance_lock_unavailable");
              }
              await unlink(target.file);
              await syncDirectory(target.parent);
            })();
            releasePromise.catch(() => {
              releasePromise = null;
            });
            return releasePromise;
          },
        });
      } catch (error) {
        bytes?.fill(0);
        await handle?.close().catch(() => {});
        if (created) {
          await unlink(target.file).catch(() => {});
          await syncDirectory(target.parent).catch(() => {});
        }
        if (error?.code !== "EEXIST") {
          if (failures.issued(error)) throw error;
          failures.fail("instance_lock_unavailable");
        }
        let existing;
        try {
          existing = await readInstanceLock(target, maximumBytes);
        } catch (readError) {
          if (readError?.code === "ENOENT") continue;
          throw readError;
        }
        let active;
        try {
          active = await processIsAlive(existing.payload.pid);
        } catch {
          failures.fail("instance_lock_unavailable");
        }
        if (active !== false) failures.fail("instance_active");
        const pathStats = await lstat(target.file);
        if (pathStats.dev !== existing.identity.dev
            || pathStats.ino !== existing.identity.ino) {
          continue;
        }
        try {
          await unlink(target.file);
          await syncDirectory(target.parent);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") {
            failures.fail("instance_lock_unavailable");
          }
        }
      }
    }
    failures.fail("instance_lock_unavailable");
  }

  return Object.freeze({
    acquireInstanceLock,
    readSettingsText,
    writeSettingsText,
  });
}
