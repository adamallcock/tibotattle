import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { safeShellCode } from "./errors.js";
import {
  classifyDesktopSecureStorageFailure,
  isDesktopSecureStorageFailure,
} from "./desktop-secure-storage-readiness.js";

export const DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA =
  "tibotattle-electron-startup-diagnostic-v1";
export const DESKTOP_STARTUP_DIAGNOSTIC_FILE = "startup-diagnostic-v1.json";

const STARTUP_PHASES = new Set([
  "bootstrap",
  "package_metadata",
  "profile_selection",
  "crash_capture",
  "runtime_qualification",
  "platform_gate",
  "runtime_paths",
  "credential_wiring",
  "app_ready",
  "native_handover",
  "installation_state",
  "first_run",
  "secure_storage",
  "runtime_services",
  "settings",
  "lifecycle",
  "updater",
  "ready",
]);
const STOP_CODES = new Set([
  "native_handover_blocked",
  "secondary_instance",
  "secure_storage_locked",
  "secure_storage_denied",
  "secure_storage_migration_required",
  "secure_storage_timeout",
  "secure_storage_credential_invalid",
  "secure_storage_adapter_integrity_failed",
  "secure_storage_security_unavailable",
  "startup_stopped",
]);
const SAFE_CODE = /^[a-z][a-z0-9_]{1,95}$/u;
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,80}$/u;

function safeInstant(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function failureCode(error) {
  if (isDesktopSecureStorageFailure(error)) {
    return `secure_storage_${classifyDesktopSecureStorageFailure(error)}`;
  }
  const selected = safeShellCode(error, "startup_unclassified");
  return SAFE_CODE.test(selected) ? selected : "startup_unclassified";
}

function stopCode(value) {
  return STOP_CODES.has(value) ? value : "startup_stopped";
}

function safeVersion(value) {
  return typeof value === "string" && SAFE_VERSION.test(value) ? value : "unknown";
}

async function writeOwnerOnlyRecord(rootPath, filename, record, uid) {
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const root = await lstat(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink()
      || (uid !== null && root.uid !== uid) || (root.mode & 0o022) !== 0) {
    return false;
  }
  const temporary = join(rootPath, `.${filename}.${randomUUID()}.tmp`);
  const finalPath = join(rootPath, filename);
  let handle;
  try {
    handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, finalPath);
    const directory = await open(rootPath, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Keep one bounded, content-free startup result outside the companion process.
 * Keep its directory separate from state/settings targets owned by native handover.
 * Failures in this optional journal never affect application startup.
 */
export function createDesktopStartupDiagnostics({
  app,
  rootPath,
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  now = () => new Date(),
} = {}) {
  let phase = "bootstrap";
  let startedAt = null;
  let settled = false;
  let selectedRoot = null;
  let version = "unknown";
  try { version = safeVersion(app?.getVersion?.()); } catch { /* Optional metadata. */ }

  const timestamp = () => {
    try {
      const value = now().toISOString();
      return safeInstant(value) ? value : null;
    } catch {
      return null;
    }
  };

  const persist = async (outcome, code) => {
    if (selectedRoot === null || startedAt === null) return false;
    const recordedAt = timestamp();
    if (recordedAt === null) return false;
    try {
      return await writeOwnerOnlyRecord(selectedRoot, DESKTOP_STARTUP_DIAGNOSTIC_FILE, {
        schemaVersion: DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA,
        recordedAt,
        startedAt,
        phase,
        outcome,
        code,
        platform: ["darwin", "win32", "linux"].includes(platform) ? platform : "unknown",
        architecture: ["arm64", "x64", "ia32", "arm"].includes(architecture)
          ? architecture : "unknown",
        version,
      }, uid);
    } catch {
      return false;
    }
  };

  return Object.freeze({
    async start() {
      if (startedAt !== null) return false;
      try {
        selectedRoot = resolve(rootPath
          ?? join(app.getPath("userData"), "startup-diagnostics"));
      } catch {
        selectedRoot = null;
      }
      startedAt = timestamp();
      if (startedAt === null) return false;
      return persist("in_progress", null);
    },
    mark(nextPhase) {
      if (!settled && STARTUP_PHASES.has(nextPhase)) phase = nextPhase;
    },
    async fail(error) {
      if (settled) return false;
      settled = true;
      try {
        return await persist("failed", failureCode(error));
      } catch {
        return false;
      }
    },
    async stop(code) {
      if (settled) return false;
      settled = true;
      return persist("stopped", stopCode(code));
    },
    async complete() {
      if (settled) return false;
      phase = "ready";
      settled = true;
      return persist("ready", null);
    },
  });
}
