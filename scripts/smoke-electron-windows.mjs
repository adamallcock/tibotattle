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
  "relaunchPersistence",
]);

function aggregate(status, values = {}) {
  return Object.freeze({
    status,
    target: "win32-x64",
    contentFree: true,
    ...Object.fromEntries(RESULT_KEYS.map((key) => [key, values[key] === true])),
  });
}

function printAggregate(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`${label} timed out${lastError ? ` (${lastError.message})` : ""}`);
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

async function jsonFetch(url, options = undefined) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket error")), { once: true });
  }), MAX_OPERATION_MS, "CDP connection");
  let nextId = 1;
  const pending = new Map();
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("CDP request failed"));
    else request.resolve(message.result ?? {});
  };
  socket.addEventListener("message", onMessage);
  const request = (method, params = {}) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(promise, MAX_OPERATION_MS, `CDP ${method}`);
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
  return Object.freeze({
    request,
    evaluate,
    close() {
      socket.close();
      for (const { reject } of pending.values()) reject(new Error("CDP closed"));
      pending.clear();
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
    await withTimeout(childExitPromise(killer), MAX_OPERATION_MS, "taskkill").catch(() => {});
  } else {
    child.kill();
  }
  await withTimeout(childExitPromise(child), MAX_OPERATION_MS, "process termination").catch(() => {});
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
    await withTimeout(completed, MAX_OPERATION_MS, "process table probe");
  } catch (error) {
    probe.kill();
    await withTimeout(childExitPromise(probe), MAX_OPERATION_MS, "process table probe termination")
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
  }, MAX_SHUTDOWN_MS, label);
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

function controlReader(child) {
  const lines = [];
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      lines.push(buffer.slice(0, end).replace(/\r$/u, ""));
      buffer = buffer.slice(end + 1);
    }
  });
  return async function nextLine(predicate, label) {
    return waitFor(() => {
      const index = lines.findIndex(predicate);
      if (index < 0) return null;
      return lines.splice(index, 1)[0];
    }, MAX_OPERATION_MS, label);
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

async function command(child, nextLine, value) {
  if (!child.stdin?.write(`${value}\n`)) fail("WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE");
  const line = await nextLine(
    (candidate) => candidate.startsWith("TIBOTATTLE_ELECTRON_SMOKE_STATE "),
    `control ${value}`,
  );
  return parseState(line);
}

async function dashboardConnection(child, port) {
  const version = await waitFor(
    () => {
      if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
      return jsonFetch(`http://127.0.0.1:${port}/json/version`);
    },
    MAX_STARTUP_MS,
    "Electron debugging endpoint",
  );
  const target = await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const targets = await jsonFetch(`http://127.0.0.1:${port}/json`);
    return targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  }, MAX_STARTUP_MS, "Electron dashboard target");
  const cdp = await connectCdp(target);
  const ready = await waitFor(async () => {
    const snapshot = await cdp.evaluate(`(() => ({
      ready: document.documentElement?.dataset?.localDashboardReady === "true",
      title: document.title,
      heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
      location: location.href,
    }))()`);
    return snapshot.ready && snapshot.title === "TiboTattle" && snapshot.heading
      ? snapshot
      : null;
  }, MAX_STARTUP_MS, "dashboard readiness");
  const dashboardUrl = new URL(ready.location);
  if (dashboardUrl.protocol !== "http:" || dashboardUrl.hostname !== "127.0.0.1") {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_REQUIRED");
  }
  const health = await jsonFetch(new URL("/api/local/health", dashboardUrl));
  if (health.status !== "ready") fail("WINDOWS_ELECTRON_SMOKE_COMPANION_NOT_READY");
  return Object.freeze({ cdp, dashboardUrl, browser: version.Browser });
}

async function runSyntheticRefresh(connection) {
  const { dashboardUrl } = connection;
  const response = await fetch(new URL("/api/local/refresh", dashboardUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
    },
    body: "{}",
  });
  if (response.status !== 202) fail("WINDOWS_ELECTRON_SMOKE_REFRESH_NOT_ACCEPTED");
  await waitFor(async () => {
    const status = await jsonFetch(new URL("/api/local/refresh", dashboardUrl));
    const value = status?.refresh?.status;
    if (value === "succeeded") return true;
    if (["failed", "cancelled"].includes(value)) {
      fail("WINDOWS_ELECTRON_SMOKE_REFRESH_FAILED");
    }
    return false;
  }, MAX_REFRESH_MS, "synthetic refresh");
  // A completed refresh must still be renderable by the dashboard after the
  // data pass, not merely accepted by the mutation endpoint.
  await connection.cdp.evaluate("location.reload()");
  await waitFor(
    () => connection.cdp.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"),
    MAX_STARTUP_MS,
    "dashboard refresh render",
  );
}

async function runSmoke() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    printAggregate(aggregate("unsupported"));
    return;
  }
  const executable = resolve(process.env.TIBOTATTLE_ELECTRON_EXE ?? DEFAULT_EXECUTABLE);
  const artifactRoot = dirname(executable);
  const fixture = await createSyntheticFixture();
  let primary = null;
  let second = null;
  let connection = null;
  const result = {};
  try {
    await assertWindowsExecutable(executable);
    result.artifact = true;
    const primaryPort = await freeTcpPort();
    primary = spawnPackagedElectron(executable, fixture, primaryPort, artifactRoot);
    if (!primary.pid) fail("WINDOWS_ELECTRON_SMOKE_PRIMARY_PID_MISSING");
    const nextPrimaryLine = controlReader(primary);
    const initialState = await waitFor(
      () => command(primary, nextPrimaryLine, "status-v1").catch(() => null),
      MAX_STARTUP_MS,
      "primary shell status",
    );
    if (!initialState.started || !initialState.primary || !initialState.window || !initialState.tray) {
      fail("WINDOWS_ELECTRON_SMOKE_PRIMARY_STATE_INVALID");
    }
    connection = await dashboardConnection(primary, primaryPort);
    const primaryDescendantPids = await captureDescendantPids(primary.pid);
    result.dashboardReady = true;

    const hidden = await command(primary, nextPrimaryLine, "tray-hide-v1");
    const shown = await command(primary, nextPrimaryLine, "tray-show-v1");
    const toggledHidden = await command(primary, nextPrimaryLine, "tray-toggle-v1");
    const toggledShown = await command(primary, nextPrimaryLine, "tray-toggle-v1");
    if (!hidden.tray || hidden.visible || !shown.visible || !toggledHidden.tray
        || toggledHidden.visible || !toggledShown.visible) {
      fail("WINDOWS_ELECTRON_SMOKE_WINDOW_TRAY_LIFECYCLE_FAILED");
    }
    result.showHideTrayLifecycle = true;

    await runSyntheticRefresh(connection);
    result.syntheticRefresh = true;

    const secondPort = await freeTcpPort();
    second = spawnPackagedElectron(executable, fixture, secondPort, artifactRoot);
    await withTimeout(childExitPromise(second), MAX_SHUTDOWN_MS, "second instance rejection");
    if (second.exitCode !== 0 || second.signalCode !== null) {
      fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_NOT_REJECTED");
    }
    const secondDescendantPids = await captureDescendantPids(
      second.pid,
      { requireNonEmpty: false },
    );
    if (secondDescendantPids.size > 0) {
      await waitForDescendantsGone(
        second.pid,
        secondDescendantPids,
        "second instance descendant cleanup",
      );
    }
    result.secondInstanceRejected = true;

    // Capture once more after refresh and the second-instance attempt. This
    // includes helpers created after initial dashboard readiness. A final
    // post-exit capture below also catches any Windows child whose recorded
    // parent is the now-terminated primary process.
    await addCurrentDescendants(primary.pid, primaryDescendantPids);

    if (!primary.stdin?.write("quit-v1\n")) fail("WINDOWS_ELECTRON_SMOKE_QUIT_UNAVAILABLE");
    await nextPrimaryLine(
      (line) => line === "TIBOTATTLE_ELECTRON_SMOKE_QUIT_ACCEPTED",
      "primary clean quit acknowledgement",
    );
    await withTimeout(childExitPromise(primary), MAX_SHUTDOWN_MS, "primary clean quit");
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
    result.cleanQuit = true;
    // The companion is launched by the Electron process and should disappear
    // with it. A relaunch against the same profile proves that the old process
    // released its single-instance lock and did not leave a child holding it.
    const relaunchPort = await freeTcpPort();
    const relaunch = spawnPackagedElectron(executable, fixture, relaunchPort, artifactRoot);
    if (!relaunch.pid) fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_PID_MISSING");
    const nextRelaunchLine = controlReader(relaunch);
    try {
      const state = await waitFor(
        () => command(relaunch, nextRelaunchLine, "status-v1").catch(() => null),
        MAX_STARTUP_MS,
        "relaunch shell status",
      );
      if (!state.started || !state.primary || !state.tray) {
        fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_STATE_INVALID");
      }
      const relaunched = await dashboardConnection(relaunch, relaunchPort);
      const relaunchDescendantPids = await captureDescendantPids(relaunch.pid);
      relaunched.cdp.close();
      if (!relaunch.stdin?.write("quit-v1\n")) {
        fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_QUIT_UNAVAILABLE");
      }
      await nextRelaunchLine(
        (line) => line === "TIBOTATTLE_ELECTRON_SMOKE_QUIT_ACCEPTED",
        "relaunch clean quit acknowledgement",
      );
      await withTimeout(childExitPromise(relaunch), MAX_SHUTDOWN_MS, "relaunch clean quit");
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
      result.noOrphan = primaryNoOrphan && relaunchNoOrphan;
    } finally {
      await terminateProcessTree(relaunch);
    }
    result.relaunchPersistence = true;
    printAggregate(aggregate("passed", result));
  } finally {
    connection?.cdp.close();
    await terminateProcessTree(second);
    await terminateProcessTree(primary);
    await rm(fixture.root, { recursive: true, force: true });
  }
}

try {
  await runSmoke();
} catch {
  // Never expose executable paths, child diagnostics, account values, or
  // filesystem contents. The aggregate is the only supported smoke output.
  printAggregate(aggregate("failed"));
  process.exitCode = 1;
}
