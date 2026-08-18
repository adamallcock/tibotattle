import {
  chmodSync,
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION =
  "windows-credential-operation-audit-v1";
export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_APPLICATION_ID = 0x55434155;
export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_USER_VERSION = 1;
export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS = 256;
export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_PENDING_ROWS = 16;

export const WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS = Object.freeze([
  Object.freeze({ owner: "participant-identity", capability: "export_identity" }),
  Object.freeze({ owner: "account-observation", capability: "account_observation" }),
  Object.freeze({ owner: "claude-callback", capability: "claude_callback" }),
  Object.freeze({ owner: "contribution-device", capability: "contribution_device" }),
]);

const OPERATIONS = new Set(["create", "replace", "delete"]);
const RESULTS = new Set([
  "created",
  "existing",
  "replaced",
  "missing",
  "conflict",
  "deleted",
  "failed",
]);
const FAILURE_CLASSES = new Set([
  "locked",
  "denied",
  "operation_failed",
  "readback_mismatch",
  "audit_failed",
]);
const RECOVERY_CLASSES = new Set(["unknown_after_crash"]);
const UUID_PATTERN = /^[0-9a-f-]{36}$/iu;
const MAXIMUM_PATH_LENGTH = 4_096;

const OWNER_BY_CAPABILITY = new Map(
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS
    .map(({ owner, capability }) => [capability, owner]),
);
const CAPABILITY_BY_OWNER = new Map(
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS
    .map(({ owner, capability }) => [owner, capability]),
);

const trustedAuditErrors = new WeakSet();
const trustedAuditStores = new WeakSet();

export class WindowsCredentialOperationAuditError extends Error {
  constructor(code) {
    if (!new Set([
      "invalid_configuration",
      "unavailable",
      "schema_invalid",
      "closed",
      "invalid_record",
      "duplicate",
      "missing",
      "invalid_transition",
      "pending_limit",
    ]).has(code)) {
      throw new TypeError("Unknown Windows credential operation audit error code");
    }
    super("Windows credential operation audit store failed");
    this.name = "WindowsCredentialOperationAuditError";
    this.code = `windows_credential_operation_audit_${code}`;
    trustedAuditErrors.add(this);
  }
}

export function isWindowsCredentialOperationAuditError(error) {
  return Boolean(error && trustedAuditErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsCredentialOperationAuditError.prototype);
}

export function isWindowsCredentialOperationAuditStore(store) {
  return Boolean(store && trustedAuditStores.has(store)
    && Object.getPrototypeOf(store) === Object.prototype);
}

function fail(code) {
  throw new WindowsCredentialOperationAuditError(code);
}

function assertOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  return options;
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_record");
  }
  return value;
}

function assertPath(value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > MAXIMUM_PATH_LENGTH
      || value.includes("\0")
      || !isAbsolute(value)) {
    fail("invalid_configuration");
  }
  return value;
}

function assertPlatformPath(value, platform) {
  const pathModule = platform === "win32" ? win32 : posix;
  if (typeof value !== "string"
      || value.length < 1
      || value.length > MAXIMUM_PATH_LENGTH
      || value.includes("\0")
      || !pathModule.isAbsolute(value)) {
    fail("invalid_configuration");
  }
  return value;
}

function assertTimestamp(value, fallbackClock) {
  const timestamp = value === undefined ? fallbackClock() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("invalid_record");
  return timestamp;
}

function assertUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail("invalid_record");
  return value;
}

function assertCapabilityPair(owner, capability) {
  if (typeof owner !== "string" || typeof capability !== "string"
      || OWNER_BY_CAPABILITY.get(capability) !== owner
      || CAPABILITY_BY_OWNER.get(owner) !== capability) {
    fail("invalid_record");
  }
}

function assertOperation(value) {
  if (typeof value !== "string" || !OPERATIONS.has(value)) fail("invalid_record");
  return value;
}

function assertResult(value) {
  if (typeof value !== "string" || !RESULTS.has(value)) fail("invalid_record");
  return value;
}

function assertFailureClass(value) {
  if (value !== null && (typeof value !== "string" || !FAILURE_CLASSES.has(value))) {
    fail("invalid_record");
  }
  return value;
}

function assertRecoveryClass(value) {
  if (typeof value !== "string" || !RECOVERY_CLASSES.has(value)) {
    fail("invalid_record");
  }
  return value;
}

function assertDirectory(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("unavailable");
  }
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("unavailable");
  }
}

function assertDatabaseFile(path, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    fail("unavailable");
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("unavailable");
  }
  return metadata;
}

function assertNoSymlinkBoundary(path) {
  let cursor = path;
  // The file contract owns the immediate `private` directory and its state
  // root. Do not reject a platform-managed symlink outside that boundary
  // (for example macOS's /var -> /private/var alias).
  for (let depth = 0; depth < 2; depth += 1) {
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fail("unavailable");
      }
      fail("unavailable");
    }
    if (metadata.isSymbolicLink()) fail("unavailable");
    cursor = dirname(cursor);
  }
}

function syncFile(path) {
  let handle;
  try {
    const flags = process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
    handle = openSync(path, flags);
    fsyncSync(handle);
  } catch {
    fail("unavailable");
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        fail("unavailable");
      }
    }
  }
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(handle);
  } catch {
    fail("unavailable");
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        fail("unavailable");
      }
    }
  }
}

function configureDatabase(database) {
  try {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA trusted_schema=OFF;
      PRAGMA temp_store=MEMORY;
      PRAGMA mmap_size=0;
    `);
  } catch {
    fail("unavailable");
  }
}

function initializeSchema(database) {
  try {
    database.exec(`
      PRAGMA application_id=${WINDOWS_CREDENTIAL_OPERATION_AUDIT_APPLICATION_ID};
      PRAGMA user_version=${WINDOWS_CREDENTIAL_OPERATION_AUDIT_USER_VERSION};
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS credential_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        lease_id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL CHECK(owner IN (
          'participant-identity',
          'account-observation',
          'claude-callback',
          'contribution-device'
        )),
        capability TEXT NOT NULL CHECK(capability IN (
          'export_identity',
          'account_observation',
          'claude_callback',
          'contribution_device'
        )),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'replace', 'delete')),
        phase TEXT NOT NULL CHECK(phase IN ('prepared', 'settled', 'recovered')),
        result TEXT CHECK(result IS NULL OR result IN (
          'created', 'existing', 'replaced', 'missing',
          'conflict', 'deleted', 'failed'
        )),
        failure_class TEXT CHECK(failure_class IS NULL OR failure_class IN (
          'locked', 'denied', 'operation_failed',
          'readback_mismatch', 'audit_failed'
        )),
        prepared_at INTEGER NOT NULL,
        settled_at INTEGER,
        recovered_at INTEGER,
        recovery_class TEXT CHECK(
          recovery_class IS NULL OR recovery_class = 'unknown_after_crash'
        ),
        CHECK(
          (owner = 'participant-identity' AND capability = 'export_identity') OR
          (owner = 'account-observation' AND capability = 'account_observation') OR
          (owner = 'claude-callback' AND capability = 'claude_callback') OR
          (owner = 'contribution-device' AND capability = 'contribution_device')
        ),
        CHECK((phase = 'prepared' AND result IS NULL AND settled_at IS NULL
          AND recovered_at IS NULL AND failure_class IS NULL AND recovery_class IS NULL)
          OR (phase = 'settled' AND result IS NOT NULL AND settled_at IS NOT NULL
          AND recovered_at IS NULL AND recovery_class IS NULL)
          OR (phase = 'recovered' AND result IS NULL AND recovered_at IS NOT NULL
          AND recovery_class = 'unknown_after_crash' AND settled_at IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS credential_operations_phase_sequence
        ON credential_operations(phase, sequence);
      INSERT OR IGNORE INTO meta(key, value)
        VALUES ('schema_version', '${WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION}');
    `);
  } catch {
    fail("schema_invalid");
  }
}

function validateSchema(database) {
  try {
    const applicationId = Number(
      database.prepare("PRAGMA application_id").get().application_id,
    );
    const userVersion = Number(
      database.prepare("PRAGMA user_version").get().user_version,
    );
    const schema = database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get();
    if (applicationId !== WINDOWS_CREDENTIAL_OPERATION_AUDIT_APPLICATION_ID
        || userVersion !== WINDOWS_CREDENTIAL_OPERATION_AUDIT_USER_VERSION
        || schema?.value !== WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION) {
      fail("schema_invalid");
    }
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("schema_invalid");
  }
}

function transaction(database, filePath, callback) {
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      syncFile(filePath);
      syncDirectory(filePath);
      return result;
    } catch (error) {
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } catch {
        // The fixed outer error is authoritative; SQLite text never escapes.
      }
      throw error;
    }
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("unavailable");
  }
}

function pruneTerminalRows(database) {
  database.prepare(`
    DELETE FROM credential_operations
    WHERE phase IN ('settled', 'recovered')
      AND sequence NOT IN (
        SELECT sequence
        FROM credential_operations
        WHERE phase IN ('settled', 'recovered')
        ORDER BY sequence DESC
        LIMIT ?
      )
  `).run(WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS);
}

function rowValue(row) {
  return Object.freeze({
    version: WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION,
    sequence: Number(row.sequence),
    leaseId: row.lease_id,
    owner: row.owner,
    capability: row.capability,
    operation: row.operation,
    phase: row.phase,
    result: row.result ?? null,
    failureClass: row.failure_class ?? null,
    preparedAt: Number(row.prepared_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    recoveredAt: row.recovered_at === null ? null : Number(row.recovered_at),
    recoveryClass: row.recovery_class ?? null,
  });
}

function listRows(database, where = "1 = 1") {
  let rows;
  try {
    rows = database.prepare(`
      SELECT sequence, lease_id, owner, capability, operation,
             phase, result, failure_class, prepared_at,
             settled_at, recovered_at, recovery_class
      FROM credential_operations
      WHERE ${where}
      ORDER BY sequence ASC
    `).all();
  } catch {
    fail("unavailable");
  }
  return Object.freeze(rows.map(rowValue));
}

function normalizePrepare(value, clock) {
  const record = assertPlainObject(value);
  let leaseId;
  let owner;
  let capability;
  let operation;
  let at;
  try {
    leaseId = assertUuid(record.leaseId);
    owner = record.owner;
    capability = record.capability;
    operation = assertOperation(record.operation);
    at = assertTimestamp(record.at, clock);
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("invalid_record");
  }
  assertCapabilityPair(owner, capability);
  return Object.freeze({ leaseId, owner, capability, operation, at });
}

function normalizeSettle(value, clock) {
  const record = assertPlainObject(value);
  let leaseId;
  let result;
  let failureClass = null;
  let at;
  try {
    leaseId = assertUuid(record.leaseId);
    result = assertResult(record.result);
    failureClass = assertFailureClass(record.failureClass ?? null);
    at = assertTimestamp(record.at, clock);
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("invalid_record");
  }
  if (result !== "failed" && failureClass !== null) fail("invalid_record");
  return Object.freeze({ leaseId, result, failureClass, at });
}

function normalizeRecovery(value, clock) {
  const record = assertPlainObject(value);
  let leaseId;
  let recoveryClass;
  let at;
  try {
    leaseId = assertUuid(record.leaseId);
    recoveryClass = assertRecoveryClass(record.recoveryClass);
    at = assertTimestamp(record.at, clock);
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("invalid_record");
  }
  return Object.freeze({ leaseId, recoveryClass, at });
}

function openAuditDatabase(filePath) {
  const path = assertPath(filePath);
  const parent = dirname(path);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch {
    fail("unavailable");
  }
  assertNoSymlinkBoundary(parent);
  assertDirectory(parent);
  const existing = assertDatabaseFile(path, { allowMissing: true });
  if (existing !== null && existing.size > 0) {
    let handle;
    try {
      handle = openSync(path, constants.O_RDONLY);
      const bytes = Buffer.alloc(16);
      const count = readSync(handle, bytes, 0, bytes.byteLength, 0);
      const header = bytes.subarray(0, count).toString("utf8");
      if (header !== "SQLite format 3\0") fail("schema_invalid");
    } catch (error) {
      if (isWindowsCredentialOperationAuditError(error)) throw error;
      fail("unavailable");
    } finally {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          fail("unavailable");
        }
      }
    }
  }
  let database;
  try {
    database = new DatabaseSync(path, { timeout: 5_000 });
    configureDatabase(database);
    if (existing === null || existing.size === 0) initializeSchema(database);
    else validateSchema(database);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The fixed error below is authoritative for database cleanup failures.
    }
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    // A non-empty file that cannot be opened as the reviewed SQLite schema is
    // a content-free schema failure. Permission and path failures are caught
    // by the fixed filesystem checks before this point.
    fail(existing !== null && existing.size > 0 ? "schema_invalid" : "unavailable");
  }
  syncFile(path);
  return database;
}

export function defaultWindowsCredentialOperationAuditFile({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
  stateRoot = null,
} = {}) {
  try {
    if (typeof platform !== "string"
        || (platform !== "darwin" && platform !== "linux" && platform !== "win32")
        || typeof homeDirectory !== "string"
        || !environment
        || typeof environment !== "object"
        || Array.isArray(environment)) {
      fail("invalid_configuration");
    }
    let root = stateRoot;
    if (root === null) {
      const path = platform === "win32" ? win32 : posix;
      root = platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support", "app-usagemonitor")
        : platform === "win32"
          ? path.join(
            environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local"),
            "app-usagemonitor",
          )
          : path.join(
            environment.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state"),
            "app-usagemonitor",
          );
    }
    assertPlatformPath(root, platform);
    const pathModule = platform === "win32" ? win32 : posix;
    return pathModule.join(root, "private", "windows-credential-operation-audit-v1.sqlite");
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("invalid_configuration");
  }
}

export function createWindowsCredentialOperationAuditStore(options = {}) {
  const configuration = assertOptions(options);
  let filePath;
  let clock;
  try {
    filePath = configuration.filePath ?? defaultWindowsCredentialOperationAuditFile();
    clock = configuration.clock ?? (() => Date.now());
  } catch (error) {
    if (isWindowsCredentialOperationAuditError(error)) throw error;
    fail("invalid_configuration");
  }
  assertPath(filePath);
  if (typeof clock !== "function") fail("invalid_configuration");

  const database = openAuditDatabase(filePath);
  let closed = false;
  const ensureOpen = () => {
    if (closed || !database.isOpen) fail("closed");
  };

  const store = {
    get filePath() {
      return filePath;
    },
    get closed() {
      return closed;
    },
    prepare(value) {
      ensureOpen();
      const record = normalizePrepare(value, clock);
      return transaction(database, filePath, () => {
        const pending = Number(database.prepare(
          "SELECT COUNT(*) AS count FROM credential_operations WHERE phase = 'prepared'",
        ).get().count);
        const existing = database.prepare(
          "SELECT phase FROM credential_operations WHERE lease_id = ?",
        ).get(record.leaseId);
        if (existing) fail(existing.phase === "prepared" ? "duplicate" : "invalid_transition");
        if (pending >= WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_PENDING_ROWS) {
          fail("pending_limit");
        }
        try {
          database.prepare(`
            INSERT INTO credential_operations(
              lease_id, owner, capability, operation, phase,
              result, failure_class, prepared_at, settled_at,
              recovered_at, recovery_class
            ) VALUES (?, ?, ?, ?, 'prepared', NULL, NULL, ?, NULL, NULL, NULL)
          `).run(record.leaseId, record.owner, record.capability, record.operation, record.at);
        } catch {
          fail("unavailable");
        }
        return rowValue(database.prepare(`
          SELECT sequence, lease_id, owner, capability, operation,
                 phase, result, failure_class, prepared_at,
                 settled_at, recovered_at, recovery_class
          FROM credential_operations WHERE lease_id = ?
        `).get(record.leaseId));
      });
    },
    settle(value) {
      ensureOpen();
      const record = normalizeSettle(value, clock);
      return transaction(database, filePath, () => {
        const existing = database.prepare(`
          SELECT phase, owner, capability, operation
          FROM credential_operations WHERE lease_id = ?
        `).get(record.leaseId);
        if (!existing) fail("missing");
        if (existing.phase !== "prepared") fail("invalid_transition");
        try {
          database.prepare(`
            UPDATE credential_operations
            SET phase = 'settled', result = ?, failure_class = ?, settled_at = ?
            WHERE lease_id = ? AND phase = 'prepared'
          `).run(record.result, record.failureClass, record.at, record.leaseId);
          pruneTerminalRows(database);
        } catch {
          fail("unavailable");
        }
        return rowValue(database.prepare(`
          SELECT sequence, lease_id, owner, capability, operation,
                 phase, result, failure_class, prepared_at,
                 settled_at, recovered_at, recovery_class
          FROM credential_operations WHERE lease_id = ?
        `).get(record.leaseId));
      });
    },
    recover(value) {
      ensureOpen();
      const record = normalizeRecovery(value, clock);
      return transaction(database, filePath, () => {
        const existing = database.prepare(
          "SELECT phase FROM credential_operations WHERE lease_id = ?",
        ).get(record.leaseId);
        if (!existing) fail("missing");
        if (existing.phase !== "prepared") fail("invalid_transition");
        try {
          database.prepare(`
            UPDATE credential_operations
            SET phase = 'recovered', result = NULL, failure_class = NULL,
                recovered_at = ?, recovery_class = ?
            WHERE lease_id = ? AND phase = 'prepared'
          `).run(record.at, record.recoveryClass, record.leaseId);
          pruneTerminalRows(database);
        } catch {
          fail("unavailable");
        }
        return rowValue(database.prepare(`
          SELECT sequence, lease_id, owner, capability, operation,
                 phase, result, failure_class, prepared_at,
                 settled_at, recovered_at, recovery_class
          FROM credential_operations WHERE lease_id = ?
        `).get(record.leaseId));
      });
    },
    read() {
      ensureOpen();
      return listRows(database);
    },
    readPending() {
      ensureOpen();
      return listRows(database, "phase = 'prepared'");
    },
    close() {
      if (closed) return;
      try {
        database.close();
      } catch {
        fail("unavailable");
      } finally {
        closed = true;
      }
    },
  };
  Object.freeze(store);
  trustedAuditStores.add(store);
  return store;
}
