import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createMacOSKeychainAdapterFacade,
  MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY,
  MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES,
  MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES,
} from "../../native/macos-keychain/contract.js";
import { CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER } from "../../src/platform/index.js";
import { PRODUCTION_ELECTRON_APP_ID } from "./desktop-updater.js";
import distribution from "../../config/electron-production-distribution.cjs";

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 15_000;
const MAX_ADAPTER_BYTES = 5 * 1024 * 1024;
export const DESKTOP_MACOS_KEYCHAIN_RESOURCE_PATH =
  distribution.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH;

function failure(code = "KEYCHAIN_DENIED") {
  return Object.assign(new Error("Desktop credentials are unavailable"), { code });
}

function assertStatus(status) {
  if (status === "locked") throw failure("KEYCHAIN_LOCKED");
  if (status === "denied") throw failure("KEYCHAIN_DENIED");
  if (status === "migration_required") throw failure("KEYCHAIN_MIGRATION_REQUIRED");
  throw failure("broker_unavailable");
}

function assertBrokerCapability(capability) {
  if (!MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES.includes(capability)) throw failure();
  return capability;
}

function accountlessFailure({
  recoveryRequired = false,
  retryable = false,
  knownNonMutation = false,
} = {}) {
  const error = Object.assign(new Error(recoveryRequired
    ? "Installation credential recovery is required"
    : "Installation credential unavailable"), {
    code: recoveryRequired
      ? "contribution_device_credential_recovery_required"
      : "contribution_device_credential_unavailable",
    retryable: recoveryRequired ? false : retryable,
  });
  // A native locked result is returned before a conditional Keychain mutation
  // completes. Keep that fact main-process-only so FD3 can retry instead of
  // retaining a public binding for a secret that was never stored.
  if (knownNonMutation) {
    Object.defineProperty(error, "knownNonMutation", { value: true });
  }
  return error;
}

function assertAccountlessStatus(status, { knownNonMutation = false } = {}) {
  if (status === "locked") {
    throw accountlessFailure({ retryable: true, knownNonMutation });
  }
  if (status === "migration_required") throw accountlessFailure({ recoveryRequired: true });
  throw accountlessFailure();
}

async function assertLegacyCredentialAbsent(legacyCredentialProbe) {
  let status;
  try { status = await legacyCredentialProbe(); }
  catch { throw accountlessFailure(); }
  if (status === "absent") return;
  if (status === "present") throw accountlessFailure({ recoveryRequired: true });
  throw accountlessFailure();
}

function createDesktopMacOSCredentialBackendFromAdapter(adapter) {
  const backend = {
    async get(capability) {
      const result = await adapter.read(assertBrokerCapability(capability));
      if (result.status === "absent") return null;
      if (result.status !== "present") return assertStatus(result.status);
      try { return result.value.toString("base64url"); }
      finally { result.value.fill(0); }
    },
    async set(capability, value) {
      assertBrokerCapability(capability);
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw failure();
      const secret = Buffer.from(value, "base64url");
      try {
        if (secret.length !== 32 || secret.toString("base64url") !== value) throw failure();
        const status = await adapter.store(capability, secret);
        if (status !== "stored") assertStatus(status);
      } finally { secret.fill(0); }
    },
    async delete(capability) {
      const status = await adapter.remove(assertBrokerCapability(capability));
      if (status !== "deleted" && status !== "absent") assertStatus(status);
    },
    async preflight() {
      // Read, then discard, only the active Electron startup credentials.
      // Optional/export capabilities retain their per-operation protection;
      // accountless installation remains main-process-only and on-demand.
      for (const capability of MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES) {
        await backend.get(capability);
      }
    },
  };
  return Object.freeze(backend);
}

function createDesktopMacOSAccountlessCredentialBackendFromAdapter(
  adapter,
  { legacyCredentialProbe } = {},
) {
  if (typeof legacyCredentialProbe !== "function") throw accountlessFailure();
  return Object.freeze({
    async read() {
      await assertLegacyCredentialAbsent(legacyCredentialProbe);
      const result = await adapter.read(
        MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY,
      );
      if (result.status === "absent") return null;
      if (result.status !== "present") return assertAccountlessStatus(result.status);
      try { return Buffer.from(result.value); }
      finally { result.value.fill(0); }
    },
    async createIfMissing(value) {
      await assertLegacyCredentialAbsent(legacyCredentialProbe);
      if (!Buffer.isBuffer(value) || value.length !== 32) throw accountlessFailure();
      const status = await adapter.createIfMissing(
        MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY,
        value,
      );
      if (status !== "created" && status !== "existing") {
        assertAccountlessStatus(status, { knownNonMutation: true });
      }
      return status;
    },
    async deleteExact(value) {
      await assertLegacyCredentialAbsent(legacyCredentialProbe);
      if (!Buffer.isBuffer(value) || value.length !== 32) throw accountlessFailure();
      const status = await adapter.deleteExact(
        MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY,
        value,
      );
      if (!["deleted", "missing", "mismatch"].includes(status)) {
        assertAccountlessStatus(status);
      }
      return status;
    },
  });
}

/** Map the native fixed-capability adapter onto the existing broker port. */
export function createDesktopMacOSCredentialBackend({ binding } = {}) {
  const adapter = createMacOSKeychainAdapterFacade(binding);
  if (adapter.identityStatus() !== "valid") throw failure();
  return createDesktopMacOSCredentialBackendFromAdapter(adapter);
}

/** Main-only accountless credential backend; never exposed through FD4. */
export function createDesktopMacOSAccountlessCredentialBackend({
  binding,
  legacyCredentialProbe,
} = {}) {
  const adapter = createMacOSKeychainAdapterFacade(binding);
  if (adapter.identityStatus() !== "valid") throw accountlessFailure();
  return createDesktopMacOSAccountlessCredentialBackendFromAdapter(adapter, {
    legacyCredentialProbe,
  });
}

function createDesktopMacOSCredentialBackends({ binding } = {}) {
  const adapter = createMacOSKeychainAdapterFacade(binding);
  if (adapter.identityStatus() !== "valid") throw failure("broker_unavailable");
  const broker = createDesktopMacOSCredentialBackendFromAdapter(adapter);
  return Object.freeze({
    broker,
    createAccountlessCredentialBackend(options) {
      return createDesktopMacOSAccountlessCredentialBackendFromAdapter(adapter, options);
    },
  });
}

/**
 * The enclosing Electron app must retain the same durable Developer ID
 * requirement as the native Keychain adapter. `-R=` supplies a requirement
 * expression; bare `-R` instead treats its next argument as a file path.
 */
export function macOSCredentialApplicationVerificationArguments(appBundle) {
  const requirement = `identifier "${PRODUCTION_ELECTRON_APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER}"`;
  return Object.freeze([
    "--verify",
    "--deep",
    "--strict",
    `-R=${requirement}`,
    "--",
    appBundle,
  ]);
}

function verifySignedApplication(appBundle, { spawnProcess = spawn } = {}) {
  return new Promise((resolveResult) => {
    let child;
    let timer;
    let settled = false;
    const finish = (valid) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(valid);
    };
    try {
      child = spawnProcess("/usr/bin/codesign", macOSCredentialApplicationVerificationArguments(appBundle), {
        stdio: "ignore", env: { PATH: "/usr/bin:/bin" },
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Fixed failure below. */ }
        finish(false);
      }, TIMEOUT_MS);
    } catch { finish(false); }
  });
}

function safeBinary(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
    && metadata.size > 0 && metadata.size <= MAX_ADAPTER_BYTES
    && (metadata.mode & 0o022) === 0;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Load the fixed native resource inside the verified production app once. */
export async function loadDesktopMacOSCredentialBackends({
  app,
  resourcesPath,
  platform = process.platform,
  architecture = process.arch,
  verifyApplication = verifySignedApplication,
  requireBinding = (path) => require(path),
  inspectFile = lstat,
  resolveRealPath = realpath,
} = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(architecture)
      || app?.isPackaged !== true || typeof resourcesPath !== "string"
      || !isAbsolute(resourcesPath) || resourcesPath.includes("\0")
      || basename(resourcesPath) !== "Resources" || basename(dirname(resourcesPath)) !== "Contents") {
    throw failure("broker_unavailable");
  }
  const appBundle = dirname(dirname(resourcesPath));
  const binary = join(resourcesPath, ...DESKTOP_MACOS_KEYCHAIN_RESOURCE_PATH);
  try {
    const appPath = app.getAppPath?.();
    if (!appBundle.endsWith(".app") || typeof appPath !== "string"
        || !isAbsolute(appPath) || appPath.includes("\0")
        || resolve(appPath) !== join(resourcesPath, "app.asar")) throw failure("broker_unavailable");
    const before = await inspectFile(binary);
    if (!safeBinary(before) || await resolveRealPath(binary) !== binary
        || await verifyApplication(appBundle) !== true) throw failure("broker_unavailable");
    const verified = await inspectFile(binary);
    if (!safeBinary(verified) || !sameFile(before, verified)) throw failure("broker_unavailable");
    const binding = requireBinding(binary);
    const after = await inspectFile(binary);
    if (!safeBinary(after) || !sameFile(verified, after)) throw failure("broker_unavailable");
    const backends = createDesktopMacOSCredentialBackends({ binding });
    let timer;
    try {
      await Promise.race([
        backends.broker.preflight(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure("broker_timeout")), TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(timer); }
    return backends;
  } catch (error) {
    if (["KEYCHAIN_LOCKED", "KEYCHAIN_DENIED", "KEYCHAIN_MIGRATION_REQUIRED", "broker_timeout"].includes(error?.code)) throw error;
    throw failure("broker_unavailable");
  }
}

/** Backward-compatible broker-only loader for the FD4 handover path. */
export async function loadDesktopMacOSCredentialBackend(options = {}) {
  return (await loadDesktopMacOSCredentialBackends(options)).broker;
}
