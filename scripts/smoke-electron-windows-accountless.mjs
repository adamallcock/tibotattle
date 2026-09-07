#!/usr/bin/env node

// A disposable, synthetic qualification of an already verified Windows package.
// The ordinary development launcher never enables this mutation-only test seam.
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, open, readFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  createWindowsQualificationModeContext,
} from "../src/platform/index.js";
import {
  createDesktopFirstRunReceiptBackend,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  validateDesktopFirstRunReceipt,
} from "../apps/electron/desktop-first-run.js";
import {
  assertWindowsDevelopmentPackageLayout,
  prepareWindowsDevelopmentProfile,
  buildWindowsDevelopmentLaunchSpec,
} from "./launch-electron-windows-development.mjs";
import { verifyElectronDevelopmentArtifact } from "./verify-electron-development-artifact.mjs";

const require = createRequire(import.meta.url);
const TYPE = "windows-electron-smoke-v1";
const PREFIX = "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_";
const SHA = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const COMMANDS = new Set(["status-v1", "accountless-storage-v1", "quit-v1"]);
const SEND_ERROR_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED", "ERR_IPC_DISCONNECTED"]);
const WINDOWS_STAGED_BINDING_PATH = Object.freeze([
  "native",
  "windows-filesystem",
  "build",
  "Release",
  "windows_filesystem.node",
]);
const FIRST_RUN_ACKNOWLEDGEMENT = validateDesktopFirstRunReceipt({
  schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  acknowledged: true,
});
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function fail(code) { throw Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` }); }
function fixedCode(error) { return new RegExp(`^${PREFIX}[A-Z_]+$`, "u").test(error?.code ?? "") ? error.code : `${PREFIX}FAILED`; }

export function parseWindowsAccountlessSmokeArguments(argv) {
  const keys = new Map([
    ["--app", "appPath"], ["--staged-app", "stagedAppPath"],
    ["--package-receipt", "packageReceiptPath"], ["--source-revision", "sourceRevision"],
    ["--receipt", "receiptPath"],
  ]);
  const result = {};
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    const value = argv[index + 1];
    if (!key || Object.hasOwn(result, key) || typeof value !== "string" || !value || value.includes("\0")) fail("ARGUMENT_INVALID");
    if (key === "sourceRevision" ? !REVISION.test(value) : !isAbsolute(value)) fail("ARGUMENT_INVALID");
    result[key] = value;
  }
  if (Object.keys(result).length !== keys.size) fail("ARGUMENT_INVALID");
  return Object.freeze(result);
}

async function regularFile(path, maxBytes = Infinity) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maxBytes) fail("FILE_UNSAFE");
  return metadata;
}

async function digest(path) {
  await regularFile(path);
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    return { bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

export function assertWindowsAccountlessPackageIdentity({ receipt, sourceRevision, executable, asar }) {
  if (!REVISION.test(sourceRevision ?? "") || receipt?.sourceRevision !== sourceRevision
      || receipt?.target !== "win32-x64" || receipt?.status !== "development_package_verified"
      || receipt?.runtimeExecuted !== false) fail("PACKAGE_IDENTITY_INVALID");
  for (const [key, observed] of Object.entries({ executable, asar })) {
    const expected = receipt[key];
    if (!SHA.test(expected?.sha256 ?? "") || !Number.isSafeInteger(expected?.bytes) || expected.bytes <= 0
        || expected.sha256 !== observed?.sha256 || expected.bytes !== observed?.bytes) fail("PACKAGE_IDENTITY_INVALID");
  }
}

export async function verifyWindowsAccountlessSmokePackage(options) {
  await assertWindowsDevelopmentPackageLayout({ appPath: options.appPath, platform: "win32", architecture: "x64" });
  await regularFile(options.packageReceiptPath, 256 * 1024);
  const receipt = JSON.parse(await readFile(options.packageReceiptPath, "utf8"));
  const asarPath = join(dirname(options.appPath), "resources", "app.asar");
  const executable = await digest(options.appPath);
  const asar = await digest(asarPath);
  assertWindowsAccountlessPackageIdentity({ receipt, sourceRevision: options.sourceRevision, executable, asar });
  await verifyElectronDevelopmentArtifact({ target: "win32-x64", appPath: options.stagedAppPath, asarPath, unpackedPath: `${asarPath}.unpacked` });
  return Object.freeze({ sourceRevision: options.sourceRevision, artifactSha256: asar.sha256, executableSha256: executable.sha256 });
}

function sameWindowsPath(left, right) {
  try {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  } catch {
    return false;
  }
}

function pathUnderWindowsRoot(value, root) {
  try {
    const selected = win32.resolve(value);
    const selectedRoot = win32.resolve(root);
    const relative = win32.relative(selectedRoot, selected);
    return relative !== ""
      && !relative.startsWith("..\\")
      && relative !== ".."
      && !win32.isAbsolute(relative);
  } catch {
    return false;
  }
}

function assertDisposableFirstRunProfile(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    fail("FIRST_RUN_PROFILE_INVALID");
  }
  const expected = ["root", "userData", "home", "codex", "claude", "tmp"];
  if (!expected.every((key) => typeof profile[key] === "string"
      && profile[key].length > 0
      && !profile[key].includes("\0")
      && win32.isAbsolute(profile[key]))) {
    fail("FIRST_RUN_PROFILE_INVALID");
  }
  if (!["userData", "home", "codex", "claude", "tmp"].every(
    (key) => pathUnderWindowsRoot(profile[key], profile.root),
  )) {
    fail("FIRST_RUN_PROFILE_INVALID");
  }
  return profile;
}

function firstRunQualificationEnvironment(environment, profile) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    fail("FIRST_RUN_ENVIRONMENT_INVALID");
  }
  // The app keeps companion state separate from Electron user data. The
  // acknowledgement lives below user-data, so construct a second, private
  // qualification context bound to that exact disposable tree before using
  // the protected writer. The launched app still receives its ordinary
  // profile environment and follows the returning-user path unchanged.
  return Object.freeze({
    ...environment,
    // Windows qualification treats TEMP as the root that contains every
    // disposable path. user-data is a sibling of the launched app's tmp
    // directory, so bind this private writer context to the profile root.
    TEMP: profile.root,
    USAGE_MONITOR_STATE_ROOT: profile.userData,
  });
}

function assertFirstRunQualificationContext(context, {
  resourceRoot,
  stateRoot,
} = {}) {
  if (context?.qualificationOnly !== true
      || context?.productionSafe !== false
      || !sameWindowsPath(context.resourceRoot, resourceRoot)
      || !sameWindowsPath(context.stateRoot, stateRoot)) {
    fail("FIRST_RUN_CONTEXT_INVALID");
  }
  return context;
}

async function prepareWindowsAccountlessSmokeFirstRunAcknowledgement({
  profile,
  environment,
  stagedAppPath,
  createAdapter = createWindowsFilesystemAdapter,
  createQualificationContext = createWindowsQualificationModeContext,
  createProtectedStore = createWindowsProtectedStateStore,
  createReceiptBackend = createDesktopFirstRunReceiptBackend,
} = {}) {
  const selectedProfile = assertDisposableFirstRunProfile(profile);
  if (typeof stagedAppPath !== "string" || stagedAppPath.length === 0
      || stagedAppPath.includes("\0") || !win32.isAbsolute(stagedAppPath)) {
    fail("FIRST_RUN_RESOURCE_INVALID");
  }
  if ([createAdapter, createQualificationContext, createProtectedStore, createReceiptBackend]
    .some((value) => typeof value !== "function")) {
    fail("FIRST_RUN_CONFIGURATION_INVALID");
  }
  const resourceRoot = win32.resolve(stagedAppPath);
  // The package verifier has already bound this staged tree to the selected
  // packaged candidate. Load this exact staged binding, never a repository
  // default binary that could be unrelated to the candidate under test.
  const adapter = createAdapter({
    platform: "win32",
    architecture: "x64",
    bindingPath: win32.join(resourceRoot, ...WINDOWS_STAGED_BINDING_PATH),
    resolveBinding: (path) => path,
    requireBinding: (path) => require(path),
    readManifest: (path) => readFileSync(path, "utf8"),
    readBindingBytes: (path) => readFileSync(path),
  });
  if (adapter === null || typeof adapter !== "object"
      || adapter.productionSafe !== false) {
    fail("FIRST_RUN_ADAPTER_INVALID");
  }
  const qualificationContext = assertFirstRunQualificationContext(
    createQualificationContext({
      platform: "win32",
      architecture: "x64",
      adapter,
      environment: firstRunQualificationEnvironment(environment, selectedProfile),
      resourceRoot,
    }),
    { resourceRoot, stateRoot: selectedProfile.userData },
  );
  const settingsRoot = win32.join(selectedProfile.userData, "desktop-settings");
  const store = createProtectedStore({
    adapter,
    rootPath: settingsRoot,
    windowsQualificationModeContext: qualificationContext,
    resourceRoot,
  });
  const backend = createReceiptBackend({
    platform: "win32",
    windowsProtectedStateStore: store,
  });
  if (backend === null || typeof backend !== "object"
      || typeof backend.save !== "function" || typeof backend.load !== "function") {
    fail("FIRST_RUN_BACKEND_INVALID");
  }
  try {
    await backend.save(FIRST_RUN_ACKNOWLEDGEMENT);
    const observed = validateDesktopFirstRunReceipt(await backend.load());
    if (observed.schemaVersion !== FIRST_RUN_ACKNOWLEDGEMENT.schemaVersion
        || observed.acknowledged !== true) {
      fail("FIRST_RUN_RECEIPT_INVALID");
    }
  } catch (error) {
    if (error?.code === `${PREFIX}FIRST_RUN_RECEIPT_INVALID`) throw error;
    fail("FIRST_RUN_RECEIPT_UNAVAILABLE");
  }
  return Object.freeze({ status: "prepared-v1" });
}

/** Dependency-injected seam for the source-only Windows smoke contract. */
export async function prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest(options = {}) {
  return prepareWindowsAccountlessSmokeFirstRunAcknowledgement(options);
}

// Install listeners before sending. No credential bytes or caller-selected
// operation can enter this protocol, even when the packaged app misbehaves.
export function createWindowsAccountlessSmokeProtocol(child, { timeoutMs = 60000, observations = null } = {}) {
  let closed = false;
  let pending = null;
  const finish = (error, value) => {
    const selected = pending;
    if (!selected) return;
    pending = null;
    clearTimeout(selected.timer);
    clearInterval(selected.poll);
    if (error) selected.reject(error); else selected.resolve(value);
  };
  const failure = (code) => Object.assign(new Error(`${PREFIX}${code}`), { code: `${PREFIX}${code}` });
  const onEnd = () => { closed = true; finish(failure("CHILD_EXITED")); };
  const onMessage = (value) => {
    if (!pending || value?.type !== TYPE) return;
    const command = pending.command;
    if (command === "status-v1" && value.message === "state-v1") {
      if (Object.keys(value).length !== 7 || ["started", "primary", "window", "visible", "tray"].some((key) => typeof value[key] !== "boolean")) return finish(failure("RESPONSE_INVALID"));
      if (observations) observations.statusResponseObserved = true;
      return finish(null, value);
    }
    if (command === "accountless-storage-v1" && value.message === "credential-v1") {
      if (Object.keys(value).length !== 4 || value.operation !== command || value.status !== "passed-v1") return finish(failure("STORAGE_FAILED"));
      return finish(null, true);
    }
    if (command === "quit-v1" && value.message === "quit-v1") {
      if (Object.keys(value).length !== 3 || value.status !== "accepted-v1") return finish(failure("RESPONSE_INVALID"));
      return finish(null, true);
    }
  };
  child.on("message", onMessage);
  child.on("error", onEnd);
  child.on("exit", onEnd);
  return Object.freeze({
    request(command) {
      if (!COMMANDS.has(command) || closed || pending) return Promise.reject(failure("COMMAND_REFUSED"));
      return new Promise((resolveRequest, reject) => {
        const request = { command, resolve: resolveRequest, reject, timer: setTimeout(() => finish(failure("TIMEOUT")), timeoutMs), poll: null };
        pending = request;
        const send = () => {
          if (pending !== request) return;
          try {
            child.send({ type: TYPE, message: "command-v1", command }, (error) => {
              if (error && pending === request) {
                if (observations) observations.sendFailureCode = SEND_ERROR_CODES.has(error.code) ? error.code : "unclassified";
                finish(failure("SEND_FAILED"));
              }
            });
          } catch (error) {
            if (pending === request) {
              if (observations) observations.sendFailureCode = SEND_ERROR_CODES.has(error?.code) ? error.code : "unclassified";
              finish(failure("SEND_FAILED"));
            }
          }
        };
        // Startup can precede installation of the app's observation listener.
        // Only the read-only status request is repeatable; never replay storage.
        if (command === "status-v1") request.poll = setInterval(send, 250);
        send();
      });
    },
    close() {
      closed = true;
      finish(failure("CLOSED"));
      child.off("message", onMessage); child.off("error", onEnd); child.off("exit", onEnd);
    },
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((done) => {
    const onExit = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); done(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function exerciseWindowsAccountlessSmoke(child, { timeoutMs = 60000, observations = null } = {}) {
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs, observations });
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = await protocol.request("status-v1");
      if (state.started && state.primary && state.window && state.tray) break;
      if (Date.now() >= deadline) fail("STARTUP_TIMEOUT");
      await delay(250);
    }
    if (observations) observations.storageRequested = true;
    await protocol.request("accountless-storage-v1");
    if (observations) observations.storagePassed = true;
    await protocol.request("quit-v1");
    if (observations) observations.quitAcknowledged = true;
    if (!await waitForChildExit(child, 10000)) fail("QUIT_TIMEOUT");
    if (child.exitCode !== 0) fail("CHILD_FAILED");
  } finally { protocol.close(); }
}

// Keep at most one short line internally and expose one exact known marker.
// Native/Electron stderr can contain private paths; never retain or print it.
export function observeWindowsSmokeStderr(stream, observations) {
  let line = "";
  let discarded = false;
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    for (const character of chunk) {
      if (character === "\n") {
        if (!discarded && line.replace(/\r$/u, "") === "electron_shell_entry_failed") observations.entryFailureObserved = true;
        line = ""; discarded = false;
      } else if (!discarded) {
        if (line.length >= 128) { line = ""; discarded = true; }
        else line += character;
      }
    }
  });
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  // Kill only this runner's still-live process tree, never a process name.
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) return false;
  await new Promise((done) => execFile(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, () => done()));
  return waitForChildExit(child, 5000);
}

export async function runWindowsAccountlessSmoke(options) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("WINDOWS_X64_REQUIRED");
  // Reserve a new receipt before launching; no overwrite of prior evidence.
  const receiptHandle = await open(options.receiptPath, "wx", 0o600);
  let profileRoot = null;
  let child = null;
  let identity = null;
  let errorCode = null;
  let stopped = true;
  const observations = { entryFailureObserved: false, statusResponseObserved: false,
    firstRunAcknowledgementPrepared: false, storageRequested: false,
    storagePassed: false, quitAcknowledged: false, sendFailureCode: null };
  try {
    identity = await verifyWindowsAccountlessSmokePackage(options);
    profileRoot = await mkdtemp(join(tmpdir(), "tibotattle-windows-accountless-smoke-"));
    const profile = await prepareWindowsDevelopmentProfile({ appPath: options.appPath, profilePath: profileRoot });
    const spec = buildWindowsDevelopmentLaunchSpec({ appPath: options.appPath, profile });
    await prepareWindowsAccountlessSmokeFirstRunAcknowledgement({
      profile,
      environment: spec.options.env,
      stagedAppPath: options.stagedAppPath,
    });
    observations.firstRunAcknowledgementPrepared = true;
    child = spawn(spec.command, spec.args, { ...spec.options,
      env: { ...spec.options.env, USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
        USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: randomUUID() },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeWindowsSmokeStderr(child.stderr, observations);
    await exerciseWindowsAccountlessSmoke(child, { observations });
  } catch (error) { errorCode = fixedCode(error); }
  finally {
    stopped = await stopOwnedChild(child);
    if (!stopped) errorCode = `${PREFIX}CLEANUP_UNCONFIRMED`;
    if (profileRoot && stopped) {
      try { await rm(profileRoot, { recursive: true, force: true }); }
      catch { errorCode = `${PREFIX}PROFILE_CLEANUP_FAILED`; }
    }
    const receipt = {
      schemaVersion: "windows-electron-accountless-storage-smoke-v1",
      status: errorCode ? "failed" : "passed", ...identity,
      target: "win32-x64", errorCode,
      packagedApplicationExecuted: child !== null,
      syntheticCredentialOnly: true, realCredentialAccessed: false,
      accountlessStorageAndChildRestartVerified: errorCode === null,
      fullApplicationRestartVerified: false, hostedUploadPerformed: false,
      installationPerformed: false, productionReady: false,
      ownedProcessStopped: stopped,
      observations: { ...observations, exitCode: Number.isInteger(child?.exitCode) ? child.exitCode : null,
        terminatedBySignal: child?.signalCode != null },
    };
    try { await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
  }
  if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze({ status: "passed", ...identity });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runWindowsAccountlessSmoke(parseWindowsAccountlessSmokeArguments(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${fixedCode(error)}\n`); process.exitCode = 1; }
}
