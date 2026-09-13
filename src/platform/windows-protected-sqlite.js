import { win32 } from "node:path";

const CONTRACT_VERSION = "windows-credential-audit-file-guard-v1";
const trustedErrors = new WeakSet();
const ERROR_CODES = new Set([
  "invalid_configuration", "unavailable", "security_policy", "release_failed", "foreign",
]);

export class WindowsProtectedSqliteError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown protected SQLite error code");
    super("Windows protected SQLite operation failed");
    this.name = "WindowsProtectedSqliteError";
    this.code = code;
    trustedErrors.add(this);
  }
}

export function isWindowsProtectedSqliteError(error) {
  return Boolean(error && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsProtectedSqliteError.prototype);
}

function fail(code) { throw new WindowsProtectedSqliteError(code); }

function nativeErrorCode(error, operation) {
  let code;
  try { code = error?.code; } catch { /* Native details never escape. */ }
  if (["WINDOWS_FILESYSTEM_SECURITY_POLICY", "WINDOWS_FILESYSTEM_REPARSE_POINT",
    "WINDOWS_FILESYSTEM_HARD_LINK", "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"].includes(code)) {
    return "security_policy";
  }
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_AUDIT_GUARD_FOREIGN") return "foreign";
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_AUDIT_GUARD_RELEASE_FAILED") return "release_failed";
  return operation === "release" ? "release_failed" : "unavailable";
}

export function validateProtectedSqliteBinding(native) {
  let valid = false;
  try {
    valid = native !== null && typeof native === "object"
      && typeof native.ensureDirectory === "function"
      && typeof native.createFile === "function"
      && typeof native.acquireCredentialAuditFileGuard === "function"
      && typeof native.releaseCredentialAuditFileGuard === "function"
      && native.credentialAuditFileGuardContractVersion === CONTRACT_VERSION
      && native.credentialAuditFileGuardSafe === true;
  } catch { /* Malformed bindings collapse to a fixed error. */ }
  if (!valid) fail("invalid_configuration");
  return native;
}

function validIdentity(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.volumeSerialNumber === "string"
    && /^[0-9a-f]{16}$/u.test(value.volumeSerialNumber)
    && typeof value.fileId === "string" && /^[0-9a-f]{32}$/u.test(value.fileId)
    && value.linkCount === 1;
}

// The callers retain ownership of allowed database names and schema policy.
// This adapter only creates owner-protected files and pins their identities.
export function acquireProtectedSqliteFiles({ native, path, pathApi = win32 }) {
  validateProtectedSqliteBinding(native);
  let valid = false;
  try {
    valid = typeof path === "string" && path.length > 0 && path.length <= 4_096
      && !path.includes("\0") && pathApi.isAbsolute(path);
  } catch { /* Invalid path adapters cannot expose private details. */ }
  if (!valid) fail("invalid_configuration");
  const guards = [];
  let created = false;
  try {
    const directory = pathApi.dirname(path);
    native.ensureDirectory(pathApi.dirname(directory));
    native.ensureDirectory(directory);
    for (const file of [path, `${path}-journal`]) {
      try {
        native.createFile(file, Buffer.alloc(0));
        if (file === path) created = true;
      } catch (error) {
        let exists = false;
        try {
          exists = error?.code === "EEXIST" || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
        } catch { /* Preserve the fixed acquisition failure. */ }
        if (!exists) throw error;
      }
    }
    for (const file of [path, `${path}-journal`]) {
      const result = native.acquireCredentialAuditFileGuard(file);
      let guard;
      let validResult = false;
      try {
        guard = result?.guard;
        if (guard !== null && (typeof guard === "object" || typeof guard === "function")) {
          guards.push(guard);
          validResult = result !== null && typeof result === "object" && !Array.isArray(result)
            && Object.keys(result).sort().join("\0") === "guard\0identity"
            && validIdentity(result.identity);
        }
      } catch { /* Any returned guard is still released on validation failure. */ }
      if (!validResult) fail("unavailable");
    }
  } catch (error) {
    for (const guard of guards.reverse()) {
      try { native.releaseCredentialAuditFileGuard(guard); } catch { /* Preserve original failure. */ }
    }
    if (isWindowsProtectedSqliteError(error)) throw error;
    fail(nativeErrorCode(error, "acquire"));
  }
  let active = true;
  return Object.freeze({
    created,
    release() {
      if (!active) fail("foreign");
      active = false;
      let failed = false;
      for (const guard of [...guards].reverse()) {
        try { native.releaseCredentialAuditFileGuard(guard); } catch { failed = true; }
      }
      if (failed) fail("release_failed");
    },
  });
}

// A Windows guard denies journal deletion. Recover a hot rollback journal while
// SQLite holds an exclusive lock, so recovery invalidates it in place. Setting
// PERSIST alone is insufficient: recovery can otherwise delete the journal.
// Return to NORMAL and perform a read to release the temporary exclusive lock.
// Call before the first schema query; callers close the database on failure.
export function configureGuardedSqliteConnection(database) {
  try {
    database.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=PERSIST;");
    database.prepare("PRAGMA schema_version").get();
    database.exec("PRAGMA locking_mode=NORMAL; PRAGMA temp_store=MEMORY;");
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
  } catch { fail("unavailable"); }
}
