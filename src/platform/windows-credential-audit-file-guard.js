import { win32 } from "node:path";

import { loadWindowsFilesystemBinding } from "./windows-filesystem.js";

const AUDIT_FILE_NAME = "windows-credential-operation-audit-v1.sqlite";
const CONTRACT_VERSION = "windows-credential-audit-file-guard-v1";
const trustedContexts = new WeakSet();
const trustedErrors = new WeakSet();

export class WindowsCredentialAuditFileGuardError extends Error {
  constructor(code) {
    if (!new Set([
      "invalid_configuration",
      "unavailable",
      "security_policy",
      "release_failed",
      "foreign",
    ]).has(code)) {
      throw new TypeError("Unknown Windows credential audit file guard error code");
    }
    super("Windows credential audit file guard failed");
    this.name = "WindowsCredentialAuditFileGuardError";
    this.code = `windows_credential_audit_file_guard_${code}`;
    trustedErrors.add(this);
  }
}

export function isWindowsCredentialAuditFileGuardError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsCredentialAuditFileGuardError.prototype);
}

export function isWindowsCredentialAuditFileGuardContext(context) {
  return Boolean(context && trustedContexts.has(context));
}

function fail(code) {
  throw new WindowsCredentialAuditFileGuardError(code);
}

function validateBinding(binding) {
  let valid = false;
  try {
    valid = binding !== null
      && typeof binding === "object"
      && typeof binding.ensureDirectory === "function"
      && typeof binding.createFile === "function"
      && typeof binding.acquireCredentialAuditFileGuard === "function"
      && typeof binding.releaseCredentialAuditFileGuard === "function"
      && binding.credentialAuditFileGuardContractVersion === CONTRACT_VERSION
      && binding.credentialAuditFileGuardSafe === true;
  } catch {
    // Hostile or malformed bindings collapse to one fixed boundary error.
  }
  if (!valid) fail("invalid_configuration");
  return binding;
}

function validateIdentity(value) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.volumeSerialNumber === "string"
    && /^[0-9a-f]{16}$/u.test(value.volumeSerialNumber)
    && typeof value.fileId === "string"
    && /^[0-9a-f]{32}$/u.test(value.fileId)
    && value.linkCount === 1);
}

function nativeErrorCode(error, operation) {
  let code;
  try {
    code = error?.code;
  } catch {
    return operation === "release" ? "release_failed" : "unavailable";
  }
  if (code === "WINDOWS_FILESYSTEM_SECURITY_POLICY"
      || code === "WINDOWS_FILESYSTEM_REPARSE_POINT"
      || code === "WINDOWS_FILESYSTEM_HARD_LINK"
      || code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") {
    return "security_policy";
  }
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_AUDIT_GUARD_FOREIGN") return "foreign";
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_AUDIT_GUARD_RELEASE_FAILED") {
    return "release_failed";
  }
  return operation === "release" ? "release_failed" : "unavailable";
}

function isAlreadyExists(error) {
  try {
    return error?.code === "EEXIST"
      || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
  } catch {
    return false;
  }
}

function validateAuditPath(path) {
  if (typeof path !== "string"
      || path.length < 1
      || path.length > 4_096
      || path.includes("\0")
      || !win32.isAbsolute(path)
      || win32.basename(path) !== AUDIT_FILE_NAME) {
    fail("invalid_configuration");
  }
  return path;
}

export function createWindowsCredentialAuditFileGuardContext({
  platform = process.platform,
  architecture = process.arch,
  binding = undefined,
  loadBinding = loadWindowsFilesystemBinding,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") fail("unavailable");
  if (typeof loadBinding !== "function") fail("invalid_configuration");
  let nativeBinding = binding;
  if (nativeBinding === undefined) {
    try {
      nativeBinding = loadBinding({ platform, architecture });
    } catch {
      fail("unavailable");
    }
  }
  const native = validateBinding(nativeBinding);
  const records = new WeakMap();

  function ensureFile(path) {
    try {
      native.createFile(path, Buffer.alloc(0));
    } catch (error) {
      if (!isAlreadyExists(error)) fail(nativeErrorCode(error, "acquire"));
    }
  }

  function acquireNative(path) {
    let result;
    try {
      result = native.acquireCredentialAuditFileGuard(path);
    } catch (error) {
      fail(nativeErrorCode(error, "acquire"));
    }
    let valid = false;
    try {
      valid = result !== null
        && typeof result === "object"
        && !Array.isArray(result)
        && Object.keys(result).sort().join("\0") === "guard\0identity"
        && result.guard !== null
        && (typeof result.guard === "object" || typeof result.guard === "function")
        && validateIdentity(result.identity);
    } catch {
      valid = false;
    }
    if (!valid) fail("unavailable");
    return result.guard;
  }

  function acquire(databasePath) {
    const path = validateAuditPath(databasePath);
    const journalPath = `${path}-journal`;
    try {
      const privateDirectory = win32.dirname(path);
      native.ensureDirectory(win32.dirname(privateDirectory));
      native.ensureDirectory(privateDirectory);
      ensureFile(path);
      ensureFile(journalPath);
    } catch (error) {
      if (isWindowsCredentialAuditFileGuardError(error)) throw error;
      fail(nativeErrorCode(error, "acquire"));
    }
    const guards = [];
    try {
      guards.push(acquireNative(path));
      guards.push(acquireNative(journalPath));
    } catch (error) {
      for (const guard of guards.reverse()) {
        try {
          native.releaseCredentialAuditFileGuard(guard);
        } catch {
          // The original fixed acquisition error remains authoritative.
        }
      }
      throw error;
    }
    const lease = Object.freeze({ version: CONTRACT_VERSION });
    records.set(lease, { active: true, guards });
    return lease;
  }

  function release(lease) {
    let record;
    try {
      record = records.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record?.active) fail("foreign");
    let releaseFailed = false;
    for (const guard of [...record.guards].reverse()) {
      try {
        native.releaseCredentialAuditFileGuard(guard);
      } catch {
        releaseFailed = true;
      }
    }
    record.active = false;
    records.delete(lease);
    if (releaseFailed) fail("release_failed");
  }

  const context = Object.freeze({
    acquire,
    release,
    filesystemProtected: true,
    productionSafe: false,
  });
  trustedContexts.add(context);
  return context;
}
