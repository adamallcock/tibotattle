#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  readFile,
  readdir,
  readlink,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export function validateLinuxQualificationSupervisorReceipt(value) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length !== Object.keys(EXPECTED_RECEIPT).length) {
    return null;
  }
  for (const [key, expected] of Object.entries(EXPECTED_RECEIPT)) {
    if (!Object.hasOwn(value, key) || value[key] !== expected) return null;
  }
  return Object.freeze({ ...EXPECTED_RECEIPT });
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
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  listProcesses = qualificationProcesses,
  spawnChild = (selectedEnvironment) => spawn(
    DBUS_RUN_SESSION,
    ["--", process.execPath, QUALIFICATION_HELPER],
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
    );
  } catch {
    receipt = null;
  }
  if (receipt === null) {
    return supervisorFailure("LINUX_SECRET_SERVICE_SUPERVISOR_RECEIPT_INVALID");
  }
  return Object.freeze({ status: "passed", receipt });
}

async function runSupervisor() {
  const outcome = await runLinuxSecretServiceSupervisor();
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
