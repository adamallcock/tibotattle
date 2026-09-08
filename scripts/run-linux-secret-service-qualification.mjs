#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  readFile,
  readdir,
  readlink,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  proveLinuxSecretServiceContainerIsolation,
  startLinuxSecretServiceDaemon,
} from "./qualify-linux-secret-service.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DBUS_RUN_SESSION = "/usr/bin/dbus-run-session";
const QUALIFICATION_HELPER = resolve(
  REPOSITORY_ROOT,
  "scripts/qualify-linux-secret-service.mjs",
);
const MAX_OUTPUT_BYTES = 16_384;
const CHILD_DEADLINE_MS = 40_000;
const CLEANUP_DEADLINE_MS = 5_000;
const KILL_CLEANUP_DEADLINE_MS = 1_000;
const KNOWN_QUALIFICATION_EXECUTABLES = new Set([
  "/usr/bin/dbus-daemon",
  "/usr/bin/gnome-keyring-daemon",
]);
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
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
const EXPECTED_RECEIPT = Object.freeze({
  schemaVersion: "linux-credential-qualification-v1",
  status: "passed",
  scope: "development_only",
  platform: "linux",
  architecture: "x64",
  subject: "pinned_native_binding",
  capabilities: 4,
  lifecycle: "round_trip_absence_confirmed",
  cleanup: "confirmed",
  leaseCrossProcessSafe: false,
  crashRecoveryComplete: false,
});

const OBSERVATION_RECEIPT = Object.freeze({
  schemaVersion: "linux-account-observation-qualification-v1",
  status: "passed",
  scope: "development_only",
  platform: "linux",
  architecture: "x64",
  subject: "pinned_native_binding",
  capability: "account_observation",
  lifecycle: "read_create_no_replace_and_digest_reconciliation",
  credentialCleanup: "disposable_container_lifetime",
  productionSafe: false,
});
const OBSERVATION_NATIVE_PHASES = Object.freeze([
  "INITIAL_READ", "ABSENT_INTENT", "CREATE", "READBACK", "NO_REPLACE",
  "MATCHING_INTENT", "INTERRUPTED_REMOVAL", "MISMATCHED_INTENT", "SERVICE_DEADLINE",
  "SERVICE_DEADLINE_NATIVE_WATCHDOG", "SERVICE_DEADLINE_NATIVE_LEASE",
  "SERVICE_DEADLINE_NATIVE_READ", "SERVICE_DEADLINE_NATIVE_DEADLINE",
  "SERVICE_DEADLINE_NATIVE_OTHER",
  "CREATE_PRECHECK", "CREATE_PRECHECK_UNAVAILABLE", "CREATE_PRECHECK_RECOVERY_REQUIRED",
  "CREATE_PRECHECK_OTHER", "CREATE_MUTATION", "CREATE_MUTATION_UNAVAILABLE",
  "CREATE_MUTATION_RECOVERY_REQUIRED", "CREATE_MUTATION_OTHER",
  "CREATE_NATIVE_READ", "CREATE_NATIVE_READ_UNAVAILABLE", "CREATE_NATIVE_READ_RECOVERY_REQUIRED",
  "CREATE_NATIVE_READ_OTHER", "CREATE_COLLECTION", "CREATE_COLLECTION_READY",
  "CREATE_COLLECTION_MISSING", "CREATE_COLLECTION_LOCKED", "CREATE_COLLECTION_UNAVAILABLE",
  "CREATE_COLLECTION_INVALID",
  "CREATE_MUTATION_NATIVE_WATCHDOG_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_LEASE_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_READ_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_DEADLINE_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_PRE_CANCELLED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_NULL_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_LOCKED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_POST_CANCELLED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_OTHER_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_CANCELLED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_TIMED_OUT_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_NOT_FOUND_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_PERMISSION_DENIED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_INVALID_ARGUMENT_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_NOT_INITIALIZED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_NOT_SUPPORTED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_CLOSED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_DBUS_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_GIO_OTHER_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_SERVICE_UNKNOWN_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_NO_OWNER_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_NO_REPLY_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_ACCESS_DENIED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_AUTH_FAILED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_TIMEOUT_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_DISCONNECTED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_INVALID_ARGUMENT_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_NOT_SUPPORTED_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_NOT_FOUND_UNAVAILABLE",
  "CREATE_MUTATION_NATIVE_COLLECTION_ERROR_DBUS_OTHER_UNAVAILABLE",
]);
const OBSERVATION_FAILURE_PREFIX = "LINUX_SECRET_SERVICE_QUALIFICATION_OBSERVATION_NATIVE_FAILED_";
const OBSERVATION_FAILURE_CODES = new Set([
  "BEFORE_TEST", ...OBSERVATION_NATIVE_PHASES,
].map((phase) => `${OBSERVATION_FAILURE_PREFIX}${phase}`));

function observationNativeFailureStage(output) {
  let phase = "BEFORE_TEST";
  if (typeof output !== "string") return phase;
  for (const line of output.split(/\r?\n/u)) {
    for (const candidate of OBSERVATION_NATIVE_PHASES) {
      if (line === `# LINUX_ACCOUNT_OBSERVATION_PHASE_${candidate}`) phase = candidate;
    }
  }
  return phase;
}

const QUALIFICATION_PROFILES = Object.freeze({
  legacy: Object.freeze({
    helper: QUALIFICATION_HELPER,
    arguments: Object.freeze([]),
    receipt: EXPECTED_RECEIPT,
  }),
  account_observation: Object.freeze({
    helper: fileURLToPath(import.meta.url),
    arguments: Object.freeze(["--account-observation-inner"]),
    receipt: OBSERVATION_RECEIPT,
  }),
});

function wait(durationMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, durationMs));
}

function fixedFailure(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

export function parseLinuxProcStartTime(value) {
  if (typeof value !== "string" || value.length > 16_384) return null;
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 1) return null;
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  return /^\d+$/u.test(startTime ?? "") ? startTime : null;
}

export function validateLinuxQualificationSupervisorReceipt(value, profile = "legacy") {
  if (!Object.hasOwn(QUALIFICATION_PROFILES, profile)) return null;
  const expectedReceipt = QUALIFICATION_PROFILES[profile].receipt;
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length !== Object.keys(expectedReceipt).length) {
    return null;
  }
  for (const [key, expected] of Object.entries(expectedReceipt)) {
    if (!Object.hasOwn(value, key) || value[key] !== expected) return null;
  }
  return Object.freeze({ ...expectedReceipt });
}

async function readLinuxProcessIdentity(
  pid,
  allowedExecutables,
  uid = process.getuid?.(),
) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isSafeInteger(uid) || uid < 0) {
    return null;
  }
  if (!(allowedExecutables instanceof Set) || allowedExecutables.size === 0) return null;
  try {
    const processRoot = `/proc/${pid}`;
    const processStat = await stat(processRoot);
    if (processStat.uid !== uid) return null;
    const executable = await readlink(`${processRoot}/exe`);
    if (!allowedExecutables.has(executable)) return null;
    const startTime = parseLinuxProcStartTime(
      await readFile(`${processRoot}/stat`, "utf8"),
    );
    return startTime === null
      ? null
      : Object.freeze({ pid, executable, startTime });
  } catch {
    return null;
  }
}

async function readQualificationProcessIdentity(pid, uid = process.getuid?.()) {
  return readLinuxProcessIdentity(pid, KNOWN_QUALIFICATION_EXECUTABLES, uid);
}

async function qualificationProcesses() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const identities = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const identity = await readQualificationProcessIdentity(Number(entry.name));
    if (identity !== null) identities.push(identity);
  }
  return identities;
}

export async function signalLinuxProcessIdentity(
  identity,
  signal,
  {
    asProcessGroup = false,
    readIdentity = (pid, allowedExecutables) => readLinuxProcessIdentity(
      pid,
      allowedExecutables,
    ),
    killProcess = (pid, requestedSignal) => process.kill(pid, requestedSignal),
  } = {},
) {
  if (identity === null
      || typeof identity !== "object"
      || !Number.isSafeInteger(identity.pid)
      || identity.pid < 2
      || typeof identity.executable !== "string"
      || !/^\d+$/u.test(identity.startTime ?? "")) {
    return false;
  }
  const current = await readIdentity(
    identity.pid,
    new Set([identity.executable]),
  );
  if (current?.executable !== identity.executable
      || current.startTime !== identity.startTime) {
    return false;
  }
  try {
    killProcess(asProcessGroup ? -identity.pid : identity.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function signalExactIdentity(identity, signal) {
  await signalLinuxProcessIdentity(identity, signal);
}

async function signalProcessGroup(identity, signal) {
  await signalLinuxProcessIdentity(identity, signal, { asProcessGroup: true });
}

async function waitForQualificationProcessesToExit(deadlineMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const remaining = await qualificationProcesses();
    if (remaining.length === 0) return true;
    await wait(50);
  }
  return (await qualificationProcesses()).length === 0;
}

export async function cleanupLinuxQualificationProcesses(
  processGroupIdentity,
  {
    signalGroup = signalProcessGroup,
    listProcesses = qualificationProcesses,
    signalIdentity = signalExactIdentity,
    waitForExit = waitForQualificationProcessesToExit,
    cleanupDeadlineMs = CLEANUP_DEADLINE_MS,
    killCleanupDeadlineMs = KILL_CLEANUP_DEADLINE_MS,
  } = {},
) {
  try {
    await signalGroup(processGroupIdentity, "SIGTERM");
    for (const identity of await listProcesses()) {
      await signalIdentity(identity, "SIGTERM");
    }
    if (await waitForExit(cleanupDeadlineMs)) return true;
    await signalGroup(processGroupIdentity, "SIGKILL");
    for (const identity of await listProcesses()) {
      await signalIdentity(identity, "SIGKILL");
    }
    return await waitForExit(killCleanupDeadlineMs);
  } catch {
    return false;
  }
}

function qualificationEnvironment(environment) {
  const selected = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) selected[key] = value;
  }
  return selected;
}

function boundedCapture(child, streamName, maxOutputBytes = MAX_OUTPUT_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  let overflow = false;
  child[streamName]?.on("data", (chunk) => {
    if (overflow) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxOutputBytes) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(bytes);
  });
  return Object.freeze({
    bytes() {
      return overflow ? null : Buffer.concat(chunks, totalBytes);
    },
  });
}

function supervisorFailure(code) {
  return Object.freeze({ status: "failed", code });
}

export async function runLinuxSecretServiceSupervisor({
  profile = "legacy",
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  listProcesses = qualificationProcesses,
  spawnChild = (selectedEnvironment) => spawn(
    DBUS_RUN_SESSION,
    ["--", process.execPath, QUALIFICATION_PROFILES[profile].helper,
      ...QUALIFICATION_PROFILES[profile].arguments],
    {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: selectedEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ),
  readProcessGroupIdentity = (pid) => readLinuxProcessIdentity(
    pid,
    new Set([DBUS_RUN_SESSION]),
  ),
  cleanupProcesses = cleanupLinuxQualificationProcesses,
  waitForChildClose = (child) => once(child, "close").catch(() => [null, "spawn_error"]),
  scheduleDeadline = (callback, durationMs) => setTimeout(callback, durationMs),
  cancelDeadline = (timer) => clearTimeout(timer),
  waitFor = wait,
  childDeadlineMs = CHILD_DEADLINE_MS,
  killCleanupDeadlineMs = KILL_CLEANUP_DEADLINE_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (!Object.hasOwn(QUALIFICATION_PROFILES, profile)) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_PROFILE_INVALID");
  }
  if (platform !== "linux"
      || architecture !== "x64"
      || environment.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED !== "1") {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_ISOLATION_REQUIRED");
  }
  let initialProcesses;
  try {
    initialProcesses = await listProcesses();
  } catch {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_PROCESS_PROOF_FAILED");
  }
  if (initialProcesses.length !== 0) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_ISOLATION_DIRTY");
  }

  let child;
  try {
    child = spawnChild(qualificationEnvironment(environment));
  } catch {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_CHILD_FAILED");
  }
  const stdout = boundedCapture(child, "stdout", maxOutputBytes);
  const stderr = boundedCapture(child, "stderr", maxOutputBytes);
  const processGroupIdentity = await readProcessGroupIdentity(child.pid);
  let timedOut = false;
  let timer;
  const close = waitForChildClose(child);
  const outcome = await Promise.race([
    close,
    new Promise((resolveTimeout) => {
      timer = scheduleDeadline(() => {
        timedOut = true;
        resolveTimeout([null, "deadline"]);
      }, childDeadlineMs);
    }),
  ]);
  cancelDeadline(timer);
  const cleanupConfirmed = await cleanupProcesses(processGroupIdentity);
  if (!cleanupConfirmed) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_PROCESS_CLEANUP_FAILED");
  }
  if (timedOut) {
    await Promise.race([close, waitFor(killCleanupDeadlineMs)]);
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_DEADLINE_EXCEEDED");
  }
  const [exitCode, signal] = outcome;
  const stdoutBytes = stdout.bytes();
  const stderrBytes = stderr.bytes();
  if (stdoutBytes === null || stderrBytes === null) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_OUTPUT_INVALID");
  }
  if (exitCode !== 0 || signal !== null) {
    const fixedChildFailure = stderrBytes.toString("utf8");
    if (/^LINUX_SECRET_SERVICE_QUALIFICATION_[A-Z_]+\n$/u.test(fixedChildFailure)) {
      return supervisorFailure(fixedChildFailure.trim());
    }
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_CHILD_FAILED");
  }
  if (stderrBytes.length !== 0) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_OUTPUT_INVALID");
  }
  let receipt;
  try {
    receipt = validateLinuxQualificationSupervisorReceipt(
      JSON.parse(stdoutBytes.toString("utf8")),
      profile,
    );
  } catch {
    receipt = null;
  }
  if (receipt === null) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_RECEIPT_INVALID");
  }
  return Object.freeze({ status: "passed", receipt });
}

export function runLinuxAccountObservationNativeQualification({
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  proveIsolation = proveLinuxSecretServiceContainerIsolation,
  startDaemon = startLinuxSecretServiceDaemon,
  spawnTest = spawnSync,
} = {}) {
  const failNative = (phase = "BEFORE_TEST") => {
    throw Object.assign(new Error("LINUX_ACCOUNT_OBSERVATION_QUALIFICATION_FAILED"), {
      code: `${OBSERVATION_FAILURE_PREFIX}${phase}`,
    });
  };
  if (platform !== "linux" || architecture !== "x64"
      || environment.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED !== "1") failNative();
  if (proveIsolation({ environment })?.status !== "isolated") failNative();
  if (startDaemon({ environment })?.status !== "started") failNative();
  const result = spawnTest(process.execPath, [
    "--test", "--test-reporter=tap",
    "test/linux-account-observation-credential-native.test.js",
  ], {
    cwd: REPOSITORY_ROOT,
    env: { ...environment, USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST: "1" },
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 15_000,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const marker = "# LINUX_ACCOUNT_OBSERVATION_NATIVE_PASSED";
  const markers = typeof result?.stdout === "string"
    ? result.stdout.split(/\r?\n/u).filter((line) => line === marker)
    : [];
  if (result?.error || result?.status !== 0 || result?.signal !== null
      || markers.length !== 1) failNative(observationNativeFailureStage(result?.stdout));
  return OBSERVATION_RECEIPT;
}

async function runSupervisor() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--account-observation-inner") {
    try {
      const receipt = runLinuxAccountObservationNativeQualification();
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } catch (error) {
      const code = error?.code;
      fixedFailure(OBSERVATION_FAILURE_CODES.has(code)
        ? code : "LINUX_SECRET_SERVICE_QUALIFICATION_OBSERVATION_NATIVE_FAILED");
    }
    return undefined;
  }
  const profile = args.length === 0 ? "legacy"
    : args.length === 1 && args[0] === "--account-observation" ? "account_observation" : null;
  if (profile === null) return fixedFailure("LINUX_SECRET_SERVICE_SUPERVISOR_PROFILE_INVALID");
  const outcome = await runLinuxSecretServiceSupervisor({ profile });
  if (outcome.status === "failed") return fixedFailure(outcome.code);
  process.stdout.write(`${JSON.stringify(outcome.receipt, null, 2)}\n`);
  return undefined;
}

function isMainModule() {
  return process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runSupervisor().catch(() => {
    fixedFailure("LINUX_SECRET_SERVICE_SUPERVISOR_UNEXPECTED");
  });
}
