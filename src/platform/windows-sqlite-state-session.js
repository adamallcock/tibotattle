import { constants as SQLITE_CONSTANTS, DatabaseSync } from "node:sqlite";
import { win32 } from "node:path";

import {
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";

/**
 * A single protected SQLite connection for Windows-owned application state.
 *
 * The native adapter owns the root-relative lease and the filesystem
 * identity.  This module owns only the lifetime of that lease and the
 * DatabaseSync connection. Keeping those lifetimes together is important:
 * callers receive only a narrow database facade and cannot release the native
 * protection, close the raw connection, or replace its security configuration
 * while the session is open.
 */
export const WINDOWS_SQLITE_STATE_SESSION_CONTRACT_VERSION =
  "windows-sqlite-state-session-v1";

// This is deliberately a qualification-only result until the native adapter
// has a Windows x64 proof for the lease implementation.  A simulated win32
// session on macOS can exercise composition without becoming authorization.
export const WINDOWS_SQLITE_STATE_SESSION_PRODUCTION_SAFE = false;

const MAX_PATH_LENGTH = 32_767;
const ROOT_NAME_ERROR = "invalid_root";
const DATABASE_NAME_ERROR = "invalid_database_name";
const SQLITE_DENY = SQLITE_CONSTANTS?.SQLITE_DENY ?? 1;
const SQLITE_OK = SQLITE_CONSTANTS?.SQLITE_OK ?? 0;
const SQLITE_ATTACH = SQLITE_CONSTANTS?.SQLITE_ATTACH ?? 24;
const SQLITE_DETACH = SQLITE_CONSTANTS?.SQLITE_DETACH ?? 25;
const SQLITE_PRAGMA = SQLITE_CONSTANTS?.SQLITE_PRAGMA ?? 19;
const PROTECTED_PRAGMAS = new Set([
  "journal_mode",
  "synchronous",
  "foreign_keys",
  "trusted_schema",
  "temp_store",
  "mmap_size",
]);

const SESSIONS = new WeakSet();
const DATABASE_FACADES = new WeakSet();
const SESSION_ERRORS = new WeakSet();

const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_adapter",
  "invalid_platform",
  "unsupported_architecture",
  "invalid_root",
  "invalid_database_name",
  "root_unavailable",
  "identity_mismatch",
  "lease_unavailable",
  "database_unavailable",
  "policy_unavailable",
  "policy_refused",
  "rollback_failed",
  "close_failed",
  "lease_release_failed",
]);

export class WindowsSqliteStateSessionError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows SQLite state session error code");
    }
    // Do not include a path, database name, native error text, or SQL in the
    // public error.  The code is stable and content-free for callers/tests.
    super("Windows SQLite state session operation failed");
    this.name = "WindowsSqliteStateSessionError";
    this.code = `windows_sqlite_state_session_${code}`;
    SESSION_ERRORS.add(this);
  }
}

export function isWindowsSqliteStateSessionError(error) {
  return Boolean(error
    && SESSION_ERRORS.has(error)
    && Object.getPrototypeOf(error) === WindowsSqliteStateSessionError.prototype);
}

export function isWindowsSqliteStateSession(session) {
  try {
    return session !== null
      && (typeof session === "object" || typeof session === "function")
      && SESSIONS.has(session);
  } catch {
    return false;
  }
}

export function isWindowsSqliteStateDatabase(database) {
  try {
    return database !== null
      && typeof database === "object"
      && DATABASE_FACADES.has(database);
  } catch {
    return false;
  }
}

function fail(code) {
  throw new WindowsSqliteStateSessionError(code);
}

function normalizedPlatform(platform) {
  if (platform !== "win32") fail("invalid_platform");
  // A real Windows process may not downgrade itself into the portable path.
  // This prevents a caller from bypassing the protected lease merely by
  // passing a friendlier platform label.
  if (process.platform === "win32" && platform !== process.platform) {
    fail("invalid_platform");
  }
  return platform;
}

function normalizedArchitecture(architecture) {
  if (architecture !== "x64") fail("unsupported_architecture");
  if (process.platform === "win32" && process.arch !== architecture) {
    fail("unsupported_architecture");
  }
  return architecture;
}

function invalidWindowsComponent(component) {
  if (component.length === 0
      || component === "."
      || component === ".."
      || component.endsWith(".")
      || component.endsWith(" ")
      || /[<>:"|?*]/u.test(component)) {
    return true;
  }
  const base = component.split(".", 1)[0].toUpperCase();
  return new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ]).has(base);
}

function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.length < 4
      || rootPath.length > MAX_PATH_LENGTH
      || rootPath.includes("\0")) {
    fail(ROOT_NAME_ERROR);
  }
  const raw = rootPath.replaceAll("/", "\\");
  const rawComponents = raw.split("\\");
  if (rawComponents.some((component) => component === "." || component === "..")) {
    fail(ROOT_NAME_ERROR);
  }
  let normalized;
  try {
    normalized = win32.normalize(raw);
  } catch {
    fail(ROOT_NAME_ERROR);
  }
  if (!win32.isAbsolute(normalized)
      || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    fail(ROOT_NAME_ERROR);
  }
  const parsed = win32.parse(normalized);
  if (parsed.root.length >= normalized.length) fail(ROOT_NAME_ERROR);
  const canonical = normalized.endsWith("\\")
    ? normalized.slice(0, -1)
    : normalized;
  const components = canonical.slice(parsed.root.length).split("\\");
  if (components.some((component) => invalidWindowsComponent(component))) {
    fail(ROOT_NAME_ERROR);
  }
  return canonical;
}

function canonicalDatabaseName(databaseName) {
  if (typeof databaseName !== "string"
      || databaseName.length < 1
      || databaseName.length > 255
      || databaseName.includes("\0")
      || databaseName.includes("/")
      || databaseName.includes("\\")
      || win32.isAbsolute(databaseName)
      || /^[A-Za-z]:/u.test(databaseName)
      || invalidWindowsComponent(databaseName)) {
    fail(DATABASE_NAME_ERROR);
  }
  const lowerName = databaseName.toLowerCase();
  if (lowerName.endsWith("-journal")
      || lowerName.endsWith("-wal")
      || lowerName.endsWith("-shm")) {
    fail(DATABASE_NAME_ERROR);
  }
  return databaseName;
}

function databasePath(rootPath, databaseName) {
  const candidate = win32.join(rootPath, databaseName);
  const prefix = `${rootPath}\\`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)
      || candidate.length <= prefix.length
      || candidate.length > MAX_PATH_LENGTH) {
    fail(DATABASE_NAME_ERROR);
  }
  return candidate;
}

function exactIdentity(value) {
  return exactIdentityWithError(value, "root_unavailable");
}

function exactIdentityWithError(value, errorCode) {
  let valid = false;
  try {
    valid = isWindowsFilesystemIdentity(value)
      && value.linkCount === 1
      && Object.keys(value).sort().join("\0")
        === "fileId\0linkCount\0volumeSerialNumber";
  } catch {
    valid = false;
  }
  if (!valid) fail(errorCode);
  return Object.freeze({
    volumeSerialNumber: value.volumeSerialNumber,
    fileId: value.fileId,
    linkCount: 1,
  });
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function validateRootMetadata(metadata) {
  let valid = false;
  try {
    valid = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.isDirectory === true
      && metadata.isRegularFile === false
      && metadata.isReparsePoint === false
      && metadata.ownerMatches === true
      && metadata.nullDacl === false
      && metadata.daclProtected === true
      && metadata.broadAccess === false
      && metadata.nonOwnerAllow === false
      && metadata.unrecognizedAce === false
      && metadata.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("root_unavailable");
  return exactIdentity(metadata.identity);
}

function inspectRoot(adapter, rootPath) {
  let metadata;
  try {
    metadata = adapter.inspectPath(rootPath);
  } catch {
    fail("root_unavailable");
  }
  return validateRootMetadata(metadata);
}

function assertAdapter(adapter, { requireSqliteLeaseSafe }) {
  if (!isWindowsFilesystemAdapter(adapter)) fail("invalid_adapter");
  let valid = false;
  try {
    valid = typeof adapter.inspectPath === "function"
      && typeof adapter.inspectProtectedChild === "function"
      && typeof adapter.acquireSqliteStateLease === "function"
      && typeof adapter.releaseSqliteStateLease === "function"
      && (!requireSqliteLeaseSafe || adapter.sqliteStateLeaseSafe === true);
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_adapter");
  return adapter;
}

function validateDatabaseMetadata(metadata) {
  let valid = false;
  try {
    valid = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.isDirectory === false
      && metadata.isRegularFile === true
      && metadata.isReparsePoint === false
      && metadata.ownerMatches === true
      && metadata.nullDacl === false
      && metadata.daclProtected === true
      && metadata.broadAccess === false
      && metadata.nonOwnerAllow === false
      && metadata.unrecognizedAce === false
      && metadata.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("identity_mismatch");
  return exactIdentityWithError(metadata.identity, "identity_mismatch");
}

function revalidateLeaseIdentities(
    adapter,
    root,
    rootIdentity,
    databaseName,
    lease) {
  const databaseIdentity = exactIdentityWithError(
    lease?.databaseIdentity,
    "identity_mismatch",
  );
  const journalIdentity = exactIdentityWithError(
    lease?.journalIdentity,
    "identity_mismatch",
  );
  const journalName = `${databaseName}-journal`;
  let databaseMetadata;
  let journalMetadata;
  try {
    databaseMetadata = adapter.inspectProtectedChild(root, rootIdentity, databaseName);
    journalMetadata = adapter.inspectProtectedChild(root, rootIdentity, journalName);
  } catch {
    fail("identity_mismatch");
  }
  const observedDatabaseIdentity = validateDatabaseMetadata(databaseMetadata);
  const observedJournalIdentity = validateDatabaseMetadata(journalMetadata);
  if (!sameIdentity(observedDatabaseIdentity, databaseIdentity)
      || !sameIdentity(observedJournalIdentity, journalIdentity)) {
    fail("identity_mismatch");
  }
  return Object.freeze({ databaseIdentity, journalIdentity });
}

function assertDatabase(database) {
  let valid = false;
  try {
    valid = database !== null
      && typeof database === "object"
      && typeof database.exec === "function"
      && typeof database.prepare === "function"
      && typeof database.close === "function"
      && typeof database.enableDefensive === "function";
  } catch {
    valid = false;
  }
  if (!valid) fail("database_unavailable");
  return database;
}

function pragmaValue(row, name) {
  let value;
  try {
    if (row !== null && typeof row === "object" && Object.hasOwn(row, name)) {
      value = row[name];
    } else if (row !== null && typeof row === "object") {
      const keys = Object.keys(row);
      if (keys.length === 1) value = row[keys[0]];
    }
  } catch {
    fail("policy_unavailable");
  }
  if (value === undefined) fail("policy_unavailable");
  return value;
}

function acceptedPragmaValue(name, value) {
  if (name === "journal_mode") {
    return typeof value === "string" && value.toLowerCase() === "persist";
  }
  if (name === "synchronous") {
    return value === 2 || value === "2"
      || (typeof value === "string" && value.toLowerCase() === "full");
  }
  if (name === "foreign_keys") {
    return value === 1 || value === "1" || value === true
      || (typeof value === "string" && value.toLowerCase() === "on");
  }
  if (name === "trusted_schema") {
    return value === 0 || value === "0" || value === false
      || (typeof value === "string" && value.toLowerCase() === "off");
  }
  if (name === "temp_store") {
    return value === 2 || value === "2"
      || (typeof value === "string" && value.toLowerCase() === "memory");
  }
  if (name === "mmap_size") {
    return value === 0 || value === "0";
  }
  return false;
}

const SQLITE_POLICY = Object.freeze([
  Object.freeze({ name: "journal_mode", assignment: "PRAGMA journal_mode = PERSIST;" }),
  Object.freeze({ name: "synchronous", assignment: "PRAGMA synchronous = FULL;" }),
  Object.freeze({ name: "foreign_keys", assignment: "PRAGMA foreign_keys = ON;" }),
  Object.freeze({ name: "trusted_schema", assignment: "PRAGMA trusted_schema = OFF;" }),
  Object.freeze({ name: "temp_store", assignment: "PRAGMA temp_store = MEMORY;" }),
  Object.freeze({ name: "mmap_size", assignment: "PRAGMA mmap_size = 0;" }),
]);

function assertDatabaseLocation(database, expectedPath, { required }) {
  if (typeof database.location !== "function") {
    if (required) fail("database_unavailable");
    return;
  }
  let actual;
  try {
    actual = database.location("main");
  } catch {
    fail("database_unavailable");
  }
  // A qualification double may not implement location yet. A real SQLite
  // file must expose the exact protected path, case-insensitively under the
  // Windows path rules.
  if (actual === null && !required) return;
  if (typeof actual !== "string"
      || win32.normalize(actual).toLowerCase() !== win32.normalize(expectedPath).toLowerCase()) {
    fail("database_unavailable");
  }
}

function installAuthorizer(database, { requireAuthorizer }) {
  // SQLite supplies the PRAGMA name in arg1 and the assigned value in arg2.
  // Reads have a null/undefined arg2, so they remain available to state
  // consumers while writes to the durable-policy tuple are denied. This is
  // the narrowest safe rule available through SQLite's authorizer API.
  if (typeof database.setAuthorizer === "function") {
    try {
      database.setAuthorizer((actionCode, argument1, argument2) => {
        if (actionCode === SQLITE_ATTACH
            || actionCode === SQLITE_DETACH
            || actionCode === "SQLITE_ATTACH"
            || actionCode === "SQLITE_DETACH") {
          return SQLITE_DENY;
        }
        if (actionCode === SQLITE_PRAGMA
            && typeof argument1 === "string"
            && PROTECTED_PRAGMAS.has(argument1.toLowerCase())
            && argument2 !== null
            && argument2 !== undefined) {
          return SQLITE_DENY;
        }
        return SQLITE_OK;
      });
    } catch {
      fail("policy_unavailable");
    }
  } else if (requireAuthorizer) {
    fail("policy_unavailable");
  }
}

function configureDatabase(database) {
  try {
    database.enableDefensive(true);
  } catch {
    fail("policy_unavailable");
  }

  for (const { name, assignment } of SQLITE_POLICY) {
    try {
      if (name === "journal_mode") {
        // SQLite returns the resulting journal mode from the assignment
        // statement itself. `exec()` discards that row, so use prepare/get
        // for both the mutation and the exact readback.
        database.prepare("PRAGMA journal_mode=PERSIST").get();
      } else {
        database.exec(assignment);
      }
      const row = database.prepare(`PRAGMA ${name};`).get();
      const value = pragmaValue(row, name);
      if (!acceptedPragmaValue(name, value)) fail("policy_refused");
    } catch (error) {
      if (isWindowsSqliteStateSessionError(error)) throw error;
      fail("policy_unavailable");
    }
  }
}

function createDatabaseFacade(database) {
  const facade = {
    get isOpen() {
      return databaseIsOpen(database);
    },
    get isTransaction() {
      return databaseInTransaction(database);
    },
    exec(...args) {
      try {
        return database.exec(...args);
      } catch {
        fail("database_unavailable");
      }
    },
    prepare(...args) {
      try {
        return database.prepare(...args);
      } catch {
        fail("database_unavailable");
      }
    },
  };
  Object.freeze(facade);
  DATABASE_FACADES.add(facade);
  return facade;
}

function databaseIsOpen(database) {
  try {
    return database.isOpen !== false;
  } catch {
    return true;
  }
}

function databaseInTransaction(database) {
  try {
    return database.isTransaction === true;
  } catch {
    return false;
  }
}

/**
 * Open one protected Windows SQLite state database.
 *
 * `platform` and `architecture` are injectable only so macOS contract tests
 * can exercise the Windows composition.  A simulated win32 session never
 * reports productionSafe=true; real Windows additionally requires the
 * branded adapter's sqliteStateLeaseSafe qualification bit.
 */
export function createWindowsSqliteStateSession({
  platform = process.platform,
  architecture = process.arch,
  adapter,
  rootPath,
  databaseName,
  databaseFactory = null,
} = {}) {
  normalizedPlatform(platform);
  normalizedArchitecture(architecture);
  if (databaseFactory !== null && typeof databaseFactory !== "function") {
    fail("invalid_configuration");
  }
  if (process.platform !== "win32" && databaseFactory === null) {
    // A simulated win32 run must never create a backslash-named SQLite file
    // in the macOS checkout. Qualification doubles must provide the factory.
    fail("invalid_configuration");
  }
  // Production Windows uses the repository runtime's DatabaseSync directly;
  // an arbitrary injected constructor is qualification-only plumbing and is
  // accepted only from a non-Windows host.
  if (process.platform === "win32" && databaseFactory !== null) {
    fail("invalid_configuration");
  }
  const selectedAdapter = assertAdapter(adapter, {
    // The macOS test loop may simulate win32 with the qualification-only
    // adapter. A real Windows process cannot open a session until the native
    // lease bit is positively qualified.
    requireSqliteLeaseSafe: process.platform === "win32",
  });
  const root = canonicalRoot(rootPath);
  const name = canonicalDatabaseName(databaseName);
  const path = databasePath(root, name);
  const expectedRootIdentity = inspectRoot(selectedAdapter, root);

  let lease = null;
  let database = null;
  try {
    try {
      lease = selectedAdapter.acquireSqliteStateLease(
        root,
        expectedRootIdentity,
        name,
      );
    } catch {
      fail("lease_unavailable");
    }
    if (lease === null
        || (typeof lease !== "object" && typeof lease !== "function")) {
      fail("lease_unavailable");
    }

    try {
      database = (databaseFactory ?? ((databasePath) => new DatabaseSync(databasePath)))(path);
    } catch {
      fail("database_unavailable");
    }
    assertDatabase(database);
    assertDatabaseLocation(database, path, {
      required: process.platform === "win32",
    });
    // DatabaseSync does not expose the native file identity.  Re-open both
    // protected children through the branded root-relative adapter after the
    // connection exists and compare them with the identities pinned by the
    // native lease.  This binds the live connection to the exact files the
    // lease secured, even if a path was redirected before DatabaseSync opened.
    revalidateLeaseIdentities(
      selectedAdapter,
      root,
      expectedRootIdentity,
      name,
      lease,
    );
    configureDatabase(database);
    installAuthorizer(database, {
      requireAuthorizer: process.platform === "win32",
    });
  } catch (error) {
    const failure = isWindowsSqliteStateSessionError(error)
      ? error
      : new WindowsSqliteStateSessionError("database_unavailable");
    // A failed construction must close the DB before releasing the root
    // lease. Roll back first if a test double reports an active transaction.
    let databaseClosed = database === null || !databaseIsOpen(database);
    if (database !== null) {
      if (databaseInTransaction(database)) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // The original fixed construction error remains authoritative.
        }
      }
      try {
        if (databaseIsOpen(database)) {
          database.close();
          databaseClosed = true;
        }
      } catch {
        // The original fixed construction error remains authoritative.
      }
    }
    // Retain the native lease if a close threw while the connection may still
    // be open. Releasing it in that state would permit another writer to race
    // the first connection. A successful close is the release prerequisite.
    if (lease !== null && databaseClosed) {
      try {
        selectedAdapter.releaseSqliteStateLease(lease);
      } catch {
        // A native release failure cannot make a constructor error more
        // informative. The release is intentionally not retried here.
      }
    }
    throw failure;
  }

  let state = "open";
  let leaseReleased = false;
  let leaseReleaseAttempted = false;

  function release() {
    if (leaseReleased || leaseReleaseAttempted) return null;
    leaseReleaseAttempted = true;
    try {
      selectedAdapter.releaseSqliteStateLease(lease);
      leaseReleased = true;
      return null;
    } catch {
      return new WindowsSqliteStateSessionError("lease_release_failed");
    }
  }

  function settle({ rollback }) {
    if (state === "closed") return undefined;
    state = "closing";
    let firstFailure = null;
    if (rollback && databaseInTransaction(database)) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        firstFailure = new WindowsSqliteStateSessionError("rollback_failed");
      }
    }
    try {
      if (databaseIsOpen(database)) database.close();
    } catch {
      // Do not release a lease while the DB may still be open. Leave the
      // state retryable so a later close can succeed and then release it.
      state = "open";
      throw new WindowsSqliteStateSessionError("close_failed");
    }
    const releaseFailure = release();
    if (releaseFailure !== null) {
      // The DB is closed, but the native lease release contract does not
      // guarantee that retrying is safe. Fail closed and make this context
      // permanently settled rather than pretending a retry can recover it.
    }
    state = "closed";
    if (firstFailure !== null) throw firstFailure;
    if (releaseFailure !== null) throw releaseFailure;
    return undefined;
  }

  const session = {
    contractVersion: WINDOWS_SQLITE_STATE_SESSION_CONTRACT_VERSION,
    rootPath: root,
    databaseName: name,
    productionSafe: WINDOWS_SQLITE_STATE_SESSION_PRODUCTION_SAFE,
    sqliteStateLeaseSafe: false,
    database: createDatabaseFacade(database),
    close() {
      return settle({ rollback: false });
    },
    abort() {
      return settle({ rollback: true });
    },
  };
  Object.freeze(session);
  SESSIONS.add(session);
  return session;
}

// Match the existing collector-session naming while keeping the explicit
// `create` constructor used by the Windows platform contexts.
export function openWindowsSqliteStateSession(options = {}) {
  return createWindowsSqliteStateSession(options);
}
