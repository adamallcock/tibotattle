import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat as defaultLstat } from "node:fs/promises";
import { homedir as defaultHomeDirectory } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  NATIVE_ELECTRON_APP_ID,
  NATIVE_ELECTRON_HANDOVER_ROUTE,
  SUPPORTED_NATIVE_HANDOVER_VERSIONS,
  inspectNativeElectronHandoverCompletion,
  runNativeElectronHandover,
  validateNativeElectronHandoverCandidate,
} from "./desktop-native-migration.js";

/** The narrow JSON protocol implemented by NativeElectronHandoverHelper.swift. */
export const NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION =
  "tibotattle-native-electron-handover-bridge-v1";
export const NATIVE_ELECTRON_MAC_BRIDGE_MAX_OUTPUT_BYTES = 16 * 1024;
export const NATIVE_ELECTRON_MAC_BRIDGE_TIMEOUT_MS = 15_000;
const PREPARE_FAILURE_STAGES = new Set([
  "identity",
  "native_application",
  "native_writer",
  "login_item_unregister",
  "login_item_status",
  "preferences",
  "invalid_request",
  "unknown",
]);
export const NATIVE_ELECTRON_MAC_BRIDGE_CONTENTS_RELATIVE_PATH = Object.freeze([
  "MacOS",
  "TiboTattleNativeHandover",
]);
export const NATIVE_ELECTRON_NATIVE_STATE_RELATIVE_PATH = Object.freeze([
  "Library",
  "Application Support",
  "Usage Monitor",
]);
export const NATIVE_ELECTRON_GUIDED_HANDOVER_DIRECTORY_NAME = "TiboTattle Native Handover";
export const NATIVE_ELECTRON_GUIDED_NATIVE_APP_RELATIVE_PATH = Object.freeze([
  "native-app",
  "TiboTattle.app",
]);
export const NATIVE_ELECTRON_DEFAULT_NATIVE_APP_PATHS = Object.freeze([
  "/Applications/TiboTattle.app",
]);
const CODESIGN_PATH = "/usr/bin/codesign";
const PLUTIL_PATH = "/usr/bin/plutil";
const INSPECTION_MAX_OUTPUT_BYTES = 64 * 1024;
const INSPECTION_TIMEOUT_MS = 15_000;
const CODE_HASH = /^[a-f0-9]{40,64}$/u;
const NUMERIC_BUILD = /^(?:0|[1-9][0-9]{0,9})(?:\.(?:0|[1-9][0-9]{0,9})){0,7}$/u;

function bridgeFailure(code) {
  const error = new Error("Native handover bridge operation failed");
  error.name = "NativeElectronMacBridgeError";
  error.code = `native_electron_mac_bridge_${code}`;
  return error;
}

function plainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

/** Resolve the sibling MacOS helper, where Foundation recognizes the enclosing app. */
export function nativeElectronHandoverBridgePath(resourcesPath) {
  if (!validPath(resourcesPath) || basename(resourcesPath) !== "Resources"
      || basename(dirname(resourcesPath)) !== "Contents") {
    throw new TypeError("resourcesPath must be the packaged application's Resources directory");
  }
  return join(dirname(resourcesPath), ...NATIVE_ELECTRON_MAC_BRIDGE_CONTENTS_RELATIVE_PATH);
}

/**
 * A main-process-only availability probe. A missing source helper is a normal
 * no-op condition for current native releases and development packages; it is
 * never treated as proof that a bridge exists in an installed artifact.
 */
export async function inspectNativeElectronHandoverBridge({
  resourcesPath,
  lstatPath = defaultLstat,
} = {}) {
  if (typeof lstatPath !== "function") throw new TypeError("lstatPath must be a function");
  const path = nativeElectronHandoverBridgePath(resourcesPath);
  try {
    const metadata = await lstatPath(path);
    const available = metadata?.isFile?.() === true && metadata?.isSymbolicLink?.() !== true;
    return Object.freeze({ available, path });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ available: false, path });
    return Object.freeze({ available: false, path });
  }
}

function validatePreferences(value) {
  if (!exactKeys(value, ["language", "appearance", "refreshIntervalSeconds", "startAtLogin"])) {
    throw bridgeFailure("invalid_reply");
  }
  const language = value.language === "en-US" ? "en" : value.language;
  if (!["system", "en", "zh-Hans", "es"].includes(language)
      || !["system", "light", "dark"].includes(value.appearance)
      || ![60, 300, 900, 1800].includes(value.refreshIntervalSeconds)
      || typeof value.startAtLogin !== "boolean") {
    throw bridgeFailure("invalid_reply");
  }
  return Object.freeze({
    language,
    appearance: value.appearance,
    refreshIntervalSeconds: value.refreshIntervalSeconds,
    startAtLogin: value.startAtLogin,
  });
}

function validatePrepareReply(value) {
  if (exactKeys(value, ["schemaVersion", "status", "failureStage"])
      && value.schemaVersion === NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION
      && value.status === "failed"
      && PREPARE_FAILURE_STAGES.has(value.failureStage)) {
    throw bridgeFailure(`prepare_${value.failureStage}`);
  }
  // The first shipped helper only supplied this two-key failure reply. Keep
  // that response fail-closed and recognizable while newer helpers provide a
  // fixed internal stage without exposing native error text.
  if (exactKeys(value, ["schemaVersion", "status"])
      && value.schemaVersion === NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION
      && value.status === "failed") {
    throw bridgeFailure("failed");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "status",
    "nativeWriterStopped",
    "loginItemDisabled",
    "preferences",
    "credentialState",
  ])
      || value.schemaVersion !== NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION
      || value.status !== "prepared"
      || value.nativeWriterStopped !== true
      || value.loginItemDisabled !== true
      || !["unchanged", "unavailable"].includes(value.credentialState)) {
    throw bridgeFailure("invalid_reply");
  }
  return Object.freeze({
    status: "prepared",
    nativeWriterStopped: true,
    loginItemDisabled: true,
    preferences: validatePreferences(value.preferences),
    credentialState: value.credentialState,
  });
}

function validatePreparationPreflightReply(value) {
  if (exactKeys(value, ["schemaVersion", "status", "failureStage"])
      && value.schemaVersion === NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION
      && value.status === "failed"
      && PREPARE_FAILURE_STAGES.has(value.failureStage)) {
    throw bridgeFailure(`preflight_${value.failureStage}`);
  }
  if (!exactKeys(value, ["schemaVersion", "status"])
      || value.schemaVersion !== NATIVE_ELECTRON_MAC_BRIDGE_SCHEMA_VERSION
      || value.status !== "preflight_ready") {
    throw bridgeFailure("preflight_invalid_reply");
  }
  return Object.freeze({ status: "preflight_ready" });
}

function assertion(value, message) {
  if (!value) throw new TypeError(message);
  return value;
}

function normalizeOptions(options) {
  assertion(plainRecord(options), "options must be an object");
  const allowed = new Set([
    "helperPath", "electronApp", "spawnProcess", "platform", "timeoutMs", "maximumOutputBytes",
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowed.has(key))) {
    throw new TypeError("options has unexpected keys");
  }
  const platform = options.platform ?? process.platform;
  assertion(platform === "darwin", "native handover bridge requires macOS");
  assertion(validPath(options.helperPath), "helperPath must be an absolute path");
  assertion(typeof options.spawnProcess === "function" || options.spawnProcess === undefined,
    "spawnProcess must be a function");
  const timeoutMs = options.timeoutMs ?? NATIVE_ELECTRON_MAC_BRIDGE_TIMEOUT_MS;
  const maximumOutputBytes = options.maximumOutputBytes ?? NATIVE_ELECTRON_MAC_BRIDGE_MAX_OUTPUT_BYTES;
  assertion(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000,
    "timeoutMs is invalid");
  assertion(Number.isSafeInteger(maximumOutputBytes) && maximumOutputBytes >= 256
    && maximumOutputBytes <= 64 * 1024, "maximumOutputBytes is invalid");
  const app = options.electronApp;
  assertion(objectLike(app)
    && typeof app.setLoginItemSettings === "function"
    && typeof app.getLoginItemSettings === "function", "electronApp login-item APIs are required");
  return Object.freeze({
    helperPath: options.helperPath,
    electronApp: app,
    spawnProcess: options.spawnProcess ?? defaultSpawn,
    timeoutMs,
    maximumOutputBytes,
  });
}

function boundedBufferCollector(stream, maximumOutputBytes, onOverflow) {
  let bytes = 0;
  const chunks = [];
  stream.on("data", (chunk) => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    bytes += next.byteLength;
    if (bytes > maximumOutputBytes) {
      onOverflow();
      return;
    }
    chunks.push(next);
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

async function invokeBridge(configuration, argumentsList) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let overflow = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (code) => settle(reject, bridgeFailure(code));
    const terminate = () => {
      try { child?.kill("SIGTERM"); } catch { /* process may have exited */ }
    };
    let timer = null;
    try {
      child = configuration.spawnProcess(configuration.helperPath, argumentsList, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      fail("unavailable");
      return;
    }
    if (!child || typeof child.on !== "function" || !child.stdout || !child.stderr) {
      fail("unavailable");
      return;
    }
    const overflowed = () => {
      overflow = true;
      terminate();
    };
    const output = boundedBufferCollector(child.stdout, configuration.maximumOutputBytes, overflowed);
    // Stderr is intentionally drained but not surfaced: native paths and OS
    // errors must not leak across Electron's user-facing boundary.
    boundedBufferCollector(child.stderr, configuration.maximumOutputBytes, overflowed);
    timer = setTimeout(() => {
      terminate();
      fail("timed_out");
    }, configuration.timeoutMs);
    child.once("error", () => fail("unavailable"));
    child.once("close", (code, signal) => {
      if (overflow) return fail("output_invalid");
      let parsed;
      try {
        const text = output();
        if (text.length < 2 || text.length > configuration.maximumOutputBytes) throw new Error();
        parsed = JSON.parse(text);
      } catch {
        return fail("invalid_reply");
      }
      // A helper's deliberate fixed failed reply is its only non-zero result
      // that may cross this boundary. Signals and every other exit remain
      // transport failures, even when they happened to write JSON first.
      if (code !== 0 || signal !== null) {
        if (code === 1 && signal === null) return settle(resolve, parsed);
        return fail("failed");
      }
      settle(resolve, parsed);
    });
  });
}

function claimedLoginItem(status, startAtLogin) {
  if (!plainRecord(status)) return false;
  if (startAtLogin) {
    return status.openAtLogin === true
      && (status.status === "enabled" || status.executableWillLaunchAtLogin !== false);
  }
  return status.openAtLogin === false
    && status.status !== "enabled" && status.executableWillLaunchAtLogin !== true;
}

/**
 * Construct the real macOS boundary used by a future signed Electron
 * candidate. The helper is intentionally a narrow one-shot command; it does
 * not receive state roots, credentials, arbitrary commands, or renderer data.
 *
 * Existing 0.1.17/0.1.18 native artifacts do not contain this helper. A
 * missing future bundled helper is therefore reported as unavailable rather
 * than being mistaken for support for direct Sparkle replacement.
 */
export function createMacNativeHandoverAdapter(options = {}) {
  const configuration = normalizeOptions(options);
  return Object.freeze({
    async preflightNativeHandover({ nativeAppPath, candidate } = {}) {
      if (!validPath(nativeAppPath)) throw bridgeFailure("invalid_native_app");
      const qualified = validateNativeElectronHandoverCandidate(candidate);
      if (qualified.native.appId !== NATIVE_ELECTRON_APP_ID
          || qualified.electron.appId !== NATIVE_ELECTRON_APP_ID) {
        throw bridgeFailure("identity_mismatch");
      }
      let reply;
      try {
        reply = await invokeBridge(configuration, ["--prepare-preflight", "--native-app", nativeAppPath]);
      } catch (error) {
        if (typeof error?.code === "string" && error.code.startsWith("native_electron_mac_bridge_")) {
          throw error;
        }
        throw bridgeFailure("unavailable");
      }
      return validatePreparationPreflightReply(reply);
    },

    async prepareNativeHandover({ nativeAppPath, candidate } = {}) {
      if (!validPath(nativeAppPath)) throw bridgeFailure("invalid_native_app");
      const qualified = validateNativeElectronHandoverCandidate(candidate);
      if (qualified.native.appId !== NATIVE_ELECTRON_APP_ID
          || qualified.electron.appId !== NATIVE_ELECTRON_APP_ID) {
        throw bridgeFailure("identity_mismatch");
      }
      let reply;
      try {
        reply = await invokeBridge(configuration, ["--prepare", "--native-app", nativeAppPath]);
      } catch (error) {
        if (typeof error?.code === "string" && error.code.startsWith("native_electron_mac_bridge_")) {
          throw error;
        }
        throw bridgeFailure("unavailable");
      }
      return validatePrepareReply(reply);
    },

    async claimElectronLoginItem({ startAtLogin, candidate } = {}) {
      if (typeof startAtLogin !== "boolean") throw bridgeFailure("invalid_login_item_request");
      const qualified = validateNativeElectronHandoverCandidate(candidate);
      if (qualified.electron.appId !== NATIVE_ELECTRON_APP_ID) {
        throw bridgeFailure("identity_mismatch");
      }
      try {
        configuration.electronApp.setLoginItemSettings({ openAtLogin: startAtLogin });
        const status = configuration.electronApp.getLoginItemSettings();
        if (!claimedLoginItem(status, startAtLogin)) throw new Error();
      } catch {
        throw bridgeFailure("login_item_unavailable");
      }
      return "owned";
    },
  });
}

function inspectionFailure(code) {
  const error = new Error("Native handover inspection failed");
  error.name = "NativeElectronMacInspectionError";
  error.code = `native_electron_mac_inspection_${code}`;
  return error;
}

function validBundleBuild(value) {
  return typeof value === "string" && NUMERIC_BUILD.test(value);
}

function compareBuilds(left, right) {
  if (!validBundleBuild(left) || !validBundleBuild(right)) return null;
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  const width = Math.max(a.length, b.length);
  for (let index = 0; index < width; index += 1) {
    const aPart = a[index] ?? 0;
    const bPart = b[index] ?? 0;
    if (aPart < bPart) return -1;
    if (aPart > bPart) return 1;
  }
  return 0;
}

function validHomeDirectory(value) {
  return validPath(value) && value !== "/";
}

/** Native stable state remains fixed independently of Electron's userData path. */
export function nativeElectronLegacyStateRoot(homeDirectory = defaultHomeDirectory()) {
  if (!validHomeDirectory(homeDirectory)) throw new TypeError("homeDirectory must be an absolute directory");
  return join(homeDirectory, ...NATIVE_ELECTRON_NATIVE_STATE_RELATIVE_PATH);
}

/** Private backup root used by the guided install, outside the native state root. */
export function nativeElectronGuidedBackupRoot(homeDirectory = defaultHomeDirectory()) {
  if (!validHomeDirectory(homeDirectory)) throw new TypeError("homeDirectory must be an absolute directory");
  return join(homeDirectory, "Library", "Application Support", NATIVE_ELECTRON_GUIDED_HANDOVER_DIRECTORY_NAME);
}

/** Exact preserved native-bundle location for a guided install; no app is moved here by this function. */
export function nativeElectronGuidedNativeAppBackupPath(backupRoot) {
  if (!validPath(backupRoot)) throw new TypeError("backupRoot must be an absolute path");
  return join(backupRoot, ...NATIVE_ELECTRON_GUIDED_NATIVE_APP_RELATIVE_PATH);
}

/** Derive an outer `.app` root only from a standard macOS app executable path. */
export function macApplicationBundleFromExecutable(executablePath) {
  if (!validPath(executablePath)) throw new TypeError("executablePath must be an absolute path");
  const bundlePath = resolve(dirname(executablePath), "..", "..");
  if (basename(bundlePath) !== "TiboTattle.app") {
    throw new TypeError("executablePath is not the production TiboTattle bundle");
  }
  return bundlePath;
}

function outputCollector(stream, maximumOutputBytes, terminate) {
  let byteLength = 0;
  const chunks = [];
  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    byteLength += bytes.byteLength;
    if (byteLength > maximumOutputBytes) {
      terminate();
      return;
    }
    chunks.push(bytes);
  });
  return () => ({
    overflow: byteLength > maximumOutputBytes,
    text: Buffer.concat(chunks).toString("utf8"),
  });
}

/**
 * Execute only a fixed local inspection command. Output stays inside this
 * module; callers receive parsed facts or a content-free failure code.
 */
async function runLocalInspectionCommand(command, argumentsList, {
  spawnProcess = defaultSpawn,
  timeoutMs = INSPECTION_TIMEOUT_MS,
  maximumOutputBytes = INSPECTION_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    let settled = false;
    let timer = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const terminate = () => {
      try { child?.kill("SIGTERM"); } catch { /* process exited */ }
    };
    try {
      child = spawnProcess(command, argumentsList, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      settle(reject, inspectionFailure("tool_unavailable"));
      return;
    }
    if (!child || typeof child.once !== "function" || !child.stdout || !child.stderr) {
      settle(reject, inspectionFailure("tool_unavailable"));
      return;
    }
    const stdout = outputCollector(child.stdout, maximumOutputBytes, terminate);
    const stderr = outputCollector(child.stderr, maximumOutputBytes, terminate);
    timer = setTimeout(() => {
      terminate();
      settle(reject, inspectionFailure("timed_out"));
    }, timeoutMs);
    child.once("error", () => settle(reject, inspectionFailure("tool_unavailable")));
    child.once("close", (code, signal) => {
      const out = stdout();
      const err = stderr();
      if (out.overflow || err.overflow) {
        settle(reject, inspectionFailure("tool_output_invalid"));
        return;
      }
      settle(resolvePromise, Object.freeze({
        code: Number.isInteger(code) ? code : -1,
        signal: typeof signal === "string" ? signal : null,
        stdout: out.text,
        stderr: err.text,
      }));
    });
  });
}

function requireCommandRunner(value) {
  if (value === undefined) return runLocalInspectionCommand;
  if (typeof value !== "function") throw new TypeError("commandRunner must be a function");
  return value;
}

async function commandResult(commandRunner, command, argumentsList) {
  let result;
  try {
    result = await commandRunner(command, argumentsList);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("native_electron_mac_inspection_")) {
      throw error;
    }
    throw inspectionFailure("tool_unavailable");
  }
  if (!plainRecord(result)
      || !Number.isInteger(result.code)
      || (result.signal !== null && typeof result.signal !== "string")
      || typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || Buffer.byteLength(result.stdout, "utf8") > INSPECTION_MAX_OUTPUT_BYTES
      || Buffer.byteLength(result.stderr, "utf8") > INSPECTION_MAX_OUTPUT_BYTES) {
    throw inspectionFailure("tool_output_invalid");
  }
  return result;
}

async function existingPath(path, lstatPath, kind) {
  try {
    const metadata = await lstatPath(path);
    const valid = kind === "directory"
      ? metadata?.isDirectory?.() === true
      : metadata?.isFile?.() === true;
    return valid && metadata?.isSymbolicLink?.() !== true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw inspectionFailure("path_unavailable");
  }
}

function metadataField(text, name) {
  const match = new RegExp(`^${name}=([^\\r\\n]{1,512})$`, "m").exec(text);
  return match === null ? null : match[1].trim();
}

function designatedRequirement(text) {
  const match = /^designated\s+=>\s+([^\r\n]{1,8192})$/m.exec(text);
  return match === null ? null : match[1].trim();
}

async function signedCodeMetadata({ path, expectedIdentifier = null, commandRunner, lstatPath }) {
  const type = path.endsWith(".app") ? "directory" : "file";
  if (!(await existingPath(path, lstatPath, type))) throw inspectionFailure("code_missing");
  const verified = await commandResult(commandRunner, CODESIGN_PATH, ["--verify", "--deep", "--strict", path]);
  if (verified.code !== 0 || verified.signal !== null) throw inspectionFailure("code_unverified");
  const described = await commandResult(commandRunner, CODESIGN_PATH, ["-d", "-r", "-", "--verbose=4", path]);
  if (described.code !== 0 || described.signal !== null) throw inspectionFailure("code_unverified");
  const details = `${described.stdout}\n${described.stderr}`;
  const identifier = metadataField(details, "Identifier");
  const teamIdentifier = metadataField(details, "TeamIdentifier");
  const codeHash = metadataField(details, "CDHash")?.toLowerCase();
  const requirement = designatedRequirement(details);
  if (identifier === null || teamIdentifier === null || teamIdentifier === "not set"
      || codeHash === null || !CODE_HASH.test(codeHash) || requirement === null
      || (expectedIdentifier !== null && identifier !== expectedIdentifier)) {
    throw inspectionFailure("code_metadata_invalid");
  }
  return Object.freeze({
    identifier,
    teamIdentifier,
    codeHash,
    signingLineage: createHash("sha256").update(requirement, "utf8").digest("hex"),
  });
}

async function plistValue(appPath, key, commandRunner) {
  const infoPath = join(appPath, "Contents", "Info.plist");
  const result = await commandResult(commandRunner, PLUTIL_PATH, ["-extract", key, "raw", "-o", "-", infoPath]);
  const value = result.stdout.trim();
  if (result.code !== 0 || result.signal !== null || !validBundleBuild(value)) {
    throw inspectionFailure("bundle_metadata_invalid");
  }
  return value;
}

async function signedApplicationMetadata({ path, commandRunner, lstatPath }) {
  const code = await signedCodeMetadata({
    path,
    expectedIdentifier: NATIVE_ELECTRON_APP_ID,
    commandRunner,
    lstatPath,
  });
  const [version, build] = await Promise.all([
    plistValue(path, "CFBundleShortVersionString", commandRunner),
    plistValue(path, "CFBundleVersion", commandRunner),
  ]);
  return Object.freeze({ ...code, version, build });
}

function exactNativeApplicationCandidates({ homeDirectory, backupRoot, nativeAppPath, currentElectronAppPath }) {
  const candidates = [];
  if (nativeAppPath !== undefined) {
    if (!validPath(nativeAppPath)) throw new TypeError("nativeAppPath must be an absolute path");
    candidates.push(resolve(nativeAppPath));
  } else {
    candidates.push(nativeElectronGuidedNativeAppBackupPath(backupRoot));
    candidates.push(...NATIVE_ELECTRON_DEFAULT_NATIVE_APP_PATHS);
    candidates.push(join(homeDirectory, "Applications", "TiboTattle.app"));
  }
  return [...new Set(candidates)].filter((path) => path !== currentElectronAppPath);
}

/**
 * Read-only discovery of an eligible native source. It probes only the stable
 * native state root and three exact bundle locations; it never scans an
 * Applications directory or guesses from Electron's profile.
 */
export async function inspectNativeMacHandover({
  homeDirectory = defaultHomeDirectory(),
  backupRoot = nativeElectronGuidedBackupRoot(homeDirectory),
  nativeAppPath,
  electronAppPath,
  helperPath,
  commandRunner,
  lstatPath = defaultLstat,
} = {}) {
  if (!validHomeDirectory(homeDirectory) || !validPath(backupRoot)
      || !validPath(electronAppPath) || !validPath(helperPath)
      || typeof lstatPath !== "function") {
    throw new TypeError("native mac handover inspection is invalid");
  }
  const runner = requireCommandRunner(commandRunner);
  const nativeStateRoot = nativeElectronLegacyStateRoot(homeDirectory);
  if (!(await existingPath(nativeStateRoot, lstatPath, "directory"))) {
    return Object.freeze({ status: "no_legacy_state" });
  }
  const candidates = exactNativeApplicationCandidates({
    homeDirectory,
    backupRoot,
    nativeAppPath,
    currentElectronAppPath: resolve(electronAppPath),
  });
  let selectedNativePath = null;
  for (const candidatePath of candidates) {
    if (await existingPath(candidatePath, lstatPath, "directory")) {
      selectedNativePath = candidatePath;
      break;
    }
  }
  if (selectedNativePath === null) return Object.freeze({ status: "no_supported_predecessor" });

  const [native, electron, helper] = await Promise.all([
    signedApplicationMetadata({ path: selectedNativePath, commandRunner: runner, lstatPath }),
    signedApplicationMetadata({ path: resolve(electronAppPath), commandRunner: runner, lstatPath }),
    signedCodeMetadata({ path: helperPath, commandRunner: runner, lstatPath }),
  ]);
  if (!SUPPORTED_NATIVE_HANDOVER_VERSIONS.includes(native.version)) {
    return Object.freeze({ status: "no_supported_predecessor" });
  }
  if (native.signingLineage !== electron.signingLineage
      || native.teamIdentifier !== electron.teamIdentifier
      || helper.teamIdentifier !== electron.teamIdentifier
      || compareBuilds(electron.build, native.build) !== 1) {
    return Object.freeze({ status: "signature_or_build_mismatch" });
  }
  const candidate = validateNativeElectronHandoverCandidate({
    route: NATIVE_ELECTRON_HANDOVER_ROUTE,
    native: {
      appId: native.identifier,
      version: native.version,
      build: native.build,
      signingLineage: native.signingLineage,
    },
    electron: {
      appId: electron.identifier,
      version: electron.version,
      build: electron.build,
      signingLineage: electron.signingLineage,
    },
    signatureEvidence: {
      nativeCodeHash: native.codeHash,
      electronCodeHash: electron.codeHash,
      helperCodeHash: helper.codeHash,
    },
  });
  // These values stay in the main process and are not part of renderer IPC,
  // diagnostics, a receipt, or a user-visible result.
  return Object.freeze({
    status: "ready",
    nativeStateRoot,
    nativeAppPath: selectedNativePath,
    candidate,
  });
}

function runtimePath(electronApp, name) {
  try {
    const value = electronApp?.getPath?.(name);
    return validPath(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Production composition called before Electron opens companion or settings
 * state. It makes no profile write when a bridge, predecessor, or signed-code
 * evidence is absent. It is deliberately unavailable outside macOS.
 */
export async function runProductionNativeMacHandover({
  electronApp,
  resourcesPath,
  homeDirectory = defaultHomeDirectory(),
  backupRoot = nativeElectronGuidedBackupRoot(homeDirectory),
  nativeAppPath,
  platform = process.platform,
  commandRunner,
  lstatPath = defaultLstat,
} = {}) {
  if (platform !== "darwin") return Object.freeze({ status: "not_applicable" });
  if (!objectLike(electronApp) || !validPath(resourcesPath)
      || !validHomeDirectory(homeDirectory) || !validPath(backupRoot)
      || typeof lstatPath !== "function") {
    return Object.freeze({ status: "unavailable" });
  }
  const executablePath = runtimePath(electronApp, "exe");
  const userDataRoot = runtimePath(electronApp, "userData");
  if (executablePath === null || userDataRoot === null) return Object.freeze({ status: "unavailable" });
  // A completed profile is authoritative for subsequent Electron updates.
  // Check it before bridge, predecessor, or signature probes: the retained
  // native bundle is backup material, not a requirement for every later run.
  const completion = await inspectNativeElectronHandoverCompletion({ userDataRoot });
  if (completion.status === "completed") return Object.freeze({ status: "already_migrated" });
  if (completion.status === "invalid") return Object.freeze({ status: "migration_blocked" });
  const legacyStateRoot = nativeElectronLegacyStateRoot(homeDirectory);
  try {
    if (!(await existingPath(legacyStateRoot, lstatPath, "directory"))) {
      // A fresh Electron profile must continue normally even when the bridge
      // is not bundled; no state root or journal has been written here.
      return Object.freeze({ status: "no_legacy_state" });
    }
  } catch {
    return Object.freeze({ status: "migration_blocked" });
  }
  let electronAppPath;
  try {
    electronAppPath = macApplicationBundleFromExecutable(executablePath);
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
  const bridge = await inspectNativeElectronHandoverBridge({ resourcesPath, lstatPath });
  if (!bridge.available) return Object.freeze({ status: "bridge_unavailable" });
  let inspection;
  try {
    inspection = await inspectNativeMacHandover({
      homeDirectory,
      backupRoot,
      nativeAppPath,
      electronAppPath,
      helperPath: bridge.path,
      commandRunner,
      lstatPath,
    });
  } catch {
    return Object.freeze({ status: "signature_unverified" });
  }
  if (inspection.status !== "ready") return inspection;
  try {
    const result = await runNativeElectronHandover({
      nativeStateRoot: inspection.nativeStateRoot,
      userDataRoot,
      backupRoot,
      nativeAppPath: inspection.nativeAppPath,
      candidate: inspection.candidate,
      control: createMacNativeHandoverAdapter({ helperPath: bridge.path, electronApp }),
    });
    return result;
  } catch {
    return Object.freeze({ status: "migration_blocked" });
  }
}
