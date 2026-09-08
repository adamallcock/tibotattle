#!/usr/bin/env node

/**
 * Execute the qualification-only Linux Secret Service journey against an
 * already verified Linux Electron distribution. The normal Electron entry is
 * never imported: the packaged executable runs this harness under
 * ELECTRON_RUN_AS_NODE and dynamically loads the fixed app.asar smoke module.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertLinuxDevelopmentPackageLayout,
} from "./launch-electron-linux-development.mjs";
import {
  proveLinuxSecretServiceContainerIsolation,
  startLinuxSecretServiceDaemon,
} from "./qualify-linux-secret-service.mjs";
import {
  cleanupLinuxQualificationProcesses,
  parseLinuxProcStartTime,
} from "./run-linux-secret-service-qualification.mjs";
import {
  verifyElectronDevelopmentArtifact,
} from "./verify-electron-development-artifact.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DBUS_RUN_SESSION = "/usr/bin/dbus-run-session";
const DBUS_RUN_SESSION_EXECUTABLE = "/usr/bin/dbus-run-session";
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_PACKAGE_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const SESSION_DEADLINE_MS = 45_000;
const RECEIPT_SCHEMA = "tibotattle-electron-linux-secret-service-smoke-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const INNER_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "scope",
  "target",
  "execution",
  "sourceRevision",
  "artifactSha256",
  "credentialStoreMode",
  "capabilities",
  "lifecycle",
  "cleanup",
  "productionReady",
]);
const OUTER_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "scope",
  "target",
  "sourceRevision",
  "artifactSha256",
  "packageArtifactVerified",
  "packagedElectronExecutionVerified",
  "credentialLifecycleVerified",
  "sessionCleanupConfirmed",
  "errorCode",
  "productionReady",
]);
const SAFE_SESSION_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);
const QUALIFICATION_EXECUTABLES = new Set([
  "/usr/bin/dbus-daemon",
  "/usr/bin/gnome-keyring-daemon",
]);
const INNER_STAGE_FAILURE_CODES = new Set([
  "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_RUNTIME_IDENTITY_FAILED",
  "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_ARTIFACT_IDENTITY_FAILED",
  "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_ISOLATION_FAILED",
  "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_MODULE_LOAD_FAILED",
  "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_NATIVE_ROUND_TRIP_FAILED",
]);
const NODE_MODULE_LOAD_ERROR_CODES = new Set([
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_REQUIRE_ESM",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
]);
const NODE_NATIVE_LOAD_ERROR_CODES = new Set([
  "ERR_DLOPEN_FAILED",
]);
const PROVEN_SESSION_CLEANUP_ERRORS = new WeakSet();

function failure(code) {
  const error = new Error(`ELECTRON_LINUX_SECRET_SERVICE_SMOKE_${code}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function fixedCode(error) {
  return /^ELECTRON_LINUX_SECRET_SERVICE_SMOKE_[A-Z_]+$/u.test(error?.code ?? "")
    ? error.code
    : "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_FAILED";
}

function throwFixedCode(code, { sessionCleanupConfirmed = false } = {}) {
  const error = new Error(code);
  error.code = code;
  if (sessionCleanupConfirmed) PROVEN_SESSION_CLEANUP_ERRORS.add(error);
  throw error;
}

function failAfterConfirmedSessionCleanup(code) {
  const error = failure(code);
  PROVEN_SESSION_CLEANUP_ERRORS.add(error);
  throw error;
}

function hasProvenSessionCleanup(error) {
  return Boolean(error && typeof error === "object" && PROVEN_SESSION_CLEANUP_ERRORS.has(error));
}

async function innerStage(suffix, action) {
  try {
    return await action();
  } catch {
    fail(suffix);
  }
}

function classifyBootstrapFailure(stderrBytes) {
  if (!Buffer.isBuffer(stderrBytes) || stderrBytes.length === 0) return null;
  const stderr = stderrBytes.toString("utf8");
  if (stderr.includes("\0")) return null;
  const matches = [];
  for (const code of [...NODE_MODULE_LOAD_ERROR_CODES, ...NODE_NATIVE_LOAD_ERROR_CODES]) {
    const pattern = new RegExp(
      `(?:Error \\[${code}\\]:|code: ["']${code}["'])`,
      "gu",
    );
    const count = [...stderr.matchAll(pattern)].length;
    if (count > 0) matches.push({ code, count });
  }
  if (matches.length !== 1 || matches[0].count !== 1) return null;
  return NODE_NATIVE_LOAD_ERROR_CODES.has(matches[0].code)
    ? "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_NATIVE_ROUND_TRIP_FAILED"
    : "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_MODULE_LOAD_FAILED";
}

function classifyInnerFailure(stderrBytes) {
  if (!Buffer.isBuffer(stderrBytes) || stderrBytes.length === 0) return null;
  const stderr = stderrBytes.toString("utf8");
  const stageMarkers = stderr.split("\n").filter((line) => INNER_STAGE_FAILURE_CODES.has(line));
  if (stageMarkers.length === 1) return stageMarkers[0];
  return classifyBootstrapFailure(stderrBytes);
}

function exactObject(value, keys) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length !== keys.length
      || Object.keys(value).some((key) => !keys.includes(key))) {
    return null;
  }
  return value;
}

function absolutePath(value) {
  return typeof value === "string" && value.length > 0
    && !value.includes("\0") && isAbsolute(value) && resolve(value) !== "/";
}

function parseOuterArguments(argv) {
  const names = new Map([
    ["--app", "appPath"],
    ["--staged-app", "stagedAppPath"],
    ["--package-receipt", "packageReceiptPath"],
    ["--source-revision", "sourceRevision"],
    ["--receipt", "receiptPath"],
  ]);
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(result, name) || typeof value !== "string") {
      fail("ARGUMENT_INVALID");
    }
    if (name === "sourceRevision" ? !REVISION.test(value) : !absolutePath(value)) {
      fail("ARGUMENT_INVALID");
    }
    result[name] = name === "sourceRevision" ? value : resolve(value);
  }
  if (Object.keys(result).length !== names.size) fail("ARGUMENT_INVALID");
  return Object.freeze(result);
}

function parseInnerArguments(argv) {
  if (!Array.isArray(argv) || argv[0] !== "--inside-isolated-session") {
    fail("ARGUMENT_INVALID");
  }
  const names = new Map([
    ["--app", "appPath"],
    ["--source-revision", "sourceRevision"],
    ["--artifact-digest", "artifactSha256"],
  ]);
  const result = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(result, name) || typeof value !== "string") {
      fail("ARGUMENT_INVALID");
    }
    if (name === "appPath" ? !absolutePath(value)
      : name === "sourceRevision" ? !REVISION.test(value) : !SHA256.test(value)) {
      fail("ARGUMENT_INVALID");
    }
    result[name] = name === "appPath" ? resolve(value) : value;
  }
  if (Object.keys(result).length !== names.size) fail("ARGUMENT_INVALID");
  return Object.freeze(result);
}

export function parseLinuxPackagedSecretServiceSmokeArguments(argv) {
  if (Array.isArray(argv) && argv[0] === "--inside-isolated-session") {
    return Object.freeze({ mode: "inside", ...parseInnerArguments(argv) });
  }
  return Object.freeze({ mode: "outer", ...parseOuterArguments(argv) });
}

async function safeRegularFile(path, { maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maxBytes
      || (metadata.mode & 0o022) !== 0) {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  return metadata;
}

async function digestRegularFile(path, options = {}) {
  const metadata = await safeRegularFile(path, options);
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    if (bytes !== metadata.size) fail("PACKAGE_IDENTITY_INVALID");
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}

async function readSafeJson(path) {
  await safeRegularFile(path, { maxBytes: MAX_PACKAGE_RECEIPT_BYTES });
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("PACKAGE_IDENTITY_INVALID");
  }
}

function equalDigest(expected, observed) {
  return expected !== null && typeof expected === "object"
    && Object.getPrototypeOf(expected) === Object.prototype
    && Object.keys(expected).length === 2
    && Number.isSafeInteger(expected.bytes)
    && expected.bytes > 0
    && SHA256.test(expected.sha256 ?? "")
    && expected.bytes === observed.bytes
    && expected.sha256 === observed.sha256;
}

export function assertLinuxPackagedSmokeReceiptIdentity({
  receipt,
  sourceRevision,
  executable,
  asar,
}) {
  if (!REVISION.test(sourceRevision ?? "")
      || receipt === null
      || typeof receipt !== "object"
      || Array.isArray(receipt)
      || receipt.sourceRevision !== sourceRevision
      || receipt.status !== "development_package_verified"
      || receipt.target !== "linux-x64"
      || receipt.format !== "distribution"
      || receipt.nativeHost !== true
      || receipt.runtimeExecuted !== false
      || receipt.signed !== false
      || receipt.published !== false
      || receipt.appImageLauncherContractChecked !== true
      || !equalDigest(receipt.executable, executable)
      || !equalDigest(receipt.asar, asar)) {
    fail("PACKAGE_IDENTITY_INVALID");
  }
}

export async function verifyLinuxPackagedSecretServiceSmokePackage(options, {
  platform = process.platform,
  architecture = process.arch,
  assertLayout = assertLinuxDevelopmentPackageLayout,
  verifyArtifact = verifyElectronDevelopmentArtifact,
  digest = digestRegularFile,
  readJson = readSafeJson,
} = {}) {
  if (platform !== "linux" || architecture !== "x64") fail("LINUX_X64_REQUIRED");
  if (!options || typeof options !== "object") fail("ARGUMENT_INVALID");
  const {
    appPath,
    stagedAppPath,
    packageReceiptPath,
    sourceRevision,
  } = options;
  if (![appPath, stagedAppPath, packageReceiptPath].every(absolutePath)
      || !REVISION.test(sourceRevision ?? "")
      || typeof assertLayout !== "function"
      || typeof verifyArtifact !== "function"
      || typeof digest !== "function"
      || typeof readJson !== "function") {
    fail("ARGUMENT_INVALID");
  }
  const layout = await assertLayout({ appPath, platform, architecture });
  if (layout?.target !== "linux-x64" || layout.format !== "unpacked") {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  const resources = join(dirname(appPath), "resources");
  const asarPath = join(resources, "app.asar");
  const unpackedPath = `${asarPath}.unpacked`;
  const [executable, asar, receipt] = await Promise.all([
    digest(appPath),
    digest(asarPath),
    readJson(packageReceiptPath),
  ]);
  assertLinuxPackagedSmokeReceiptIdentity({
    receipt,
    sourceRevision,
    executable,
    asar,
  });
  const verification = await verifyArtifact({
    target: "linux-x64",
    appPath: stagedAppPath,
    asarPath,
    unpackedPath,
  });
  if (verification?.target !== "linux-x64"
      || verification?.nativeFileCount !== 2
      || verification?.binding?.status !== "included_unverified") {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  return Object.freeze({
    target: "linux-x64",
    sourceRevision,
    artifactSha256: asar.sha256,
    executableSha256: executable.sha256,
  });
}

function selectedSessionEnvironment(environment) {
  if (environment?.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED !== "1") {
    fail("ISOLATION_REQUIRED");
  }
  const selected = {};
  for (const key of SAFE_SESSION_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      selected[key] = value;
    }
  }
  selected.ELECTRON_RUN_AS_NODE = "1";
  return selected;
}

function boundedCapture(stream, limit = MAX_RECEIPT_BYTES) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  stream?.on("data", (chunk) => {
    if (overflow) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(bytes);
  });
  return Object.freeze({
    bytes() {
      return overflow ? null : Buffer.concat(chunks, total);
    },
  });
}

async function readLinuxProcessIdentity(pid, allowedExecutables, {
  lstatProcess = stat,
  readExecutable = readlink,
  readProcessStat = readFile,
  uid = process.getuid?.(),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2
      || !(allowedExecutables instanceof Set) || allowedExecutables.size === 0
      || !Number.isSafeInteger(uid) || uid < 0) {
    return null;
  }
  try {
    const root = `/proc/${pid}`;
    if ((await lstatProcess(root)).uid !== uid) return null;
    const executable = await readExecutable(`${root}/exe`);
    if (!allowedExecutables.has(executable)) return null;
    const startTime = parseLinuxProcStartTime(await readProcessStat(`${root}/stat`, "utf8"));
    return startTime === null ? null : Object.freeze({ pid, executable, startTime });
  } catch {
    return null;
  }
}

async function listQualificationProcesses({
  list = readdir,
  readIdentity = readLinuxProcessIdentity,
} = {}) {
  let entries;
  try {
    entries = await list("/proc", { withFileTypes: true });
  } catch {
    fail("PROCESS_PROOF_FAILED");
  }
  const identities = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => readIdentity(Number(entry.name), QUALIFICATION_EXECUTABLES)));
  return identities.filter((identity) => identity !== null);
}

function waitForClose(child) {
  if (child?.exitCode !== null || child?.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return once(child, "close").catch(() => [null, "spawn_error"]);
}

async function stopUnidentifiedChild(child) {
  try { child?.kill?.("SIGKILL"); } catch { /* The fixed cleanup result is authoritative. */ }
  try {
    await Promise.race([
      waitForClose(child),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  } catch {
    // No raw child failure can leave this harness.
  }
}

function expectedInnerReceipt(value, identity) {
  const receipt = exactObject(value, INNER_KEYS);
  if (receipt === null
      || receipt.schemaVersion !== RECEIPT_SCHEMA
      || receipt.status !== "passed"
      || receipt.scope !== "development_only"
      || receipt.target !== "linux-x64"
      || receipt.execution !== "packaged_electron_run_as_node"
      || receipt.sourceRevision !== identity.sourceRevision
      || receipt.artifactSha256 !== identity.artifactSha256
      || receipt.credentialStoreMode !== "isolated-secret-service"
      || receipt.capabilities !== 2
      || receipt.lifecycle !== "two_capability_round_trip_absence_confirmed"
      || receipt.cleanup !== "owned_companion_stopped"
      || receipt.productionReady !== false) {
    return null;
  }
  return Object.freeze({ ...receipt });
}

function defaultSpawnSession(appPath, identity, environment) {
  return spawn(DBUS_RUN_SESSION, [
    "--",
    appPath,
    SCRIPT_FILE,
    "--inside-isolated-session",
    "--app", appPath,
    "--source-revision", identity.sourceRevision,
    "--artifact-digest", identity.artifactSha256,
  ], {
    detached: true,
    env: selectedSessionEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function runLinuxPackagedSecretServiceSession(identity, {
  appPath,
  environment = process.env,
  spawnSession = defaultSpawnSession,
  proveContainerIsolation = proveLinuxSecretServiceContainerIsolation,
  listProcesses = listQualificationProcesses,
  readSessionIdentity = (pid) => readLinuxProcessIdentity(
    pid,
    new Set([DBUS_RUN_SESSION_EXECUTABLE]),
  ),
  cleanup = cleanupLinuxQualificationProcesses,
  deadlineMs = SESSION_DEADLINE_MS,
} = {}) {
  if (!identity || typeof identity !== "object"
      || !absolutePath(appPath)
      || !REVISION.test(identity.sourceRevision ?? "")
      || !SHA256.test(identity.artifactSha256 ?? "")
      || typeof spawnSession !== "function"
      || typeof proveContainerIsolation !== "function"
      || typeof listProcesses !== "function"
      || typeof readSessionIdentity !== "function"
      || typeof cleanup !== "function"
      || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > SESSION_DEADLINE_MS) {
    fail("ARGUMENT_INVALID");
  }
  try {
    if (proveContainerIsolation({ environment })?.status !== "isolated") {
      fail("ISOLATION_REQUIRED");
    }
  } catch (error) {
    if (error?.code === "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_ISOLATION_REQUIRED") {
      throw error;
    }
    fail("ISOLATION_REQUIRED");
  }
  if ((await listProcesses()).length !== 0) fail("ISOLATION_DIRTY");
  let child;
  try {
    child = spawnSession(appPath, identity, environment);
  } catch {
    fail("SESSION_START_FAILED");
  }
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 2) {
    fail("SESSION_START_FAILED");
  }
  // Install the close/error observer before any awaited identity lookup. A
  // fast failed spawn must not become an unhandled EventEmitter error.
  const close = waitForClose(child);
  const stdout = boundedCapture(child.stdout);
  const stderr = boundedCapture(child.stderr);
  const sessionIdentity = await readSessionIdentity(child.pid);
  if (sessionIdentity === null) {
    await stopUnidentifiedChild(child);
    fail("SESSION_IDENTITY_INVALID");
  }
  let timedOut = false;
  let deadline;
  let outcome;
  try {
    outcome = await Promise.race([
      close,
      new Promise((resolveTimeout) => {
        deadline = setTimeout(() => {
          timedOut = true;
          resolveTimeout([null, "deadline"]);
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  let cleanupConfirmed = false;
  try {
    cleanupConfirmed = await cleanup(sessionIdentity, { listProcesses });
  } catch {
    cleanupConfirmed = false;
  }
  if (!cleanupConfirmed) fail("SESSION_CLEANUP_UNCONFIRMED");
  if (timedOut) failAfterConfirmedSessionCleanup("SESSION_DEADLINE_EXCEEDED");
  const [exitCode, signal] = outcome;
  const stdoutBytes = stdout.bytes();
  const stderrBytes = stderr.bytes();
  if (exitCode !== 0 || signal !== null || stdoutBytes === null || stderrBytes === null) {
    if (exitCode !== 0 && signal === null && stdoutBytes !== null && stderrBytes !== null) {
      const innerFailure = classifyInnerFailure(stderrBytes);
      if (innerFailure !== null) throwFixedCode(innerFailure, { sessionCleanupConfirmed: true });
    }
    failAfterConfirmedSessionCleanup("SESSION_EXECUTION_FAILED");
  }
  let parsed;
  try {
    parsed = JSON.parse(stdoutBytes.toString("utf8"));
  } catch {
    failAfterConfirmedSessionCleanup("SESSION_RECEIPT_INVALID");
  }
  const receipt = expectedInnerReceipt(parsed, identity);
  if (receipt === null) failAfterConfirmedSessionCleanup("SESSION_RECEIPT_INVALID");
  if (stderrBytes.byteLength !== 0) failAfterConfirmedSessionCleanup("PASS_RECEIPT_STDERR_REJECTED");
  return receipt;
}

async function reserveReceipt(path) {
  if (!absolutePath(path)) fail("ARGUMENT_INVALID");
  let parent;
  try {
    parent = await lstat(dirname(path));
  } catch {
    fail("RECEIPT_PATH_INVALID");
  }
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || !Number.isSafeInteger(uid) || parent.uid !== uid
      || (parent.mode & 0o077) !== 0) {
    fail("RECEIPT_PATH_INVALID");
  }
  try {
    return await open(path, "wx", 0o600);
  } catch {
    fail("RECEIPT_PATH_INVALID");
  }
}

async function writeReceipt(handle, receipt) {
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function outerReceipt({
  identity,
  executionVerified,
  lifecycleVerified,
  cleanupConfirmed,
  errorCode,
  sourceRevision,
}) {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: errorCode === null ? "passed" : "failed",
    scope: "development_only",
    target: "linux-x64",
    sourceRevision,
    artifactSha256: identity?.artifactSha256 ?? null,
    packageArtifactVerified: identity !== null,
    packagedElectronExecutionVerified: executionVerified,
    credentialLifecycleVerified: lifecycleVerified,
    sessionCleanupConfirmed: cleanupConfirmed,
    errorCode,
    productionReady: false,
  });
}

export async function runLinuxPackagedSecretServiceSmoke(options, {
  verifyPackage = verifyLinuxPackagedSecretServiceSmokePackage,
  runSession = runLinuxPackagedSecretServiceSession,
  reserve = reserveReceipt,
  write = writeReceipt,
  environment = process.env,
} = {}) {
  if (!options || typeof options !== "object" || typeof verifyPackage !== "function"
      || typeof runSession !== "function" || typeof reserve !== "function" || typeof write !== "function") {
    fail("ARGUMENT_INVALID");
  }
  const handle = await reserve(options.receiptPath);
  let identity = null;
  let executionVerified = false;
  let lifecycleVerified = false;
  let cleanupConfirmed = false;
  let errorCode = null;
  try {
    identity = await verifyPackage(options);
    await runSession(identity, { appPath: options.appPath, environment });
    executionVerified = true;
    lifecycleVerified = true;
    cleanupConfirmed = true;
  } catch (error) {
    errorCode = fixedCode(error);
    cleanupConfirmed = hasProvenSessionCleanup(error);
  }
  const receipt = outerReceipt({
    identity,
    executionVerified,
    lifecycleVerified,
    cleanupConfirmed,
    errorCode,
    sourceRevision: options.sourceRevision,
  });
  await write(handle, receipt);
  return receipt;
}

function asarModuleUrl(appPath, modulePath) {
  return pathToFileURL(join(dirname(appPath), "resources", "app.asar", ...modulePath)).href;
}

async function assertPackagedElectronNodeRuntime(appPath, {
  platform = process.platform,
  architecture = process.arch,
  executable = process.execPath,
  environment = process.env,
  electronVersion = process.versions.electron,
  canonicalize = realpath,
} = {}) {
  if (platform !== "linux" || architecture !== "x64"
      || environment?.ELECTRON_RUN_AS_NODE !== "1"
      || typeof electronVersion !== "string" || electronVersion.length === 0) {
    fail("PACKAGED_ELECTRON_REQUIRED");
  }
  try {
    if (await canonicalize(appPath) !== await canonicalize(executable)) {
      fail("PACKAGED_ELECTRON_REQUIRED");
    }
  } catch (error) {
    if (error?.code === "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_PACKAGED_ELECTRON_REQUIRED") {
      throw error;
    }
    fail("PACKAGED_ELECTRON_REQUIRED");
  }
}

export async function runLinuxPackagedSecretServiceSmokeInside(options, {
  platform = process.platform,
  architecture = process.arch,
  executable = process.execPath,
  environment = process.env,
  electronVersion = process.versions.electron,
  canonicalize = realpath,
  digest = digestRegularFile,
  startDaemon = startLinuxSecretServiceDaemon,
  importModule = (url) => import(url),
} = {}) {
  if (!options || typeof options !== "object"
      || !absolutePath(options.appPath)
      || !REVISION.test(options.sourceRevision ?? "")
      || !SHA256.test(options.artifactSha256 ?? "")
      || typeof digest !== "function"
      || typeof startDaemon !== "function"
      || typeof importModule !== "function") {
    fail("ARGUMENT_INVALID");
  }
  await innerStage("RUNTIME_IDENTITY_FAILED", () => assertPackagedElectronNodeRuntime(options.appPath, {
    platform,
    architecture,
    executable,
    environment,
    electronVersion,
    canonicalize,
  }));
  const asarPath = join(dirname(options.appPath), "resources", "app.asar");
  const artifact = await innerStage("ARTIFACT_IDENTITY_FAILED", () => digest(asarPath));
  if (artifact?.sha256 !== options.artifactSha256) fail("ARTIFACT_IDENTITY_FAILED");

  // This is the authoritative isolation proof: it verifies the reviewed
  // container marker and disposable home/runtime tmpfs mounts, then starts a
  // private D-Bus Secret Service before a branded context can exist.
  const daemon = await innerStage("ISOLATION_FAILED", () => startDaemon());
  if (daemon?.status !== "started") fail("ISOLATION_FAILED");

  const [qualification, smoke] = await innerStage("MODULE_LOAD_FAILED", () => Promise.all([
    importModule(asarModuleUrl(options.appPath, [
      "apps", "electron", "linux-qualification.js",
    ])),
    importModule(asarModuleUrl(options.appPath, [
      "apps", "electron", "linux-secret-service-qualification-smoke.js",
    ])),
  ]));
  if (typeof qualification?.createLinuxQualificationContext !== "function"
      || typeof smoke?.runLinuxSecretServiceQualificationSmoke !== "function") {
    fail("MODULE_LOAD_FAILED");
  }
  const outcome = await innerStage("NATIVE_ROUND_TRIP_FAILED", async () => {
    const context = qualification.createLinuxQualificationContext({
      platform: "linux",
      architecture: "x64",
      sourceRevision: options.sourceRevision,
      distribution: "debian-bookworm",
      desktopProtocol: "none",
      credentialStoreMode: "isolated-secret-service",
      subjectKind: "unpacked",
      artifactDigest: options.artifactSha256,
      developmentOnly: true,
    });
    const result = await smoke.runLinuxSecretServiceQualificationSmoke({
      qualificationContext: context,
    });
    if (result?.status !== "passed") fail("NATIVE_ROUND_TRIP_FAILED");
    return result;
  });
  if (outcome?.status !== "passed") fail("NATIVE_ROUND_TRIP_FAILED");
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: "passed",
    scope: "development_only",
    target: "linux-x64",
    execution: "packaged_electron_run_as_node",
    sourceRevision: options.sourceRevision,
    artifactSha256: options.artifactSha256,
    credentialStoreMode: "isolated-secret-service",
    capabilities: 2,
    lifecycle: "two_capability_round_trip_absence_confirmed",
    cleanup: "owned_companion_stopped",
    productionReady: false,
  });
}

async function main() {
  const parsed = parseLinuxPackagedSecretServiceSmokeArguments(process.argv.slice(2));
  if (parsed.mode === "inside") {
    const receipt = await runLinuxPackagedSecretServiceSmokeInside(parsed);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  const receipt = await runLinuxPackagedSecretServiceSmoke(parsed);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status !== "passed") process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${fixedCode(error)}\n`);
    process.exitCode = 1;
  });
}
