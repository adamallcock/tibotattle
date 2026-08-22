#!/usr/bin/env node

/**
 * Qualify the real unsigned Windows x64 Electron directory artifact.
 *
 * This script is intentionally a native-Windows lane.  A macOS/Linux caller
 * receives an explicit `unsupported` aggregate and never a false `passed`
 * result.  The Windows lane launches the actual win-unpacked executable with
 * a disposable profile and local synthetic evidence.  No readiness selector,
 * signing credential, installer, or publication boundary is bypassed here.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  loadAuditedWindowsCredentialBinding,
} from "../src/platform/windows-credential-manager-probe.js";

const require = createRequire(import.meta.url);

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ARTIFACT_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-dev/windows-x64/artifacts/win-unpacked",
);
const DEFAULT_EXECUTABLE = join(DEFAULT_ARTIFACT_ROOT, "TiboTattle Dev.exe");
const MAX_STARTUP_MS = 45_000;
const MAX_OPERATION_MS = 10_000;
const MAX_REFRESH_MS = 45_000;
const MAX_SHUTDOWN_MS = 15_000;
const CONTROL_LINE_PATTERN = /^TIBOTATTLE_ELECTRON_SMOKE_STATE started=([01]) primary=([01]) window=([01]) visible=([01]) tray=([01])$/u;
const WINDOWS_PROCESS_TABLE_QUERY = [
  "$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId)",
  "foreach ($row in $all) { Write-Output (([int]$row.ProcessId).ToString() + ':' + ([int]$row.ParentProcessId).ToString())",
  "}",
].join(";");

const RESULT_KEYS = Object.freeze([
  "artifact",
  "dashboardReady",
  "syntheticRefresh",
  "secondInstanceRejected",
  "showHideTrayLifecycle",
  "cleanQuit",
  "noOrphan",
  "statePersistence",
  "credentialPersistence",
  "relaunchPersistence",
]);

export const WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST = Object.freeze([
  "none",
  "unsupported",
  "artifact",
  "launch",
  "control",
  "dashboard",
  "credential",
  "lifecycle",
  "refresh",
  "persistence",
  "instance",
  "shutdown",
  "relaunch",
  "unknown",
]);

export const WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST = Object.freeze([
  "none",
  "unsupported",
  "child_exit",
  "timeout",
  "protocol",
  "assertion",
  "operation",
  "unknown",
]);

const FAILURE_STAGE_SET = new Set(WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST);
const FAILURE_REASON_SET = new Set(WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST);
const DEFAULT_SMOKE_TIMEOUT_CODE = "WINDOWS_ELECTRON_SMOKE_TIMEOUT";
const SMOKE_TIMEOUT_CODES = new Set([
  DEFAULT_SMOKE_TIMEOUT_CODE,
  "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_CREDENTIAL_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_PERSISTENCE_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_INSTANCE_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_DESCENDANT_MONITOR_TIMEOUT",
  "WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_REJECTION_TIMEOUT",
]);
const SMOKE_CHILD_EXIT_CODES = new Set([
  "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL",
  "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY",
]);
const SMOKE_PROTOCOL_CODES = new Set([
  "WINDOWS_ELECTRON_SMOKE_CONTROL_INVALID",
  "WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE",
  "WINDOWS_ELECTRON_SMOKE_CREDENTIAL_COMMAND_INVALID",
  "WINDOWS_ELECTRON_SMOKE_CREDENTIAL_CONTROL_UNAVAILABLE",
  "WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID",
  "WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID",
]);
const SMOKE_PHASE_STAGE = Object.freeze({
  artifact: "artifact",
  launch: "launch",
  control: "control",
  dashboard: "dashboard",
  credential: "credential",
  lifecycle: "lifecycle",
  refresh: "refresh",
  persistence: "persistence",
  instance: "instance",
  shutdown: "shutdown",
  relaunch: "relaunch",
});

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function aggregate(status, values = {}) {
  const diagnostic = status === "passed"
    ? { failureStage: "none", failureReason: "none" }
    : status === "unsupported"
      ? { failureStage: "unsupported", failureReason: "unsupported" }
      : {
        failureStage: typeof values.failureStage === "string"
          && FAILURE_STAGE_SET.has(values.failureStage)
          && !["none", "unsupported"].includes(values.failureStage)
          ? values.failureStage
          : "unknown",
        failureReason: typeof values.failureReason === "string"
          && FAILURE_REASON_SET.has(values.failureReason)
          && !["none", "unsupported"].includes(values.failureReason)
          ? values.failureReason
          : "unknown",
      };
  return Object.freeze({
    status,
    target: "win32-x64",
    contentFree: true,
    ...diagnostic,
    ...Object.fromEntries(RESULT_KEYS.map((key) => [key, values[key] === true])),
  });
}

function printAggregate(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code) {
  throw fixedError(code);
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function withTimeout(
  promise,
  timeoutMs,
  _label,
  timeoutCode = DEFAULT_SMOKE_TIMEOUT_CODE,
) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fixedError(timeoutCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function isTerminalSmokeError(error) {
  // A bounded operation timeout can be an inner probe inside the larger
  // startup budget. Keep those markers retryable; child-exit and assertion
  // markers remain terminal evidence.
  return typeof error?.code === "string"
    && error.code.startsWith("WINDOWS_ELECTRON_SMOKE_")
    && !SMOKE_TIMEOUT_CODES.has(error.code);
}

export function classifySmokeFailure(error, phase = "unknown") {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code === null
      || (!SMOKE_TIMEOUT_CODES.has(code) && !code.startsWith("WINDOWS_ELECTRON_SMOKE_"))) {
    return Object.freeze({ failureStage: "unknown", failureReason: "unknown" });
  }
  const failureStage = FAILURE_STAGE_SET.has(SMOKE_PHASE_STAGE[phase])
    ? SMOKE_PHASE_STAGE[phase]
    : "unknown";
  let failureReason = "unknown";
  if (SMOKE_CHILD_EXIT_CODES.has(code)) {
    failureReason = "child_exit";
  } else if (SMOKE_TIMEOUT_CODES.has(code)) {
    failureReason = "timeout";
  } else if (SMOKE_PROTOCOL_CODES.has(code)) {
    failureReason = "protocol";
  } else if (isTerminalSmokeError(error)) {
    failureReason = "assertion";
  }
  return Object.freeze({ failureStage, failureReason });
}

export async function waitFor(
  predicate,
  timeoutMs,
  _label,
  timeoutCode = DEFAULT_SMOKE_TIMEOUT_CODE,
) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      // Coded smoke failures are terminal evidence, not transient readiness
      // misses. In particular, a child that has already exited must not be
      // retried until the full startup timeout has elapsed.
      if (isTerminalSmokeError(error)) throw error;
      lastError = error;
    }
    await wait(100);
  }
  void lastError;
  throw fixedError(timeoutCode);
}

async function freeTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address?.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  if (!Number.isSafeInteger(port) || port < 1) fail("WINDOWS_ELECTRON_SMOKE_PORT_UNAVAILABLE");
  return port;
}

async function createSyntheticFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-windows-"));
  const home = join(root, "profile");
  const codexHome = join(home, ".codex");
  const claudeHome = join(home, ".claude");
  const stateRoot = join(root, "state");
  const userData = join(root, "electron-user-data");
  const runtimeDirectory = join(root, "runtime");
  const sessions = join(codexHome, "sessions");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    mkdir(claudeHome, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(join(home, "AppData", "Roaming"), { recursive: true }),
    mkdir(join(home, "AppData", "Local"), { recursive: true }),
  ]);
  const now = Date.now();
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 24,
    reasoning_output_tokens: 8,
    total_tokens: 124,
  };
  const rows = [
    {
      timestamp: new Date(now - 2_000).toISOString(),
      type: "session_meta",
      payload: { id: "windows-electron-smoke" },
    },
    {
      timestamp: new Date(now - 1_000).toISOString(),
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: new Date(now).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage,
          last_token_usage: usage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "smoke",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: Math.floor((now + 7 * 24 * 60 * 60 * 1_000) / 1_000),
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessions, "rollout-windows-electron-smoke.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeFile(join(codexHome, "config.toml"), 'service_tier = "standard"\n');
  await writeFile(join(claudeHome, "settings.json"), "{}\n");
  return Object.freeze({
    root,
    home,
    codexHome,
    claudeHome,
    stateRoot,
    userData,
    runtimeDirectory,
    qualificationRunId: randomUUID(),
  });
}

function safeChildEnvironment(fixture) {
  const keys = [
    "ComSpec",
    "LANG",
    "LOCALAPPDATA",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "PROGRAMDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "WINDIR",
  ];
  const environment = Object.fromEntries(
    keys
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
  return {
    ...environment,
    APPDATA: join(fixture.home, "AppData", "Roaming"),
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    CLAUDE_PROJECT_DIR: fixture.root,
    CODEX_HOME: fixture.codexHome,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HOME: fixture.home,
    LOCALAPPDATA: join(fixture.home, "AppData", "Local"),
    TMP: fixture.root,
    TEMP: fixture.root,
    USERPROFILE: fixture.home,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: fixture.qualificationRunId,
    USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    XDG_CONFIG_HOME: join(fixture.home, ".config"),
    XDG_DATA_HOME: join(fixture.home, ".local", "share"),
    XDG_RUNTIME_DIR: fixture.runtimeDirectory,
    XDG_CACHE_HOME: join(fixture.home, ".cache"),
  };
}

async function assertWindowsExecutable(executable) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("WINDOWS_ELECTRON_SMOKE_NATIVE_X64_REQUIRED");
  }
  if (!executable.toLowerCase().endsWith(".exe")) {
    fail("WINDOWS_ELECTRON_SMOKE_EXE_REQUIRED");
  }
  const metadata = await stat(executable).catch(() => null);
  if (metadata === null || !metadata.isFile()) {
    fail("WINDOWS_ELECTRON_SMOKE_PACKAGED_EXE_MISSING");
  }
  const bytes = await readFile(executable);
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    fail("WINDOWS_ELECTRON_SMOKE_PE_HEADER_INVALID");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 6 > bytes.length
      || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
      || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    fail("WINDOWS_ELECTRON_SMOKE_X64_IMAGE_REQUIRED");
  }
}

async function jsonFetch(
  url,
  options = undefined,
  timeoutCode = DEFAULT_SMOKE_TIMEOUT_CODE,
) {
  const response = await withTimeout(
    fetch(url, options),
    MAX_OPERATION_MS,
    "JSON request",
    timeoutCode,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket error")), { once: true });
  }), MAX_OPERATION_MS, "CDP connection", "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT");
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (Number.isInteger(message.id)) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error("CDP request failed"));
      else request.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    const waiters = eventWaiters.get(message.method);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      let matched = false;
      try {
        matched = waiter.predicate(message.params ?? {});
      } catch {
        waiter.reject(new Error("CDP event predicate failed"));
        waiters.delete(waiter);
        continue;
      }
      if (!matched) continue;
      waiters.delete(waiter);
      waiter.resolve(message.params ?? {});
    }
    if (waiters.size === 0) eventWaiters.delete(message.method);
  };
  socket.addEventListener("message", onMessage);
  const request = (method, params = {}) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(
      promise,
      MAX_OPERATION_MS,
      `CDP ${method}`,
      "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
    );
  };
  const evaluate = async (expression) => {
    const response = await request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error("renderer evaluation failed");
    return response.result?.value;
  };
  const waitForEvent = (
    method,
    predicate = () => true,
    timeoutCode = "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  ) => {
    if (typeof method !== "string" || typeof predicate !== "function") {
      throw new TypeError("CDP event waiter is invalid");
    }
    let timer = null;
    let waiter;
    const promise = new Promise((resolveEvent, rejectEvent) => {
      waiter = {
        predicate,
        resolve(value) {
          if (timer !== null) clearTimeout(timer);
          resolveEvent(value);
        },
        reject(error) {
          if (timer !== null) clearTimeout(timer);
          rejectEvent(error);
        },
      };
      const waiters = eventWaiters.get(method) ?? new Set();
      waiters.add(waiter);
      eventWaiters.set(method, waiters);
      timer = setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) eventWaiters.delete(method);
        rejectEvent(fixedError(timeoutCode));
      }, MAX_STARTUP_MS);
    });
    return promise;
  };
  return Object.freeze({
    request,
    evaluate,
    waitForEvent,
    close() {
      socket.close();
      for (const { reject } of pending.values()) reject(new Error("CDP closed"));
      pending.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) waiter.reject(new Error("CDP closed"));
      }
      eventWaiters.clear();
    },
  });
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function childExitPromise(child) {
  if (childExited(child)) return Promise.resolve();
  return once(child, "exit");
}

async function terminateProcessTree(child) {
  if (!child || childExited(child)) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    await withTimeout(
      childExitPromise(killer),
      MAX_OPERATION_MS,
      "taskkill",
      "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
    ).catch(() => {});
  } else {
    child.kill();
  }
  await withTimeout(
    childExitPromise(child),
    MAX_OPERATION_MS,
    "process termination",
    "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
  ).catch(() => {});
}

async function queryWindowsProcessTable() {
  const query = WINDOWS_PROCESS_TABLE_QUERY;
  const probe = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  const completed = new Promise((resolveProbe, rejectProbe) => {
    probe.once("error", () => rejectProbe(new Error("process table probe failed")));
    probe.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        rejectProbe(new Error("process table probe failed"));
      } else {
        resolveProbe();
      }
    });
    probe.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 1_048_576) {
        probe.kill();
        rejectProbe(new Error("process table probe output exceeded bound"));
      }
    });
  });
  try {
    await withTimeout(
      completed,
      MAX_OPERATION_MS,
      "process table probe",
      "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
    );
  } catch (error) {
    probe.kill();
    await withTimeout(
      childExitPromise(probe),
      MAX_OPERATION_MS,
      "process table probe termination",
      "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
    )
      .catch(() => {});
    throw error;
  }
  const table = new Map();
  for (const line of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const match = /^(\d+):(\d+)$/u.exec(line);
    if (!match) fail("WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID");
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1
        || !Number.isSafeInteger(parentPid) || parentPid < 0) {
      fail("WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID");
    }
    table.set(pid, parentPid);
  }
  return table;
}

async function captureDescendantPids(rootPid, { requireNonEmpty = true } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) {
    fail("WINDOWS_ELECTRON_SMOKE_ROOT_PID_INVALID");
  }
  const table = await queryWindowsProcessTable();
  const children = new Map();
  for (const [pid, parentPid] of table) {
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const pending = [...(children.get(rootPid) ?? [])];
  const descendants = new Set();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  if (requireNonEmpty && descendants.size === 0) {
    fail("WINDOWS_ELECTRON_SMOKE_DESCENDANTS_MISSING");
  }
  return descendants;
}

async function addCurrentDescendants(rootPid, descendants) {
  const current = await captureDescendantPids(rootPid, { requireNonEmpty: false });
  for (const pid of current) descendants.add(pid);
  return descendants;
}

/**
 * Union descendant snapshots while a root is shutting down. A single
 * pre-exit or post-exit snapshot can miss a helper created during teardown;
 * polling until the root exits closes that race while remaining bounded.
 */
async function monitorDescendantsUntilExit(child, descendants, label) {
  if (!child?.pid || !(descendants instanceof Set)) {
    fail("WINDOWS_ELECTRON_SMOKE_DESCENDANT_MONITOR_INVALID");
  }
  const started = Date.now();
  await addCurrentDescendants(child.pid, descendants).catch((error) => {
    if (!childExited(child)) throw error;
  });
  while (!childExited(child)) {
    if (Date.now() - started >= MAX_SHUTDOWN_MS) {
      fail("WINDOWS_ELECTRON_SMOKE_DESCENDANT_MONITOR_TIMEOUT");
    }
    await wait(50);
    try {
      await addCurrentDescendants(child.pid, descendants);
    } catch (error) {
      if (!childExited(child)) throw error;
    }
  }
  return descendants;
}

async function waitForDescendantsGone(rootPid, descendants, label) {
  if (!(descendants instanceof Set) || descendants.size === 0) {
    fail("WINDOWS_ELECTRON_SMOKE_DESCENDANTS_MISSING");
  }
  await waitFor(async () => {
    const table = await queryWindowsProcessTable();
    for (const pid of descendants) {
      // Check the full process table, not only rootPid's current children:
      // a child that reparented is still an orphan and must not be treated as
      // clean merely because the original Electron parent exited.
      if (table.has(pid)) return false;
    }
    void rootPid;
    return true;
  }, MAX_SHUTDOWN_MS, label, "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT");
}

function spawnPackagedElectron(executable, fixture, port, cwd) {
  const child = spawn(executable, [
    `--user-data-dir=${fixture.userData}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    "--no-first-run",
  ], {
    cwd,
    env: safeChildEnvironment(fixture),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin?.setDefaultEncoding?.("utf8");
  return child;
}

function controlReader(child, observeLine = null, retainLines = true) {
  const lines = [];
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).replace(/\r$/u, "");
      if (retainLines) lines.push(line);
      if (typeof observeLine === "function") observeLine(line);
      buffer = buffer.slice(end + 1);
    }
  });
  return async function nextLine(
    predicate,
    label,
    timeoutCode = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
  ) {
    return waitFor(() => {
      const index = lines.findIndex(predicate);
      if (index < 0) return null;
      return lines.splice(index, 1)[0];
    }, MAX_OPERATION_MS, label, timeoutCode);
  };
}

function parseState(line) {
  const match = CONTROL_LINE_PATTERN.exec(line);
  if (!match) fail("WINDOWS_ELECTRON_SMOKE_CONTROL_INVALID");
  return Object.freeze({
    started: match[1] === "1",
    primary: match[2] === "1",
    window: match[3] === "1",
    visible: match[4] === "1",
    tray: match[5] === "1",
  });
}

function assertPrimaryShellState(state, code) {
  if (!state.started || !state.primary || !state.window || !state.tray) {
    fail(code);
  }
  return state;
}

async function command(
  child,
  nextLine,
  value,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
) {
  if (!child.stdin?.write(`${value}\n`)) fail("WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE");
  const line = await nextLine(
    (candidate) => candidate.startsWith("TIBOTATTLE_ELECTRON_SMOKE_STATE "),
    `control ${value}`,
    timeoutCode,
  );
  return parseState(line);
}

function credentialResponsePrefix(value) {
  const commandName = value.startsWith("credential-") && value.endsWith("-v1")
    ? value.slice("credential-".length, -3)
    : null;
  if (!commandName) fail("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_COMMAND_INVALID");
  return `TIBOTATTLE_ELECTRON_SMOKE_CREDENTIAL_${commandName.toUpperCase()}`;
}

/**
 * Send one fixed credential control command and wait for its fixed result.
 * Credential values, service names, and native diagnostics never cross this
 * boundary; a failed response is converted to a stable smoke error.
 */
async function credentialCommand(
  child,
  nextLine,
  value,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_CREDENTIAL_TIMEOUT",
) {
  if (!child.stdin?.write(`${value}\n`)) {
    fail("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_CONTROL_UNAVAILABLE");
  }
  const prefix = credentialResponsePrefix(value);
  const line = await nextLine(
    (candidate) => candidate === `${prefix}_PASSED`
      || candidate === `${prefix}_FAILED`,
    `credential ${value}`,
    timeoutCode,
  );
  if (line !== `${prefix}_PASSED`) {
    fail("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATION_FAILED");
  }
  return true;
}

/**
 * A rejected second Electron invocation must not briefly expose its own
 * debugging endpoint before the single-instance exit. Probe its private port
 * for the whole bounded lifetime; any successful response is a shell-start
 * failure even if the process later exits with code zero.
 */
async function assertSecondInstanceNeverReady(child, port) {
  const started = Date.now();
  while (true) {
    const endpoint = await withTimeout(
      fetch(`http://127.0.0.1:${port}/json/version`),
      MAX_OPERATION_MS,
      "second instance debugging endpoint",
      "WINDOWS_ELECTRON_SMOKE_INSTANCE_TIMEOUT",
    ).catch(() => null);
    if (endpoint?.ok === true) {
      fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_STARTED");
    }
    if (typeof endpoint?.body?.cancel === "function") {
      await endpoint.body.cancel().catch(() => {});
    }
    if (childExited(child)) return;
    if (Date.now() - started >= MAX_SHUTDOWN_MS) {
      fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_REJECTION_TIMEOUT");
    }
    await wait(50);
  }
}

async function dashboardConnection(child, port) {
  const version = await waitFor(
    () => {
      if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
      return jsonFetch(
        `http://127.0.0.1:${port}/json/version`,
        undefined,
        "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
      );
    },
    MAX_STARTUP_MS,
    "Electron debugging endpoint",
    "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  );
  const target = await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const targets = await jsonFetch(
      `http://127.0.0.1:${port}/json`,
      undefined,
      "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
    );
    return targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  }, MAX_STARTUP_MS, "Electron dashboard target", "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT");
  const cdp = await connectCdp(target);
  const ready = await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const snapshot = await cdp.evaluate(`(() => ({
      ready: document.documentElement?.dataset?.localDashboardReady === "true",
      title: document.title,
      heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
      location: location.href,
    }))()`);
    return snapshot.ready && snapshot.title === "TiboTattle" && snapshot.heading
      ? snapshot
      : null;
  }, MAX_STARTUP_MS, "dashboard readiness", "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT");
  const dashboardUrl = new URL(ready.location);
  if (dashboardUrl.protocol !== "http:" || dashboardUrl.hostname !== "127.0.0.1") {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_REQUIRED");
  }
  const health = await jsonFetch(
    new URL("/api/local/health", dashboardUrl),
    undefined,
    "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  );
  if (health.status !== "ready") fail("WINDOWS_ELECTRON_SMOKE_COMPANION_NOT_READY");
  return Object.freeze({ cdp, dashboardUrl, browser: version.Browser });
}

/**
 * Reload through the CDP Page domain and require a main-frame navigation plus
 * a changed performance time origin before accepting dashboard readiness. The
 * navigation event and new-document timestamp prevent the old DOM from
 * satisfying the post-refresh render proof.
 */
async function reloadDashboardDocument(connection) {
  const before = await connection.cdp.evaluate(
    "({ timeOrigin: performance.timeOrigin, url: location.href })",
  );
  if (!Number.isFinite(before?.timeOrigin) || typeof before?.url !== "string") {
    fail("WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID");
  }
  await connection.cdp.request("Page.enable");
  const navigation = connection.cdp.waitForEvent(
    "Page.frameNavigated",
    (event) => event?.frame?.parentId === undefined
      || event?.frame?.parentId === null,
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  await connection.cdp.request("Page.reload", { ignoreCache: false });
  await navigation;
  await waitFor(async () => {
    const snapshot = await connection.cdp.evaluate(`(() => ({
      ready: document.documentElement?.dataset?.localDashboardReady === "true",
      timeOrigin: performance.timeOrigin,
      url: location.href,
    }))()`);
    return snapshot.ready
      && Number.isFinite(snapshot.timeOrigin)
      && snapshot.timeOrigin !== before.timeOrigin
      && snapshot.url === before.url;
  }, MAX_STARTUP_MS, "dashboard fresh-document render", "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT");
}

async function runSyntheticRefresh(connection) {
  const { dashboardUrl } = connection;
  const response = await withTimeout(
    fetch(new URL("/api/local/refresh", dashboardUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
      },
      body: "{}",
    }),
    MAX_OPERATION_MS,
    "refresh request",
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  if (response.status !== 202) fail("WINDOWS_ELECTRON_SMOKE_REFRESH_NOT_ACCEPTED");
  await waitFor(async () => {
    const status = await jsonFetch(
      new URL("/api/local/refresh", dashboardUrl),
      undefined,
      "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
    );
    const value = status?.refresh?.status;
    if (value === "succeeded") return true;
    if (["failed", "cancelled"].includes(value)) {
      fail("WINDOWS_ELECTRON_SMOKE_REFRESH_FAILED");
    }
    return false;
  }, MAX_REFRESH_MS, "synthetic refresh", "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT");
  // A completed refresh must still be renderable by the dashboard after the
  // data pass, not merely accepted by the mutation endpoint.
  await reloadDashboardDocument(connection);
}

async function writePersistentQualificationState(connection) {
  const { dashboardUrl } = connection;
  const response = await withTimeout(
    fetch(
      new URL("/api/local/accounting/fast-mode-preference", dashboardUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: dashboardUrl.origin,
        },
        body: JSON.stringify({ mode: "fast" }),
      },
    ),
    MAX_OPERATION_MS,
    "state persistence request",
    "WINDOWS_ELECTRON_SMOKE_PERSISTENCE_TIMEOUT",
  );
  if (!response.ok) fail("WINDOWS_ELECTRON_SMOKE_STATE_WRITE_FAILED");
  const value = await response.json();
  if (value?.mode !== "fast" || value?.source !== "stated") {
    fail("WINDOWS_ELECTRON_SMOKE_STATE_WRITE_FAILED");
  }
}

async function verifyPersistentQualificationState(connection) {
  const value = await jsonFetch(
    new URL(
      "/api/local/accounting/fast-mode-preference",
      connection.dashboardUrl,
    ),
    undefined,
    "WINDOWS_ELECTRON_SMOKE_PERSISTENCE_TIMEOUT",
  );
  if (value?.mode !== "fast" || value?.source !== "stated") {
    fail("WINDOWS_ELECTRON_SMOKE_STATE_RETENTION_FAILED");
  }
}

/**
 * Make one bounded cleanup attempt through the packaged, unpacked keytar
 * binding if the Electron control pipe is unavailable. The audited loader
 * authenticates the fixed native bytes and this helper performs delete plus
 * readback; it returns only a boolean and never exposes credential content.
 */
async function directCredentialCleanup(fixture, artifactRoot) {
  try {
    const keytarPath = join(
      artifactRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@github",
      "keytar",
      "prebuilds",
      "win32-x64",
      "keytar.node",
    );
    const binding = loadAuditedWindowsCredentialBinding({
      platform: "win32",
      architecture: "x64",
      resolveBinding: () => keytarPath,
      requireBinding: (path) => require(path),
    });
    const service = `app-usagemonitor.windows-qualification.${fixture.qualificationRunId}`;
    const account = "disposable-probe";
    await binding.deletePassword(service, account);
    const remaining = await binding.getPassword(service, account);
    return remaining === null;
  } catch {
    return false;
  }
}

export async function runSmoke(progress) {
  if (progress === null
      || typeof progress !== "object"
      || Array.isArray(progress)) {
    throw new TypeError("Windows Electron smoke progress must be a plain object");
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    return aggregate("unsupported");
  }
  const executable = resolve(process.env.TIBOTATTLE_ELECTRON_EXE ?? DEFAULT_EXECUTABLE);
  const artifactRoot = dirname(executable);
  const fixture = await createSyntheticFixture();
  let primary = null;
  let second = null;
  let relaunch = null;
  let connection = null;
  let nextPrimaryLine = null;
  let nextRelaunchLine = null;
  let primaryQuitRequested = false;
  let relaunchQuitRequested = false;
  let credentialMayExist = false;
  let credentialDeleted = false;
  let failurePhase = "artifact";
  const cleanupCredential = async ({ allowLiveControl = true } = {}) => {
    if (!credentialMayExist || credentialDeleted) return;
    let liveAttempted = false;
    if (allowLiveControl) {
      for (const [child, nextLine, quitRequested] of [
        [relaunch, nextRelaunchLine, relaunchQuitRequested],
        [primary, nextPrimaryLine, primaryQuitRequested],
      ]) {
        if (quitRequested || child === null || childExited(child)
            || typeof nextLine !== "function") continue;
        liveAttempted = true;
        try {
          await credentialCommand(child, nextLine, "credential-delete-v1");
          credentialDeleted = true;
          credentialMayExist = false;
          return;
        } catch {
          // Terminate the process before loading the direct fallback binding.
        }
      }
    }
    // Do not load a second copy of the native binding while a live Electron
    // operation may still be pending. Retry only after process termination.
    if (!liveAttempted && !allowLiveControl
        && await directCredentialCleanup(fixture, artifactRoot)) {
      credentialDeleted = true;
      credentialMayExist = false;
    }
  };
  try {
    await assertWindowsExecutable(executable);
    progress.artifact = true;
    failurePhase = "launch";
    const primaryPort = await freeTcpPort();
    primary = spawnPackagedElectron(executable, fixture, primaryPort, artifactRoot);
    if (!primary.pid) fail("WINDOWS_ELECTRON_SMOKE_PRIMARY_PID_MISSING");
    nextPrimaryLine = controlReader(primary);
    failurePhase = "control";
    const initialState = await waitFor(
      () => {
        if (childExited(primary)) {
          fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL");
        }
        return command(primary, nextPrimaryLine, "status-v1");
      },
      MAX_STARTUP_MS,
      "primary shell status",
      "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
    );
    assertPrimaryShellState(initialState, "WINDOWS_ELECTRON_SMOKE_PRIMARY_STATE_INVALID");
    failurePhase = "dashboard";
    connection = await dashboardConnection(primary, primaryPort);
    failurePhase = "lifecycle";
    const primaryDescendantPids = await captureDescendantPids(primary.pid);
    progress.dashboardReady = true;

    // Run the random-namespace probe first, then create the deterministic
    // credential that must survive the first process exit and relaunch.
    failurePhase = "credential";
    await credentialCommand(primary, nextPrimaryLine, "credential-probe-v1");
    credentialMayExist = true;
    await credentialCommand(primary, nextPrimaryLine, "credential-create-v1");

    failurePhase = "lifecycle";
    const hidden = await command(primary, nextPrimaryLine, "tray-hide-v1");
    const shown = await command(primary, nextPrimaryLine, "tray-show-v1");
    const toggledHidden = await command(primary, nextPrimaryLine, "tray-toggle-v1");
    const toggledShown = await command(primary, nextPrimaryLine, "tray-toggle-v1");
    if (!hidden.tray || hidden.visible || !shown.visible || !toggledHidden.tray
        || toggledHidden.visible || !toggledShown.visible) {
      fail("WINDOWS_ELECTRON_SMOKE_WINDOW_TRAY_LIFECYCLE_FAILED");
    }
    progress.showHideTrayLifecycle = true;

    failurePhase = "refresh";
    await runSyntheticRefresh(connection);
    progress.syntheticRefresh = true;
    failurePhase = "persistence";
    await writePersistentQualificationState(connection);

    failurePhase = "instance";
    const secondPort = await freeTcpPort();
    second = spawnPackagedElectron(executable, fixture, secondPort, artifactRoot);
    const secondObservedLines = [];
    controlReader(second, (line) => {
      if (secondObservedLines.length < 32) secondObservedLines.push(line);
    }, false);
    const secondDescendantPids = new Set();
    const secondDescendantMonitor = monitorDescendantsUntilExit(
      second,
      secondDescendantPids,
      "second instance descendant monitor",
    );
    const secondEndpointMonitor = assertSecondInstanceNeverReady(second, secondPort);
    let primaryDuringSecond;
    try {
      primaryDuringSecond = await command(
        primary,
        nextPrimaryLine,
        "status-v1",
        "WINDOWS_ELECTRON_SMOKE_INSTANCE_TIMEOUT",
      );
      await withTimeout(
        childExitPromise(second),
        MAX_SHUTDOWN_MS,
        "second instance rejection",
        "WINDOWS_ELECTRON_SMOKE_INSTANCE_TIMEOUT",
      );
    } finally {
      await terminateProcessTree(second);
      await secondDescendantMonitor;
      await secondEndpointMonitor;
    }
    assertPrimaryShellState(
      primaryDuringSecond,
      "WINDOWS_ELECTRON_SMOKE_PRIMARY_LOST_DURING_SECOND_INSTANCE",
    );
    if (second.exitCode !== 0 || second.signalCode !== null) {
      fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_NOT_REJECTED");
    }
    for (const line of secondObservedLines) {
      if (!line.startsWith("TIBOTATTLE_ELECTRON_SMOKE_STATE ")) continue;
      const state = parseState(line);
      if (state.primary) fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_BECAME_PRIMARY");
    }
    const primaryAfterSecond = await command(
      primary,
      nextPrimaryLine,
      "status-v1",
      "WINDOWS_ELECTRON_SMOKE_INSTANCE_TIMEOUT",
    );
    assertPrimaryShellState(
      primaryAfterSecond,
      "WINDOWS_ELECTRON_SMOKE_PRIMARY_LOST_AFTER_SECOND_INSTANCE",
    );
    if (secondDescendantPids.size > 0) {
      await waitForDescendantsGone(
        second.pid,
        secondDescendantPids,
        "second instance descendant cleanup",
      );
    }
    progress.secondInstanceRejected = true;

    failurePhase = "shutdown";
    // Capture once more after refresh and the second-instance attempt. This
    // includes helpers created after initial dashboard readiness. A final
    // post-exit capture below also catches any Windows child whose recorded
    // parent is the now-terminated primary process.
    await addCurrentDescendants(primary.pid, primaryDescendantPids);

    const primaryDescendantMonitor = monitorDescendantsUntilExit(
      primary,
      primaryDescendantPids,
      "primary descendant monitor",
    );
    primaryQuitRequested = true;
    try {
      if (!primary.stdin?.write("quit-v1\n")) fail("WINDOWS_ELECTRON_SMOKE_QUIT_UNAVAILABLE");
      await nextPrimaryLine(
        (line) => line === "TIBOTATTLE_ELECTRON_SMOKE_QUIT_ACCEPTED",
        "primary clean quit acknowledgement",
        "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
      );
      await withTimeout(
        childExitPromise(primary),
        MAX_SHUTDOWN_MS,
        "primary clean quit",
        "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
      );
    } finally {
      await terminateProcessTree(primary);
      await primaryDescendantMonitor;
    }
    connection.cdp.close();
    connection = null;
    if (primary.exitCode !== 0 || primary.signalCode !== null) {
      fail("WINDOWS_ELECTRON_SMOKE_PRIMARY_QUIT_FAILED");
    }
    await addCurrentDescendants(primary.pid, primaryDescendantPids);
    await waitForDescendantsGone(
      primary.pid,
      primaryDescendantPids,
      "primary descendant cleanup",
    );
    const primaryNoOrphan = true;
    progress.cleanQuit = true;
    // The companion is launched by the Electron process and should disappear
    // with it. A relaunch against the same profile proves that the old process
    // released its single-instance lock and did not leave a child holding it.
    failurePhase = "relaunch";
    const relaunchPort = await freeTcpPort();
    relaunch = spawnPackagedElectron(executable, fixture, relaunchPort, artifactRoot);
    if (!relaunch.pid) fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_PID_MISSING");
    nextRelaunchLine = controlReader(relaunch);
    try {
      const state = await waitFor(
        () => {
          if (childExited(relaunch)) {
            fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL");
          }
          return command(relaunch, nextRelaunchLine, "status-v1");
        },
        MAX_STARTUP_MS,
        "relaunch shell status",
        "WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT",
      );
      if (!state.started || !state.primary || !state.tray) {
        fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_STATE_INVALID");
      }
      const relaunched = await dashboardConnection(relaunch, relaunchPort);
      const relaunchDescendantPids = await captureDescendantPids(relaunch.pid);
      await verifyPersistentQualificationState(relaunched);
      progress.statePersistence = true;
      await credentialCommand(relaunch, nextRelaunchLine, "credential-read-v1");
      relaunched.cdp.close();
      await credentialCommand(relaunch, nextRelaunchLine, "credential-delete-v1");
      credentialDeleted = true;
      credentialMayExist = false;
      progress.credentialPersistence = true;
      const relaunchDescendantMonitor = monitorDescendantsUntilExit(
        relaunch,
        relaunchDescendantPids,
        "relaunch descendant monitor",
      );
      relaunchQuitRequested = true;
      try {
        if (!relaunch.stdin?.write("quit-v1\n")) {
          fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_QUIT_UNAVAILABLE");
        }
        await nextRelaunchLine(
          (line) => line === "TIBOTATTLE_ELECTRON_SMOKE_QUIT_ACCEPTED",
          "relaunch clean quit acknowledgement",
          "WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT",
        );
        await withTimeout(
          childExitPromise(relaunch),
          MAX_SHUTDOWN_MS,
          "relaunch clean quit",
          "WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT",
        );
      } finally {
        await terminateProcessTree(relaunch);
        await relaunchDescendantMonitor;
      }
      if (relaunch.exitCode !== 0 || relaunch.signalCode !== null) {
        fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_QUIT_FAILED");
      }
      await addCurrentDescendants(relaunch.pid, relaunchDescendantPids);
      await waitForDescendantsGone(
        relaunch.pid,
        relaunchDescendantPids,
        "relaunch descendant cleanup",
      );
      const relaunchNoOrphan = true;
      progress.noOrphan = primaryNoOrphan && relaunchNoOrphan;
    } finally {
      await terminateProcessTree(relaunch);
    }
    progress.relaunchPersistence = progress.statePersistence === true
      && progress.credentialPersistence === true;
    return aggregate("passed", progress);
  } catch (error) {
    const diagnostic = classifySmokeFailure(error, failurePhase);
    progress.failureStage = diagnostic.failureStage;
    progress.failureReason = diagnostic.failureReason;
    throw error;
  } finally {
    await cleanupCredential({ allowLiveControl: true });
    connection?.cdp.close();
    await terminateProcessTree(second);
    await terminateProcessTree(primary);
    await terminateProcessTree(relaunch);
    await cleanupCredential({ allowLiveControl: false });
    await rm(fixture.root, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  // Keep progress outside the smoke promise so a startup, dashboard, or
  // cleanup failure can retain only the already-completed closed-schema
  // booleans and fixed diagnostic enums. The caller owns this plain object;
  // aggregate() projects only the allowlisted result keys and diagnostics.
  const progress = {};
  let output;
  try {
    output = await runSmoke(progress);
  } catch {
    // Never expose executable paths, child diagnostics, account values, or
    // filesystem contents. The aggregate is the only supported smoke output.
    output = aggregate("failed", progress);
    process.exitCode = 1;
  }
  printAggregate(output);
}
