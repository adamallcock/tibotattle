import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createMacOSKeychainAdapterFacade, MACOS_KEYCHAIN_ADAPTER_CAPABILITIES } from "../../native/macos-keychain/contract.js";
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

/** Map the native fixed-capability adapter onto the existing broker port. */
export function createDesktopMacOSCredentialBackend({ binding } = {}) {
  const adapter = createMacOSKeychainAdapterFacade(binding);
  if (adapter.identityStatus() !== "valid") throw failure();
  const backend = {
    async get(capability) {
      const result = await adapter.read(capability);
      if (result.status === "absent") return null;
      if (result.status !== "present") return assertStatus(result.status);
      try { return result.value.toString("base64url"); }
      finally { result.value.fill(0); }
    },
    async set(capability, value) {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw failure();
      const secret = Buffer.from(value, "base64url");
      try {
        if (secret.length !== 32 || secret.toString("base64url") !== value) throw failure();
        const status = await adapter.store(capability, secret);
        if (status !== "stored") assertStatus(status);
      } finally { secret.fill(0); }
    },
    async delete(capability) {
      const status = await adapter.remove(capability);
      if (status !== "deleted" && status !== "absent") assertStatus(status);
    },
    async preflight() {
      // Read, then discard, every fixed capability before stopping the old app
      // or copying its state. An absent modern item must have passed the native
      // legacy-attribute check; denied/unknown/legacy-only is never fresh.
      for (const capability of MACOS_KEYCHAIN_ADAPTER_CAPABILITIES) await backend.get(capability);
    },
  };
  return Object.freeze(backend);
}

function verifySignedApplication(appBundle, { spawnProcess = spawn } = {}) {
  const requirement = `identifier "${PRODUCTION_ELECTRON_APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER}"`;
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
      child = spawnProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, appBundle], {
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

/** Load only the fixed native resource inside the verified production app. */
export async function loadDesktopMacOSCredentialBackend({
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
    throw failure();
  }
  const appBundle = dirname(dirname(resourcesPath));
  const binary = join(resourcesPath, ...DESKTOP_MACOS_KEYCHAIN_RESOURCE_PATH);
  try {
    const appPath = app.getAppPath?.();
    if (!appBundle.endsWith(".app") || typeof appPath !== "string"
        || !isAbsolute(appPath) || appPath.includes("\0")
        || resolve(appPath) !== join(resourcesPath, "app.asar")) throw failure();
    const before = await inspectFile(binary);
    if (!safeBinary(before) || await resolveRealPath(binary) !== binary
        || await verifyApplication(appBundle) !== true) throw failure();
    const verified = await inspectFile(binary);
    if (!safeBinary(verified) || !sameFile(before, verified)) throw failure();
    const binding = requireBinding(binary);
    const after = await inspectFile(binary);
    if (!safeBinary(after) || !sameFile(verified, after)) throw failure();
    const backend = createDesktopMacOSCredentialBackend({ binding });
    let timer;
    try {
      await Promise.race([
        backend.preflight(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure("broker_timeout")), TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(timer); }
    return backend;
  } catch (error) {
    if (["KEYCHAIN_LOCKED", "KEYCHAIN_DENIED", "KEYCHAIN_MIGRATION_REQUIRED", "broker_timeout"].includes(error?.code)) throw error;
    throw failure("broker_unavailable");
  }
}
