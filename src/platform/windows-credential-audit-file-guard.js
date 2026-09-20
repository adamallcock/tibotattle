import { win32 } from "node:path";

import { loadWindowsFilesystemBinding } from "./windows-filesystem.js";
import {
  acquireProtectedSqliteFiles,
  isWindowsProtectedSqliteError,
  validateProtectedSqliteBinding,
} from "./windows-protected-sqlite.js";

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

function mapFailure(error) {
  fail(isWindowsProtectedSqliteError(error) ? error.code : "unavailable");
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
  let native;
  try { native = validateProtectedSqliteBinding(nativeBinding); }
  catch (error) { mapFailure(error); }
  const records = new WeakMap();

  function acquire(databasePath) {
    const path = validateAuditPath(databasePath);
    let files;
    try { files = acquireProtectedSqliteFiles({ native, path, pathApi: win32 }); }
    catch (error) { mapFailure(error); }
    const lease = Object.freeze({ version: CONTRACT_VERSION });
    records.set(lease, files);
    return lease;
  }

  function release(lease) {
    const files = records.get(lease);
    if (!files) fail("foreign");
    records.delete(lease);
    try { files.release(); }
    catch (error) { mapFailure(error); }
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
