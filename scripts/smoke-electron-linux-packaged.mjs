#!/usr/bin/env node

/**
 * Candidate-only normal Linux Electron proof.  The real packaged executable
 * starts normally inside the existing disposable Secret Service container; a
 * tiny private PATH-only Codex app-server fixture gives its ordinary refresh a
 * synthetic provider response.  This never selects a test lane or opens a
 * release/support claim.
 */

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  validateDesktopFirstRunReceipt,
} from "../apps/electron/desktop-first-run.js";
import { validateProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import {
  ELECTRON_LINUX_SMOKE_FAILURE_STAGES,
  assertContainerContract,
  runSmoke,
  validateRendererReadinessDiagnostics,
} from "./smoke-electron-linux.mjs";
import {
  boundedCapture,
  digestRegularFile,
  readSafeJson,
  reserveReceipt,
  writeReceipt,
} from "./smoke-electron-linux-secret-service.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TARGET = "linux-x64";
const RECEIPT_SCHEMA = "tibotattle-electron-linux-normal-packaged-smoke-v1";
const RENDERER_READINESS_DIAGNOSTIC_SCHEMA =
  "tibotattle-electron-linux-normal-packaged-renderer-readiness-diagnostic-v2";
const CLI_FAILURE = "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_FAILED";
const MAX_JSON_BYTES = 1_048_576;
// Two source-smoke journeys each retain their existing 30s startup, two 45s
// refreshes, and 10s clean quit boundaries. The session budget merely covers
// their serial composition and D-Bus startup; it does not relax either phase.
const SESSION_DEADLINE_MS = 300_000;
const SESSION_TERMINATION_MS = 5_000;
const SESSION_KILL_MS = 1_000;
const DBUS_RUN_SESSION = "/usr/bin/dbus-run-session";
const SOURCE_SMOKE_STAGE_CODES = Object.freeze({
  startup: "SOURCE_SMOKE_STARTUP_FAILED",
  target: "SOURCE_SMOKE_TARGET_FAILED",
  renderer_readiness_unobserved: "SOURCE_SMOKE_RENDERER_READINESS_UNOBSERVED_FAILED",
  renderer_readiness_marker_false_title_false_heading_false:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_FALSE_HEADING_FALSE_FAILED",
  renderer_readiness_marker_false_title_false_heading_true:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_FALSE_HEADING_TRUE_FAILED",
  renderer_readiness_marker_false_title_true_heading_false:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_FALSE_FAILED",
  renderer_readiness_marker_false_title_true_heading_true:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED",
  renderer_readiness_marker_true_title_false_heading_false:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_FALSE_HEADING_FALSE_FAILED",
  renderer_readiness_marker_true_title_false_heading_true:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_FALSE_HEADING_TRUE_FAILED",
  renderer_readiness_marker_true_title_true_heading_false:
    "SOURCE_SMOKE_RENDERER_READINESS_MARKER_TRUE_TITLE_TRUE_HEADING_FALSE_FAILED",
  renderer_origin: "SOURCE_SMOKE_RENDERER_ORIGIN_FAILED",
  renderer_health: "SOURCE_SMOKE_RENDERER_HEALTH_FAILED",
  renderer_resource: "SOURCE_SMOKE_RENDERER_RESOURCE_FAILED",
  renderer_navigation: "SOURCE_SMOKE_RENDERER_NAVIGATION_FAILED",
  initial_refresh: "SOURCE_SMOKE_INITIAL_REFRESH_FAILED",
  reload_refresh: "SOURCE_SMOKE_RELOAD_REFRESH_FAILED",
  observation: "SOURCE_SMOKE_OBSERVATION_FAILED",
  renderer_late_network: "SOURCE_SMOKE_RENDERER_LATE_NETWORK_FAILED",
  quit_cleanup: "SOURCE_SMOKE_QUIT_CLEANUP_FAILED",
});
const SOURCE_SMOKE_STAGE_CODE_VALUES = new Set(Object.values(SOURCE_SMOKE_STAGE_CODES));
const SYNTHETIC_CODEX_DIRECTORY = "/opt/tibotattle-linux-packaged-smoke/bin";
const SYNTHETIC_CODEX_BINARY = join(SYNTHETIC_CODEX_DIRECTORY, "codex");
const NATIVE_FILES = Object.freeze([
  "node_modules/@github/keytar/prebuilds/linux-x64/keytar.node",
  "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node",
  "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node.manifest.json",
]);
const CODES = new Set([
  "ARGUMENT_INVALID", "CONTAINER_INVALID", "SOURCE_CANDIDATE_INVALID",
  "PACKAGE_IDENTITY_INVALID", "NATIVE_PAIR_INVALID", "ASAR_UNAVAILABLE",
  "FIXTURE_INVALID", "OBSERVATION_UNAVAILABLE", "UNAVAILABLE_RESPONSE_INVALID",
  "SESSION_START_FAILED", "SESSION_EXECUTION_FAILED", "SESSION_RECEIPT_INVALID",
  "PASS_RECEIPT_STDERR_REJECTED", "SESSION_DEADLINE_EXCEEDED", "SESSION_CLEANUP_UNCONFIRMED",
  ...SOURCE_SMOKE_STAGE_CODE_VALUES,
  "RECEIPT_PATH_INVALID", "UNEXPECTED",
]);

function failure(code) {
  const selected = CODES.has(code) ? code : "UNEXPECTED";
  const error = new Error(`ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_${selected}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function fixedCode(error) {
  const value = String(error?.code ?? "");
  return CODES.has(value.replace("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_", ""))
    ? value
    : "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_UNEXPECTED";
}

/** Map the shared source runner's closed failure stage to this receipt's vocabulary. */
export function normalPackagedSmokeFailureStageCode(stage) {
  return typeof stage === "string" && ELECTRON_LINUX_SMOKE_FAILURE_STAGES.includes(stage)
    ? SOURCE_SMOKE_STAGE_CODES[stage] ?? null
    : null;
}

function absolutePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  try {
    const selected = resolve(value);
    return isAbsolute(value) && selected === value ? selected : null;
  } catch {
    return null;
  }
}

function valueAfter(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail("ARGUMENT_INVALID");
  }
  return value;
}

/** Accept only the outer artifact proof or its private D-Bus-session child. */
export function parseLinuxNormalPackagedSmokeArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const inside = argv[0] === "--inside-isolated-session";
  const fields = inside
    ? new Map([["--app", "appPath"], ["--source-revision", "sourceRevision"], ["--artifact-digest", "artifactSha256"]])
    : new Map([
      ["--app", "appPath"], ["--staged-app", "stagedAppPath"],
      ["--source-candidate", "sourceCandidatePath"], ["--source-revision", "sourceRevision"],
      ["--receipt", "receiptPath"],
    ]);
  const result = { mode: inside ? "inside" : "outer" };
  const seen = new Set();
  for (let index = inside ? 1 : 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!fields.has(flag) || seen.has(flag)) fail("ARGUMENT_INVALID");
    seen.add(flag);
    result[fields.get(flag)] = valueAfter(argv, index);
    index += 1;
  }
  if (seen.size !== fields.size || !absolutePath(result.appPath)
      || !SHA.test(result.sourceRevision ?? "")
      || (inside && !SHA256.test(result.artifactSha256 ?? ""))
      || (!inside && (!absolutePath(result.stagedAppPath)
        || !absolutePath(result.sourceCandidatePath) || !absolutePath(result.receiptPath)))) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze(result);
}

function validateSourceCandidate(value, sourceRevision) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "production_source_staged" || value.target !== TARGET
      || value.sourceRevision !== sourceRevision
      || value.stagingDirectory !== ".release-build/electron-production/linux-x64/app"
      || value.builderConfiguration !== "apps/electron/electron-builder.production.config.cjs"
      || value.updaterEnabled !== true || value.signingRequired !== false
      || value.signingPerformed !== false || value.publishingPerformed !== false) {
    fail("SOURCE_CANDIDATE_INVALID");
  }
  return value;
}

function stableMetadata(value, sourceRevision) {
  let selected;
  try {
    selected = validateProductionDistributionMetadata(value, {
      platform: "linux", architecture: "x64",
    });
  } catch {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  if (selected.target !== TARGET || selected.channel !== "stable"
      || selected.sourceRevision !== sourceRevision) fail("PACKAGE_IDENTITY_INVALID");
  return selected;
}

/** Bind the staged and physical-ASAR production metadata to one exact source. */
export function validateLinuxNormalPackagedSmokeMetadata({
  sourceCandidate,
  stagedManifest,
  archiveManifest,
  sourceRevision,
} = {}) {
  if (!SHA.test(sourceRevision ?? "")) fail("ARGUMENT_INVALID");
  const candidate = validateSourceCandidate(sourceCandidate, sourceRevision);
  const staged = stableMetadata(stagedManifest?.tibotattleDistribution, sourceRevision);
  const archived = stableMetadata(archiveManifest?.tibotattleDistribution, sourceRevision);
  if (JSON.stringify(staged) !== JSON.stringify(archived)
      || stagedManifest?.version !== candidate.version || archiveManifest?.version !== candidate.version) {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  return Object.freeze({ sourceRevision, target: TARGET, distribution: staged });
}

async function readJson(path) {
  try {
    const value = await readSafeJson(path);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PACKAGE_IDENTITY_INVALID");
    return value;
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("PACKAGE_IDENTITY_INVALID");
  }
}

async function digestFile(path) {
  try {
    return await digestRegularFile(path);
  } catch {
    fail("PACKAGE_IDENTITY_INVALID");
  }
}

function loadAsar() {
  try {
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar");
    const selected = asar.default ?? asar;
    if (typeof selected?.extractFile !== "function") fail("ASAR_UNAVAILABLE");
    return selected;
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("ASAR_UNAVAILABLE");
  }
}

export async function readLinuxPackagedAsarManifest(path, { asar = loadAsar() } = {}) {
  let bytes;
  try { bytes = asar.extractFile(path, "package.json"); } catch { fail("PACKAGE_IDENTITY_INVALID"); }
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength > MAX_JSON_BYTES) {
    fail("PACKAGE_IDENTITY_INVALID");
  }
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("PACKAGE_IDENTITY_INVALID");
    return value;
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("PACKAGE_IDENTITY_INVALID");
  }
}

async function validateNativePair({ appPath, stagedAppPath, digest = digestFile, readJsonFile = readJson } = {}) {
  const unpacked = join(dirname(appPath), "resources", "app.asar.unpacked");
  const observed = new Map();
  for (const relativePath of NATIVE_FILES) {
    const [staged, packaged] = await Promise.all([
      digest(join(stagedAppPath, ...relativePath.split("/"))),
      digest(join(unpacked, ...relativePath.split("/"))),
    ]);
    if (staged.bytes !== packaged.bytes || staged.sha256 !== packaged.sha256) fail("NATIVE_PAIR_INVALID");
    observed.set(relativePath, packaged);
  }
  let manifest;
  let validator;
  try {
    manifest = await readJsonFile(join(unpacked, ...NATIVE_FILES[2].split("/")));
    validator = (await import("../src/platform/linux-credential-mutex.js"))
      .validateLinuxCredentialMutexBindingManifest;
  } catch {
    fail("NATIVE_PAIR_INVALID");
  }
  let checked;
  try { checked = validator(manifest); } catch { fail("NATIVE_PAIR_INVALID"); }
  const mutex = observed.get(NATIVE_FILES[1]);
  if (checked?.bytes !== mutex.bytes || checked?.sha256 !== mutex.sha256) fail("NATIVE_PAIR_INVALID");
  return Object.freeze({ keytarSha256: observed.get(NATIVE_FILES[0]).sha256, mutexSha256: mutex.sha256 });
}

/**
 * Verify exactly the source candidate, physical app ASAR, and native pair used
 * by the normal launch. A full generic archive verifier would duplicate the
 * existing development verifier and is intentionally out of this small lane.
 */
export async function verifyLinuxNormalPackagedSmokePackage(options = {}, {
  platform = process.platform,
  architecture = process.arch,
  readJsonFile = readJson,
  digest = digestFile,
  readArchiveManifest = readLinuxPackagedAsarManifest,
  validateNative = validateNativePair,
} = {}) {
  const { appPath, stagedAppPath, sourceCandidatePath, sourceRevision } = options;
  if (platform !== "linux" || architecture !== "x64" || !absolutePath(appPath)
      || !absolutePath(stagedAppPath) || !absolutePath(sourceCandidatePath)
      || !SHA.test(sourceRevision ?? "")) fail("ARGUMENT_INVALID");
  const asarPath = join(dirname(appPath), "resources", "app.asar");
  const [sourceCandidate, stagedManifest, archiveManifest, executable, artifact] = await Promise.all([
    readJsonFile(sourceCandidatePath), readJsonFile(join(stagedAppPath, "package.json")),
    readArchiveManifest(asarPath), digest(appPath), digest(asarPath),
  ]);
  const metadata = validateLinuxNormalPackagedSmokeMetadata({
    sourceCandidate, stagedManifest, archiveManifest, sourceRevision,
  });
  const native = await validateNative({ appPath, stagedAppPath });
  return Object.freeze({
    artifactSha256: artifact.sha256,
    executableSha256: executable.sha256,
    native,
    sourceRevision: metadata.sourceRevision,
    target: metadata.target,
  });
}

export async function assertSyntheticCodexFixture({ metadata = lstat } = {}) {
  let details;
  try {
    details = await metadata(SYNTHETIC_CODEX_BINARY);
  } catch {
    fail("CONTAINER_INVALID");
  }
  if (!details?.isFile?.() || details.isSymbolicLink?.() || details.uid !== 0
      || (details.mode & 0o022) !== 0 || (details.mode & 0o111) === 0) {
    fail("CONTAINER_INVALID");
  }
  return SYNTHETIC_CODEX_DIRECTORY;
}

/** Create only raw synthetic source; the app-server fixture is image-owned. */
export async function createLinuxNormalPackagedSmokeFixture({ runtimeDirectory = process.env.XDG_RUNTIME_DIR } = {}) {
  const runtime = absolutePath(runtimeDirectory);
  if (runtime === null) fail("FIXTURE_INVALID");
  const root = await mkdtemp(join(runtime, "tibotattle-linux-normal-packaged-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeHome = join(root, "claude-home");
  const userData = join(root, "user-data");
  const settingsRoot = join(userData, "desktop-settings");
  try {
    const directories = [home, codexHome, claudeHome, userData, settingsRoot, join(codexHome, "sessions")];
    await Promise.all(directories.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    await Promise.all(directories.map((path) => chmod(path, 0o700)));
    await writeFile(join(codexHome, "sessions", "synthetic-linux-smoke.jsonl"),
      `${JSON.stringify({ type: "session_meta", id: "synthetic-linux-smoke" })}\n`, { mode: 0o600, flag: "wx" });
    const firstRunReceipt = validateDesktopFirstRunReceipt({
      schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION, acknowledged: true,
    });
    await writeFile(join(settingsRoot, DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME), `${JSON.stringify(firstRunReceipt)}\n`, {
      mode: 0o600, flag: "wx",
    });
    return Object.freeze({
      claudeHome, codexHome, home, root, userData,
      stateFile: join(userData, "companion-state", "local-collector-state-v1.sqlite"),
      unavailableBusAddress: `unix:path=${join(root, "absent-session-bus")}`,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("FIXTURE_INVALID");
  }
}

const BLOCKED_ENVIRONMENT = Object.freeze([
  "CODEX_BIN", "ELECTRON_RUN_AS_NODE", "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE",
  "USAGE_MONITOR_ACCOUNTLESS_MODE", "USAGE_MONITOR_ACCOUNTLESS_ORIGIN",
  "USAGE_MONITOR_CENTRAL_ORIGIN", "USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE",
  "USAGE_MONITOR_RESOURCE_ROOT", "USAGE_MONITOR_STATE_ROOT", "USAGE_MONITOR_TEST_LANE",
  "USAGE_MONITOR_KEYCHAIN_BROKER_FD", "USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD",
  "USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BROKER_IPC",
  "XDG_STATE_HOME",
]);

/** Bind the desktop's fresh default Codex root to the disposable raw fixture. */
export function normalPackagedSmokeEnvironment({ environment = process.env, fixture, service } = {}) {
  if (!fixture || typeof fixture !== "object" || !["available", "unavailable"].includes(service)) {
    fail("FIXTURE_INVALID");
  }
  const home = absolutePath(fixture.home);
  const codexHome = absolutePath(fixture.codexHome);
  if (home === null || codexHome !== join(home, ".codex")) fail("FIXTURE_INVALID");
  const selected = { ...environment };
  for (const key of BLOCKED_ENVIRONMENT) delete selected[key];
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
    if (typeof selected[key] !== "string" || (key !== "PATH" && absolutePath(selected[key]) === null)) {
      fail("CONTAINER_INVALID");
    }
  }
  selected.PATH = `${SYNTHETIC_CODEX_DIRECTORY}:${selected.PATH}`;
  selected.HOME = home;
  selected.CODEX_HOME = codexHome;
  selected.CLAUDE_CONFIG_DIR = fixture.claudeHome;
  selected.CLAUDE_PROJECT_DIR = fixture.root;
  selected.CLAUDE_PROJECT_DIRECTORY = fixture.root;
  selected.USAGE_MONITOR_PORT = "0";
  selected.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL = "quit-v1";
  if (service === "unavailable") selected.DBUS_SESSION_BUS_ADDRESS = fixture.unavailableBusAddress;
  return Object.freeze(selected);
}

/** Inspect the durable marker without returning its keyed account identifier. */
export function classifyLinuxNormalPackagedObservation(checkpoint, expected) {
  const scope = checkpoint?.accountScopeMarker?.accountScope ?? null;
  if (expected === "available") {
    return scope?.status === "available" && scope?.version === "openai-account-v1"
      && /^openai-account:v1:[A-Za-z0-9_-]{43}$/u.test(scope.scopeId ?? "") ? "available" : "invalid";
  }
  return expected === "unavailable" && (scope === null || (scope?.status === "unavailable" && scope?.scopeId === null))
    ? "unavailable" : "invalid";
}

async function readCheckpoint(path) {
  const module = await import("../src/local-collector-state.js");
  return module.readLocalCollectorCheckpoint({ stateFile: path });
}

async function runOneNormalApp(identity, { appPath, environment, service, readState = readCheckpoint } = {}) {
  let observed = "invalid";
  let observationFailure = null;
  let smokeFailureStage = null;
  let rendererReadinessDiagnostics = null;
  let result;
  try {
    result = await runSmoke({
      binary: appPath,
      fixtureFactory: createLinuxNormalPackagedSmokeFixture,
      launchArguments: ({ fixture, port }) => [
        `--user-data-dir=${fixture.userData}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "--disable-gpu",
      ],
      environmentFactory: ({ fixture }) => normalPackagedSmokeEnvironment({ environment, fixture, service }),
      onFailureStage: (stage) => { smokeFailureStage = stage; },
      onRendererReadinessDiagnostics: (diagnostic) => {
        rendererReadinessDiagnostics = validateRendererReadinessDiagnostics(diagnostic);
      },
      sourceRevision: identity.sourceRevision,
      qualification: "candidate-only",
      afterRefresh: async ({ fixture }) => {
        observed = classifyLinuxNormalPackagedObservation(await readState(fixture.stateFile), service);
        if (observed !== service) {
          observationFailure = service === "available"
            ? "OBSERVATION_UNAVAILABLE"
            : "UNAVAILABLE_RESPONSE_INVALID";
          fail(observationFailure);
        }
      },
      writeResult: async () => {},
    });
  } catch (error) {
    if (observationFailure !== null) fail(observationFailure);
    const stageCode = normalPackagedSmokeFailureStageCode(smokeFailureStage);
    if (stageCode !== null) {
      const classified = validateRendererReadinessDiagnostics(rendererReadinessDiagnostics);
      const fixed = failure(stageCode);
      if (classified !== null) fixed.rendererReadinessDiagnostics = classified;
      throw fixed;
    }
    throw error;
  }
  if (result?.status !== "passed") fail("UNEXPECTED");
  return observed;
}

function sessionEnvironment(environment) {
  const selected = { ...environment };
  for (const key of BLOCKED_ENVIRONMENT) delete selected[key];
  delete selected.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL;
  return selected;
}

export async function runLinuxNormalPackagedSmokeInside(options, {
  environment = process.env,
  startDaemon = async () => (await import("./qualify-linux-secret-service.mjs"))
    .startLinuxSecretServiceDaemon({ environment }),
  proveIsolation = async () => (await import("./qualify-linux-secret-service.mjs"))
    .proveLinuxSecretServiceContainerIsolation({ environment }),
  assertCodexFixture = assertSyntheticCodexFixture,
  runApp = runOneNormalApp,
} = {}) {
  if (!options || !absolutePath(options.appPath) || !SHA.test(options.sourceRevision ?? "")
      || !SHA256.test(options.artifactSha256 ?? "") || typeof assertCodexFixture !== "function"
      || typeof runApp !== "function") fail("ARGUMENT_INVALID");
  let contract;
  try {
    contract = assertContainerContract();
    if (environment.XDG_STATE_HOME !== undefined || (await proveIsolation())?.status !== "isolated") {
      fail("CONTAINER_INVALID");
    }
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("CONTAINER_INVALID");
  }
  if (contract.sourceRevision !== options.sourceRevision) fail("CONTAINER_INVALID");
  try {
    await assertCodexFixture();
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("CONTAINER_INVALID");
  }
  try {
    if ((await startDaemon())?.status !== "started") fail("CONTAINER_INVALID");
  } catch (error) {
    if (String(error?.code ?? "").startsWith("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_")) throw error;
    fail("CONTAINER_INVALID");
  }
  const identity = Object.freeze({ sourceRevision: options.sourceRevision, artifactSha256: options.artifactSha256 });
  if (await runApp(identity, { appPath: options.appPath, environment, service: "available" }) !== "available") {
    fail("OBSERVATION_UNAVAILABLE");
  }
  if (await runApp(identity, { appPath: options.appPath, environment, service: "unavailable" }) !== "unavailable") {
    fail("UNAVAILABLE_RESPONSE_INVALID");
  }
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA, status: "passed", scope: "candidate_only", target: TARGET,
    execution: "packaged_electron_normal", sourceRevision: options.sourceRevision,
    artifactSha256: options.artifactSha256, availableServiceRefresh: "completed",
    accountObservationLifecycle: "available", unavailableServiceResponse: "bounded",
    cleanup: "owned_apps_stopped", productionReady: false,
  });
}

function waitForChild(child, timeoutMs) {
  if (!child || typeof child !== "object") return Promise.resolve([null, "spawn_error"]);
  const exited = () => child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
  if (exited()) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolveWait) => {
    let timer = null;
    let settled = false;
    const onExit = (code, signal) => finish([code, signal]);
    const onError = () => finish([null, "spawn_error"]);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("error", onError);
      resolveWait(value);
    };
    child.once?.("exit", onExit);
    child.once?.("error", onError);
    if (exited()) {
      finish([child.exitCode, child.signalCode]);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function stopOwnedSession(child, {
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  waitForExit = waitForChild,
} = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 2
      || typeof killProcessGroup !== "function" || typeof waitForExit !== "function") return false;
  const exited = () => child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
  if (exited()) return true;
  try {
    killProcessGroup(child.pid, "SIGTERM");
  } catch {
    return false;
  }
  await waitForExit(child, SESSION_TERMINATION_MS);
  if (exited()) return true;
  try {
    killProcessGroup(child.pid, "SIGKILL");
  } catch {
    return false;
  }
  await waitForExit(child, SESSION_KILL_MS);
  return exited();
}

function defaultSpawnSession(appPath, identity, environment) {
  return spawn(DBUS_RUN_SESSION, [
    "--", process.execPath, SCRIPT_FILE, "--inside-isolated-session",
    "--app", appPath, "--source-revision", identity.sourceRevision,
    "--artifact-digest", identity.artifactSha256,
  ], {
    detached: true,
    env: sessionEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function expectedInsideReceipt(value, identity) {
  const expected = {
    schemaVersion: RECEIPT_SCHEMA, status: "passed", scope: "candidate_only", target: TARGET,
    execution: "packaged_electron_normal", sourceRevision: identity.sourceRevision,
    artifactSha256: identity.artifactSha256, availableServiceRefresh: "completed",
    accountObservationLifecycle: "available", unavailableServiceResponse: "bounded",
    cleanup: "owned_apps_stopped", productionReady: false,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) return null;
  return Object.freeze(expected);
}

function diagnosticEnvelope(value) {
  const diagnostic = validateRendererReadinessDiagnostics(value);
  return diagnostic === null ? null : Object.freeze({
    schemaVersion: RENDERER_READINESS_DIAGNOSTIC_SCHEMA,
    rendererReadinessDiagnostics: diagnostic,
  });
}

function classifiedInnerFailure(stderr) {
  if (!Buffer.isBuffer(stderr) || stderr.byteLength === 0) return null;
  const lines = stderr.toString("utf8").split("\n");
  const matches = lines
    .filter((line) => /^ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_[A-Z_]+$/u.test(line))
    .filter((line) => CODES.has(line.replace("ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_", "")));
  if (matches.length !== 1) return null;
  const diagnostics = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).map((value) => (
    value?.schemaVersion === RENDERER_READINESS_DIAGNOSTIC_SCHEMA
      ? validateRendererReadinessDiagnostics(value.rendererReadinessDiagnostics)
      : null
  )).filter((value) => value !== null);
  return Object.freeze({
    code: matches[0],
    rendererReadinessDiagnostics: diagnostics.length === 1 ? diagnostics[0] : null,
  });
}

export async function runLinuxNormalPackagedSmokeSession(identity, {
  appPath,
  environment = process.env,
  spawnSession = defaultSpawnSession,
  stopSession = stopOwnedSession,
  deadlineMs = SESSION_DEADLINE_MS,
} = {}) {
  if (!identity || !absolutePath(appPath) || !SHA.test(identity.sourceRevision ?? "")
      || !SHA256.test(identity.artifactSha256 ?? "") || typeof spawnSession !== "function"
      || typeof stopSession !== "function" || !Number.isSafeInteger(deadlineMs)
      || deadlineMs < 1 || deadlineMs > SESSION_DEADLINE_MS) {
    fail("ARGUMENT_INVALID");
  }
  let child;
  try { child = spawnSession(appPath, identity, environment); } catch { fail("SESSION_START_FAILED"); }
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 2) fail("SESSION_START_FAILED");
  const stdout = boundedCapture(child.stdout);
  const stderr = boundedCapture(child.stderr);
  const result = await waitForChild(child, deadlineMs);
  if (result === null) {
    if (!(await stopSession(child))) fail("SESSION_CLEANUP_UNCONFIRMED");
    fail("SESSION_DEADLINE_EXCEEDED");
  }
  const output = stdout.bytes();
  const errors = stderr.bytes();
  if (result[0] !== 0 || result[1] !== null || output === null || errors === null) {
    const innerFailure = classifiedInnerFailure(errors);
    if (result[0] !== 0 && result[1] === null && innerFailure !== null) {
      const error = new Error(innerFailure.code);
      error.code = innerFailure.code;
      if (innerFailure.rendererReadinessDiagnostics !== null) {
        error.rendererReadinessDiagnostics = innerFailure.rendererReadinessDiagnostics;
      }
      throw error;
    }
    fail("SESSION_EXECUTION_FAILED");
  }
  let parsed;
  try { parsed = JSON.parse(output.toString("utf8")); } catch { fail("SESSION_RECEIPT_INVALID"); }
  const receipt = expectedInsideReceipt(parsed, identity);
  if (receipt === null) fail("SESSION_RECEIPT_INVALID");
  if (errors.byteLength !== 0) fail("PASS_RECEIPT_STDERR_REJECTED");
  return receipt;
}

async function reserveLinuxNormalPackagedReceipt(path) {
  if (!absolutePath(path)) fail("RECEIPT_PATH_INVALID");
  try {
    return await reserveReceipt(path);
  } catch {
    fail("RECEIPT_PATH_INVALID");
  }
}

async function writeLinuxNormalPackagedReceipt(handle, receipt) {
  try {
    await writeReceipt(handle, receipt);
  } catch {
    fail("RECEIPT_PATH_INVALID");
  }
}

function outerReceipt({
  sourceRevision,
  identity = null,
  inner = null,
  errorCode = null,
  rendererReadinessDiagnostics = null,
}) {
  const diagnostic = validateRendererReadinessDiagnostics(rendererReadinessDiagnostics);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA, status: errorCode === null ? "passed" : "failed",
    scope: "candidate_only", target: TARGET, sourceRevision,
    artifactSha256: identity?.artifactSha256 ?? null, executableSha256: identity?.executableSha256 ?? null,
    packageArtifactVerified: identity !== null, packagedElectronExecutionVerified: inner !== null,
    accountObservationLifecycleVerified: inner?.accountObservationLifecycle === "available",
    unavailableServiceResponseVerified: inner?.unavailableServiceResponse === "bounded",
    sessionCleanupConfirmed: inner?.cleanup === "owned_apps_stopped", errorCode, productionReady: false,
  };
  if (diagnostic !== null) receipt.rendererReadinessDiagnostics = diagnostic;
  return Object.freeze(receipt);
}

export async function runLinuxNormalPackagedSmoke(options, {
  verifyPackage = verifyLinuxNormalPackagedSmokePackage,
  runSession = runLinuxNormalPackagedSmokeSession,
  environment = process.env,
  reserve = reserveLinuxNormalPackagedReceipt,
  write = writeLinuxNormalPackagedReceipt,
} = {}) {
  if (!options || typeof verifyPackage !== "function" || typeof runSession !== "function"
      || typeof reserve !== "function" || typeof write !== "function") fail("ARGUMENT_INVALID");
  const handle = await reserve(options.receiptPath);
  let identity = null;
  let inner = null;
  let errorCode = null;
  let rendererReadinessDiagnostics = null;
  try {
    identity = await verifyPackage(options);
    inner = await runSession(identity, { appPath: options.appPath, environment });
  } catch (error) {
    errorCode = fixedCode(error);
    rendererReadinessDiagnostics = validateRendererReadinessDiagnostics(
      error?.rendererReadinessDiagnostics,
    );
  }
  const receipt = outerReceipt({
    sourceRevision: options.sourceRevision,
    identity,
    inner,
    errorCode,
    rendererReadinessDiagnostics,
  });
  await write(handle, receipt);
  return receipt;
}

async function main() {
  const options = parseLinuxNormalPackagedSmokeArguments(process.argv.slice(2));
  if (options.mode === "inside") {
    process.stdout.write(`${JSON.stringify(await runLinuxNormalPackagedSmokeInside(options))}\n`);
    return;
  }
  const receipt = await runLinuxNormalPackagedSmoke(options);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status !== "passed") process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  main().catch((error) => {
    const code = fixedCode(error) === "ELECTRON_LINUX_NORMAL_PACKAGED_SMOKE_UNEXPECTED"
      ? CLI_FAILURE
      : fixedCode(error);
    process.stderr.write(`${code}\n`);
    const diagnostic = diagnosticEnvelope(error?.rendererReadinessDiagnostics);
    if (diagnostic !== null) process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 1;
  });
}
