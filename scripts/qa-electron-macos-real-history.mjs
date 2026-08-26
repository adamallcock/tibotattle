#!/usr/bin/env node

/**
 * Qualify a packaged macOS Electron app against a real, caller-selected
 * Codex history while keeping the qualification receipt content-free.
 *
 * This is deliberately separate from the synthetic macOS smoke.  The profile
 * is isolated but persistent: the caller supplies it, this script creates the
 * private app state beneath it, and no teardown removes it.  That lets the
 * relaunch mode prove that a terminal real-history result remains usable on a
 * subsequent app launch.
 *
 * Modes:
 *   cancel   startup refresh -> advancing timer/control-plane gate -> cancel -> retry -> cancel
 *   full     startup refresh -> real Usage/Community parity -> clean quit
 *   relaunch full pass -> clean quit -> persisted dashboard -> new refresh
 *
 * No raw history, paths, refresh IDs, URLs, account identifiers, or renderer
 * text are written to the receipt.  The selected app/profile paths are used
 * only as process inputs and are never serialized.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const REQUIRED_APP_NAME = "TiboTattle Dev";
const REAL_HISTORY_SCHEMA_VERSION = "tibotattle-electron-macos-real-history-v1";
const FIRST_RUN_SCHEMA_VERSION = "tibotattle-desktop-first-run-v1";
const SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v1";
const QUIT_CONTROL = "quit-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const REAL_HISTORY_QA_MODES = Object.freeze(["cancel", "full", "relaunch"]);
export const REAL_HISTORY_QA_TIMEOUTS = Object.freeze({
  operationMs: 10_000,
  startupMs: 60_000,
  healthMs: 10_000,
  timerMs: 30_000,
  controlPlaneMs: 10_000,
  cancelMs: 45_000,
  retryMs: 15_000,
  uiMs: 30_000,
  refreshMs: 125 * 60_000,
  quitMs: 15_000,
});

// The loopback control plane is intentionally independent of the dashboard
// snapshot. A response that takes longer than this while the refresh is still
// running is user-visible as a frozen counter/cancel button, even when the
// eventual refresh result is correct. Keep this threshold separate from the
// much longer work/terminal budgets below.
export const REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS = 3_000;
const CONTROL_PLANE_MIN_SAMPLES = 3;
const CONTROL_PLANE_SAMPLE_INTERVAL_MS = 500;

const DEGRADED_FAILURE_CODES = new Set([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
]);

const FAILURE_STAGES = new Set([
  "input",
  "launch",
  "dashboard",
  "health",
  "refresh",
  "cancel",
  "parity",
  "relaunch",
  "quit",
]);

const FAILURE_REASONS = new Set([
  "input_invalid",
  "app_invalid",
  "artifact_invalid",
  "launch_failed",
  "dashboard_unavailable",
  "health_unavailable",
  "refresh_not_started",
  "refresh_duplicate",
  "refresh_wrong_terminal",
  "refresh_degraded_invalid",
  "timer_stalled",
  "control_plane_unresponsive",
  "cancel_unavailable",
  "cancel_not_acknowledged",
  "cancel_http_invalid",
  "cancel_wrong_terminal",
  "retry_rejected",
  "usage_invalid",
  "community_invalid",
  "network_boundary_invalid",
  "relaunch_persistence_invalid",
  "relaunch_refresh_invalid",
  "quit_invalid",
  "runtime_failed",
]);

function qaError(code, stage, reason) {
  const error = new Error(code);
  error.code = code;
  error.qaStage = stage;
  error.qaReason = reason;
  return error;
}

function fail(code, stage, reason) {
  throw qaError(code, stage, reason);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(predicate, timeoutMs, label, intervalMs = 250) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await withTimeout(
        Promise.resolve().then(predicate),
        REAL_HISTORY_QA_TIMEOUTS.operationMs,
        `${label} operation`,
      );
      if (value) return value;
    } catch (error) {
      if (error?.qaStage || String(error?.code ?? "").startsWith("REAL_HISTORY_QA_")) {
        throw error;
      }
      lastError = error;
    }
    await wait(intervalMs);
  }
  void lastError;
  throw new Error(`${label} timed out`);
}

const REAL_HISTORY_LAUNCH_GATE = Object.freeze({
  code: "REAL_HISTORY_QA_LAUNCH_FAILED",
  stage: "launch",
  reason: "launch_failed",
});

const REAL_HISTORY_DASHBOARD_GATE = Object.freeze({
  code: "REAL_HISTORY_QA_DASHBOARD_UNAVAILABLE",
  stage: "dashboard",
  reason: "dashboard_unavailable",
});

function classifiedQaError(error) {
  return typeof error?.qaStage === "string"
    && FAILURE_STAGES.has(error.qaStage)
    && typeof error?.qaReason === "string"
    && FAILURE_REASONS.has(error.qaReason);
}

/**
 * Convert only an unclassified launch/setup error into a fixed QA error.
 * Never retain or expose the original error: these gates run around process,
 * CDP, and filesystem-adjacent operations whose messages can contain paths or
 * other machine-specific details.
 */
export async function runLaunchGate(operation, gate) {
  try {
    return await operation();
  } catch (error) {
    if (classifiedQaError(error)) throw error;
    fail(gate.code, gate.stage, gate.reason);
  }
}

export async function waitForLaunchGate(
  predicate,
  timeoutMs,
  label,
  gate,
  intervalMs = 250,
) {
  return runLaunchGate(
    () => waitFor(predicate, timeoutMs, label, intervalMs),
    gate,
  );
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && typeof argv[index + 1] === "string"
    ? argv[index + 1]
    : null;
}

/** Parse and validate the explicit, non-secret process inputs. */
export function parseRealHistoryArguments(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) return Object.freeze({ help: true });
  const known = new Set([
    "--app",
    "--profile",
    "--codex-home",
    "--mode",
    "--debug-port",
    "--receipt",
    "--artifact-sha256",
  ]);
  const seen = new Set();
  for (const [index, value] of argv.entries()) {
    if (value.startsWith("--") && !known.has(value)) {
      throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
    }
    if (known.has(value) && seen.has(value)) {
      throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
    }
    if (known.has(value)) seen.add(value);
    if (known.has(value) && typeof argv[index + 1] !== "string") {
      throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
    }
  }
  const appPath = argumentValue(argv, "--app");
  const profilePath = argumentValue(argv, "--profile");
  const codexHomePath = argumentValue(argv, "--codex-home");
  const mode = argumentValue(argv, "--mode") ?? "full";
  const debugPortText = argumentValue(argv, "--debug-port");
  const receiptPath = argumentValue(argv, "--receipt");
  const artifactSha256 = argumentValue(argv, "--artifact-sha256");
  const debugPort = debugPortText === null ? null : Number(debugPortText);
  if (!appPath || !profilePath || !codexHomePath
      || !REAL_HISTORY_QA_MODES.includes(mode)
      || !isAbsolute(appPath)
      || !isAbsolute(profilePath)
      || !isAbsolute(codexHomePath)
      || (receiptPath !== null && !isAbsolute(receiptPath))
      || !SHA256_PATTERN.test(artifactSha256 ?? "")
      || (debugPort !== null
        && (!Number.isSafeInteger(debugPort) || debugPort < 1024 || debugPort > 65_535))) {
    throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
  }
  const app = resolve(appPath);
  const profile = resolve(profilePath);
  const codexHome = resolve(codexHomePath);
  if (app === profile || profile === codexHome || app === codexHome) {
    throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
  }
  return Object.freeze({
    help: false,
    appPath: app,
    profilePath: profile,
    codexHomePath: codexHome,
    mode,
    debugPort,
    receiptPath: receiptPath === null ? null : resolve(receiptPath),
    artifactSha256,
  });
}

function ensureDirectoryInput(path, label) {
  return stat(path).then((metadata) => {
    if (!metadata.isDirectory()) throw qaError(
      "REAL_HISTORY_QA_INPUT_INVALID",
      "input",
      "input_invalid",
    );
    return true;
  }).catch((error) => {
    if (error?.code === "REAL_HISTORY_QA_INPUT_INVALID") throw error;
    void label;
    throw qaError("REAL_HISTORY_QA_INPUT_INVALID", "input", "input_invalid");
  });
}

async function assertAppInput(appPath) {
  if (!isAbsolute(appPath) || basename(appPath) !== `${REQUIRED_APP_NAME}.app`) {
    fail("REAL_HISTORY_QA_APP_INVALID", "input", "app_invalid");
  }
  const executable = join(appPath, "Contents", "MacOS", REQUIRED_APP_NAME);
  const asar = join(appPath, "Contents", "Resources", "app.asar");
  const [bundle, executableMetadata, asarMetadata] = await Promise.all([
    stat(appPath).catch(() => null),
    stat(executable).catch(() => null),
    stat(asar).catch(() => null),
  ]);
  if (!bundle?.isDirectory?.() || !executableMetadata?.isFile?.() || !asarMetadata?.isFile?.()) {
    fail("REAL_HISTORY_QA_APP_INVALID", "input", "app_invalid");
  }
  try {
    const description = execFileSync("file", [executable], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!/\barm64\b/u.test(description)) {
      fail("REAL_HISTORY_QA_APP_INVALID", "input", "app_invalid");
    }
  } catch (error) {
    if (error?.code === "REAL_HISTORY_QA_APP_INVALID") throw error;
    fail("REAL_HISTORY_QA_APP_INVALID", "input", "app_invalid");
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

/**
 * Bind the qualification to the exact packaged app that will be launched.
 * The caller supplies the artifact-verifier digest, but this helper computes
 * the digest from the app's own app.asar before launch; a copied or stale
 * expected value therefore cannot produce an identity-bound receipt.
 */
export async function verifyPackagedArtifactIdentity(appPath, expectedSha256) {
  if (!isAbsolute(appPath) || !SHA256_PATTERN.test(expectedSha256 ?? "")) {
    fail("REAL_HISTORY_QA_ARTIFACT_INVALID", "input", "artifact_invalid");
  }
  const asar = join(appPath, "Contents", "Resources", "app.asar");
  let before;
  let after;
  let observedSha256;
  try {
    before = await stat(asar, { bigint: true });
    if (!before.isFile()) {
      fail("REAL_HISTORY_QA_ARTIFACT_INVALID", "input", "artifact_invalid");
    }
    observedSha256 = await sha256File(asar);
    after = await stat(asar, { bigint: true });
  } catch (error) {
    if (error?.qaStage === "input") throw error;
    fail("REAL_HISTORY_QA_ARTIFACT_INVALID", "input", "artifact_invalid");
  }
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    fail("REAL_HISTORY_QA_ARTIFACT_INVALID", "input", "artifact_invalid");
  }
  if (observedSha256 !== expectedSha256) {
    fail("REAL_HISTORY_QA_ARTIFACT_MISMATCH", "input", "artifact_invalid");
  }
  return observedSha256;
}

async function writeIfMissing(path, value) {
  try {
    await access(path);
  } catch {
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

/** Create only private app-owned directories; never remove the profile. */
async function prepareProfile(profilePath, codexHomePath) {
  const userData = join(profilePath, "user-data");
  const settings = join(userData, "desktop-settings");
  const roots = Object.freeze({
    home: join(profilePath, "home"),
    claude: join(profilePath, "claude"),
    state: join(profilePath, "state"),
    config: join(profilePath, "config"),
    data: join(profilePath, "data"),
    cache: join(profilePath, "cache"),
    runtime: join(profilePath, "runtime"),
    tmp: join(profilePath, "tmp"),
  });
  const directories = [profilePath, userData, settings, ...Object.values(roots)];
  await Promise.all(directories.map(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }));
  await writeIfMissing(join(settings, "desktop-first-run-v1.json"), {
    schemaVersion: FIRST_RUN_SCHEMA_VERSION,
    acknowledged: true,
  });
  await writeIfMissing(join(settings, "desktop-settings-v1.json"), {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    codexHome: { mode: "custom", path: codexHomePath },
    language: "system",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
    sidebarCollapsed: false,
  });
  return Object.freeze({ userData, settings, roots });
}

function environmentForProfile(fixture, codexHomePath) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    HOME: fixture.roots.home,
    TMPDIR: fixture.roots.tmp,
    CODEX_HOME: codexHomePath,
    CLAUDE_CONFIG_DIR: fixture.roots.claude,
    XDG_CONFIG_HOME: fixture.roots.config,
    XDG_DATA_HOME: fixture.roots.data,
    XDG_CACHE_HOME: fixture.roots.cache,
    XDG_RUNTIME_DIR: fixture.roots.runtime,
    USAGE_MONITOR_STATE_ROOT: fixture.roots.state,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: QUIT_CONTROL,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  }).filter(([, value]) => value !== undefined));
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
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    fail("REAL_HISTORY_QA_PORT_INVALID", "launch", "launch_failed");
  }
  return port;
}

async function fetchJson(url, timeoutMs = REAL_HISTORY_QA_TIMEOUTS.operationMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "X-Usage-Monitor-Local": "1" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isExactDashboardTarget(target, debugPort) {
  if (target?.type !== "page"
      || typeof target.url !== "string"
      || typeof target.webSocketDebuggerUrl !== "string") return false;
  try {
    const page = new URL(target.url);
    const socket = new URL(target.webSocketDebuggerUrl);
    return page.protocol === "http:"
      && page.hostname === "127.0.0.1"
      && page.port.length > 0
      && page.pathname === "/"
      && page.search === ""
      && page.hash === ""
      && page.username === ""
      && page.password === ""
      && socket.protocol === "ws:"
      && socket.hostname === "127.0.0.1"
      && socket.port === String(debugPort)
      && socket.pathname.startsWith("/devtools/page/");
  } catch {
    return false;
  }
}

/**
 * A CDP evaluation can return a perfectly valid-looking object while the
 * dashboard is still booting.  Keep polling until the renderer has published
 * the same readiness contract as the macOS smoke: the ready marker, the
 * product title, a rendered overview heading, and the exact loopback root for
 * this target.  The location check also prevents a Settings/recovery/hash
 * navigation from being accepted as the dashboard document.
 */
export function realHistoryDashboardReadySnapshotValid(snapshot, expectedOrigin) {
  if (snapshot === null
      || typeof snapshot !== "object"
      || Array.isArray(snapshot)
      || snapshot.ready !== true
      || snapshot.title !== "TiboTattle"
      || typeof snapshot.heading !== "string"
      || snapshot.heading.trim().length === 0
      || typeof snapshot.location !== "string"
      || typeof expectedOrigin !== "string") {
    return false;
  }
  try {
    const location = new URL(snapshot.location);
    return location.protocol === "http:"
      && location.hostname === "127.0.0.1"
      && location.origin === expectedOrigin
      && location.pathname === "/"
      && location.search === ""
      && location.hash === ""
      && location.username === ""
      && location.password === "";
  } catch {
    return false;
  }
}

/**
 * The real-history harness opts into the same preload-controlled startup gate
 * as the macOS smoke so Network.enable can attach before the first refresh.
 * Release it exactly once after binding the active dashboard loader.  Keep the
 * bridge shape closed and return no bridge data to the receipt.
 */
export async function releaseRealHistoryRefreshGate(cdp) {
  const released = await runLaunchGate(() => cdp.evaluate(`(() => {
    const bridge = globalThis.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__;
    if (bridge === null
        || typeof bridge !== "object"
        || Array.isArray(bridge)
        || bridge.version !== "v1"
        || Object.isFrozen(bridge) !== true
        || Object.keys(bridge).length !== 3
        || typeof bridge.waitForStartupRefresh !== "function"
        || typeof bridge.releaseStartupRefresh !== "function") {
      return false;
    }
    try {
      return bridge.releaseStartupRefresh() === true;
    } catch {
      return false;
    }
  })()`), REAL_HISTORY_DASHBOARD_GATE);
  if (released !== true) {
    fail("REAL_HISTORY_QA_REFRESH_NOT_STARTED", "refresh", "refresh_not_started");
  }
  return true;
}

class CdpConnection {
  constructor(target) {
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.pending = new Map();
    this.handlers = new Map();
    this.nextId = 1;
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!Number.isInteger(message.id)) {
        for (const handler of this.handlers.get(message.method) ?? []) {
          handler(message.params ?? {});
        }
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error("CDP request failed"));
      else request.resolve(message.result ?? {});
    });
  }

  async open() {
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => rejectOpen(new Error("CDP connection failed")), {
        once: true,
      });
    }), REAL_HISTORY_QA_TIMEOUTS.operationMs, "CDP connection");
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return withTimeout(result, REAL_HISTORY_QA_TIMEOUTS.operationMs, `CDP ${method}`);
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error("renderer evaluation failed");
    return response.result?.value;
  }

  on(method, handler) {
    let handlers = this.handlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(method);
    };
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Best effort once the app is quitting.
    }
    for (const request of this.pending.values()) request.reject(new Error("CDP closed"));
    this.pending.clear();
    this.handlers.clear();
  }
}

export function createRefreshObserver(cdp) {
  const requests = [];
  let origin = null;
  let loaderId = null;
  let sealed = false;
  const unsubscribe = cdp.on("Network.requestWillBeSent", ({ request, loaderId: eventLoader } = {}) => {
    if (sealed || request?.method !== "POST" || typeof request.url !== "string") return;
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:"
        || parsed.hostname !== "127.0.0.1"
        || parsed.pathname !== "/api/local/refresh") return;
    requests.push({
      origin: parsed.origin,
      loaderId: typeof eventLoader === "string" ? eventLoader : null,
    });
  });
  return Object.freeze({
    select({ expectedOrigin, expectedLoaderId }) {
      origin = expectedOrigin;
      loaderId = expectedLoaderId;
      const retained = requests.filter((entry) => entry.origin === origin
        && entry.loaderId === loaderId);
      requests.length = 0;
      requests.push(...retained);
    },
    snapshot() {
      if (!origin || !loaderId) return [];
      return requests.filter((entry) => entry.origin === origin && entry.loaderId === loaderId);
    },
    reset() {
      requests.length = 0;
      sealed = false;
    },
    seal() {
      sealed = true;
    },
    dispose() {
      unsubscribe();
    },
  });
}

/**
 * Observe the app's own loopback control-plane responses without retaining
 * response bodies. This is deliberately separate from the startup refresh
 * observer: the latter proves one exact POST, while this observer proves that
 * the renderer can still reach health/status/cancel while accounting runs.
 */
export function createControlPlaneObserver(cdp, expectedOrigin) {
  const pending = new Map();
  const completed = [];
  let sealed = false;
  const allowedPaths = new Set([
    "/api/local/health",
    "/api/local/refresh",
    "/api/local/refresh/cancel",
  ]);
  const requestId = (value) => typeof value === "string" && value.length > 0
    ? value
    : null;
  const routeFor = (url) => {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:"
          || parsed.hostname !== "127.0.0.1"
          || parsed.origin !== expectedOrigin
          || !allowedPaths.has(parsed.pathname)
          || parsed.search !== ""
          || parsed.hash !== "") return null;
      return parsed.pathname;
    } catch {
      return null;
    }
  };
  const onRequest = ({ requestId: eventRequestId, request } = {}) => {
    if (sealed) return;
    const id = requestId(eventRequestId);
    const path = routeFor(request?.url);
    if (id === null || path === null
        || !["GET", "POST"].includes(request?.method)) return;
    pending.set(id, {
      method: request.method,
      path,
      startedAt: Date.now(),
    });
  };
  const complete = (id, status = null) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    completed.push(Object.freeze({
      method: entry.method,
      path: entry.path,
      status: Number.isSafeInteger(status) ? status : null,
      latencyMs: Math.max(0, Date.now() - entry.startedAt),
    }));
  };
  const onResponse = ({ requestId: eventRequestId, response } = {}) => {
    const id = requestId(eventRequestId);
    if (id !== null) complete(id, response?.status);
  };
  const onFailure = ({ requestId: eventRequestId } = {}) => {
    const id = requestId(eventRequestId);
    if (id !== null) complete(id);
  };
  const unsubscribeRequest = cdp.on("Network.requestWillBeSent", onRequest);
  const unsubscribeResponse = cdp.on("Network.responseReceived", onResponse);
  const unsubscribeFailure = cdp.on("Network.loadingFailed", onFailure);
  return Object.freeze({
    snapshot() {
      return completed.slice();
    },
    reset() {
      pending.clear();
      completed.length = 0;
      sealed = false;
    },
    seal() {
      sealed = true;
      pending.clear();
    },
    dispose() {
      unsubscribeRequest();
      unsubscribeResponse();
      unsubscribeFailure();
      pending.clear();
      completed.length = 0;
      sealed = true;
    },
  });
}

function createNetworkBoundaryObserver(cdp, expectedOrigin) {
  let invalid = false;
  const unsubscribe = cdp.on("Network.requestWillBeSent", ({ request } = {}) => {
    if (typeof request?.url !== "string") return;
    try {
      const parsed = new URL(request.url);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:")
          && parsed.origin !== expectedOrigin) invalid = true;
    } catch {
      invalid = true;
    }
  });
  return () => {
    unsubscribe();
    return invalid;
  };
}

async function frameLoaderId(cdp) {
  const tree = await cdp.request("Page.getFrameTree");
  const value = tree?.frameTree?.frame?.loaderId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function descendantsOf(parentPid) {
  try {
    const rows = String(execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const children = new Map();
    for (const line of rows.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const result = [];
    const pending = [...(children.get(parentPid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.shift();
      result.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return result;
  } catch {
    return [];
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function capturedDescendantPidsValid(pids) {
  return Array.isArray(pids)
    && pids.length > 0
    && new Set(pids).size === pids.length
    && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export function capturedDescendantPidsGone(pids, isAlive = processAlive) {
  return capturedDescendantPidsValid(pids)
    && typeof isAlive === "function"
    && pids.every((pid) => isAlive(pid) === false);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(child.exitCode !== null || child.signalCode !== null);
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

async function waitForCapturedDescendantsGone(pids, timeoutMs) {
  if (!capturedDescendantPidsValid(pids)) return false;
  return waitFor(
    () => capturedDescendantPidsGone(pids),
    timeoutMs,
    "captured Electron companion cleanup",
  ).then(() => true).catch(() => false);
}

async function terminateProcessTree(child, capturedPids = []) {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch { /* best effort */ }
    await waitForChildExit(child, 5_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* best effort */ }
    await waitForChildExit(child, 5_000);
  }
  if (capturedDescendantPidsValid(capturedPids)) {
    for (const pid of capturedPids) {
      if (!processAlive(pid)) continue;
      try { process.kill(pid, "SIGTERM"); } catch { /* best effort */ }
    }
    if (!await waitForCapturedDescendantsGone(capturedPids, 5_000)) {
      for (const pid of capturedPids) {
        if (!processAlive(pid)) continue;
        try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
      }
      await waitForCapturedDescendantsGone(capturedPids, 5_000);
    }
  }
  return Object.freeze({
    rootExited: child.exitCode !== null || child.signalCode !== null,
    descendantsGone: capturedDescendantPidsValid(capturedPids)
      ? capturedDescendantPidsGone(capturedPids)
      : true,
  });
}

async function launchSession({ appPath, codexHomePath, fixture, debugPort }) {
  const executable = join(appPath, "Contents", "MacOS", REQUIRED_APP_NAME);
  const child = spawn(executable, [
    `--user-data-dir=${fixture.userData}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    "--disable-gpu",
  ], {
    cwd: join(appPath, "Contents", "Resources"),
    env: environmentForProfile(fixture, codexHomePath),
    stdio: "ignore",
  });
  child.on("error", () => {});
  if (!child.pid) fail("REAL_HISTORY_QA_LAUNCH_FAILED", "launch", "launch_failed");
  try {
    const version = await waitForLaunchGate(
      () => fetchJson(`http://127.0.0.1:${debugPort}/json/version`),
      REAL_HISTORY_QA_TIMEOUTS.startupMs,
      "Electron remote debugging",
      REAL_HISTORY_LAUNCH_GATE,
    );
    if (!version) fail("REAL_HISTORY_QA_LAUNCH_FAILED", "launch", "launch_failed");
    const target = await waitForLaunchGate(async () => {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      return Array.isArray(targets)
        ? targets.find((candidate) => isExactDashboardTarget(candidate, debugPort)) ?? null
        : null;
    }, REAL_HISTORY_QA_TIMEOUTS.startupMs, "Electron dashboard target", REAL_HISTORY_DASHBOARD_GATE);
    const dashboardUrl = await runLaunchGate(
      () => new URL(target.url),
      REAL_HISTORY_DASHBOARD_GATE,
    );
    const setup = await runLaunchGate(async () => {
      const cdp = new CdpConnection(target);
      await cdp.open();
      const observer = createRefreshObserver(cdp);
      const controlPlane = createControlPlaneObserver(cdp, dashboardUrl.origin);
      const takeNetworkBoundary = createNetworkBoundaryObserver(cdp, dashboardUrl.origin);
      await cdp.request("Page.enable");
      await cdp.request("Network.enable");
      return { cdp, observer, controlPlane, takeNetworkBoundary };
    }, REAL_HISTORY_DASHBOARD_GATE);
    const { cdp, observer, controlPlane, takeNetworkBoundary } = setup;
    const binding = await waitForLaunchGate(async () => {
      const loaderId = await frameLoaderId(cdp);
      const location = await cdp.evaluate("location.href");
      try {
        const parsed = new URL(location);
        return loaderId
          && parsed.origin === dashboardUrl.origin
          && parsed.hostname === "127.0.0.1"
          && parsed.pathname === "/"
          && parsed.search === ""
          && parsed.hash === ""
          ? { origin: parsed.origin, loaderId }
          : null;
      } catch {
        return null;
      }
    }, REAL_HISTORY_QA_TIMEOUTS.startupMs, "Electron dashboard binding", REAL_HISTORY_DASHBOARD_GATE);
    await runLaunchGate(
      () => observer.select({ expectedOrigin: binding.origin, expectedLoaderId: binding.loaderId }),
      REAL_HISTORY_DASHBOARD_GATE,
    );
    await releaseRealHistoryRefreshGate(cdp);
    const ready = await waitForLaunchGate(async () => {
      const snapshot = await cdp.evaluate(`(() => ({
      ready: document.documentElement?.dataset?.localDashboardReady === "true",
      title: document.title,
      heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
      location: location.href,
    }))()`);
      return realHistoryDashboardReadySnapshotValid(snapshot, dashboardUrl.origin)
        ? snapshot
        : null;
    }, REAL_HISTORY_QA_TIMEOUTS.startupMs, "Electron dashboard readiness", REAL_HISTORY_DASHBOARD_GATE);
    if (!realHistoryDashboardReadySnapshotValid(ready, dashboardUrl.origin)) {
      fail("REAL_HISTORY_QA_DASHBOARD_UNAVAILABLE", "dashboard", "dashboard_unavailable");
    }
    const readyLoader = await runLaunchGate(
      () => frameLoaderId(cdp),
      REAL_HISTORY_DASHBOARD_GATE,
    );
    if (readyLoader !== binding.loaderId) {
      fail("REAL_HISTORY_QA_REFRESH_BOUNDARY_INVALID", "refresh", "refresh_not_started");
    }
    return {
      child,
      cdp,
      observer,
      controlPlane,
      takeNetworkBoundary,
      dashboardUrl,
      debugPort,
    };
  } catch (error) {
    const capturedPids = descendantsOf(child.pid);
    await terminateProcessTree(child, capturedPids);
    throw error;
  }
}

async function closeSession(session, { signal = "SIGUSR2" } = {}) {
  const child = session.child;
  if (!capturedDescendantPidsValid(session.expectedDescendantPids)) {
    session.expectedDescendantPids = descendantsOf(child.pid);
  }
  const expectedDescendantPids = session.expectedDescendantPids;
  session.observer?.dispose?.();
  session.controlPlane?.dispose?.();
  session.cdp?.close?.();
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(signal); } catch { /* best effort */ }
    await waitForChildExit(child, REAL_HISTORY_QA_TIMEOUTS.quitMs);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch { /* best effort */ }
    await waitForChildExit(child, 5_000);
  }
  const descendantsGone = await waitForCapturedDescendantsGone(
    expectedDescendantPids,
    REAL_HISTORY_QA_TIMEOUTS.quitMs,
  );
  if (!descendantsGone) {
    await terminateProcessTree(child, expectedDescendantPids);
  }
  return Object.freeze({
    exited: child.exitCode !== null || child.signalCode !== null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    capturedDescendantCount: expectedDescendantPids.length,
    descendantsGone,
  });
}

async function dashboardHealth(session, required = true) {
  const healthUrl = new URL("/api/local/health", session.dashboardUrl);
  const health = await waitFor(
    () => fetchJson(healthUrl, REAL_HISTORY_QA_TIMEOUTS.healthMs),
    REAL_HISTORY_QA_TIMEOUTS.healthMs,
    "local companion health",
  ).catch(() => null);
  if (required && health?.status !== "ready") {
    fail("REAL_HISTORY_QA_HEALTH_UNAVAILABLE", "health", "health_unavailable");
  }
  // The local companion's fixed /api/health relay is a bounded, unauthenticated
  // GET to the configured central service. It does not send contribution data
  // or mutate pairing/consent state. Use only its fixed public liveness status;
  // keep the configured capability and live reachability as separate facts.
  let serviceHealth = null;
  if (health?.capabilities?.centralServiceProxy === true) {
    serviceHealth = await waitFor(
      () => fetchJson(new URL("/api/health", session.dashboardUrl), REAL_HISTORY_QA_TIMEOUTS.healthMs),
      REAL_HISTORY_QA_TIMEOUTS.healthMs,
      "contribution service health",
    ).catch(() => null);
  }
  const serviceReachability = health?.capabilities?.centralServiceProxy !== true
    ? "not_configured"
    : serviceHealth?.status === "ok" ? "ok" : "unavailable";
  return Object.freeze({
    ...health,
    serviceReachability,
    serviceReachabilityProven: serviceReachability === "ok",
  });
}

async function refreshStatus(session) {
  return fetchJson(
    new URL("/api/local/refresh", session.dashboardUrl),
    REAL_HISTORY_QA_TIMEOUTS.healthMs,
  );
}

async function fetchJsonMeasured(url, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  let body = null;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "X-Usage-Monitor-Local": "1" },
      signal: controller.signal,
    });
    status = response.status;
    if (response.ok) body = await response.json();
  } catch {
    // The bounded result below intentionally retains no transport/error text.
  } finally {
    clearTimeout(timer);
  }
  return Object.freeze({
    status,
    body,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
}

export function controlPlaneSnapshotValid(snapshot) {
  return snapshot?.active === true
    && Number.isSafeInteger(snapshot.sampleCount)
    && snapshot.sampleCount >= CONTROL_PLANE_MIN_SAMPLES
    && Number.isSafeInteger(snapshot.healthSuccessCount)
    && snapshot.healthSuccessCount >= CONTROL_PLANE_MIN_SAMPLES
    && snapshot.healthSuccessCount <= snapshot.sampleCount
    && Number.isSafeInteger(snapshot.refreshStatusSuccessCount)
    && snapshot.refreshStatusSuccessCount >= CONTROL_PLANE_MIN_SAMPLES
    && snapshot.refreshStatusSuccessCount <= snapshot.sampleCount
    && Number.isSafeInteger(snapshot.maxLatencyMs)
    && snapshot.maxLatencyMs >= 0
    && snapshot.maxLatencyMs <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS;
}

export function cancelHttpResponseValid(response) {
  return response?.method === "POST"
    && response?.path === "/api/local/refresh/cancel"
    && response?.status === 202
    && Number.isSafeInteger(response.latencyMs)
    && response.latencyMs >= 0
    && response.latencyMs <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS;
}

async function sampleControlPlane(session, expectedRefreshId) {
  const healthUrl = new URL("/api/local/health", session.dashboardUrl);
  const refreshUrl = new URL("/api/local/refresh", session.dashboardUrl);
  const requestTimeoutMs = REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS;
  const deadline = Date.now() + REAL_HISTORY_QA_TIMEOUTS.controlPlaneMs;
  let sampleCount = 0;
  let healthSuccessCount = 0;
  let refreshStatusSuccessCount = 0;
  let maxLatencyMs = 0;
  while (Date.now() < deadline) {
    const [health, status] = await Promise.all([
      fetchJsonMeasured(healthUrl, requestTimeoutMs),
      fetchJsonMeasured(refreshUrl, requestTimeoutMs),
    ]);
    sampleCount += 1;
    maxLatencyMs = Math.max(maxLatencyMs, health.latencyMs, status.latencyMs);
    if (health.status === 200 && health.body?.status === "ready") {
      healthSuccessCount += 1;
    }
    if (status.status === 200
        && status.body?.refresh?.refreshId === expectedRefreshId
        && ["running", "cancelling"].includes(status.body.refresh.status)) {
      refreshStatusSuccessCount += 1;
    }
    // A slow successful response is just as user-visible as a timeout. Fail
    // at the measured boundary rather than allowing a later fast sample to
    // hide the event-loop stall.
    if (health.latencyMs > REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS
        || status.latencyMs > REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS) {
      fail("REAL_HISTORY_QA_CONTROL_PLANE_UNRESPONSIVE", "refresh", "control_plane_unresponsive");
    }
    if (healthSuccessCount >= CONTROL_PLANE_MIN_SAMPLES
        && refreshStatusSuccessCount >= CONTROL_PLANE_MIN_SAMPLES) {
      const result = Object.freeze({
        active: true,
        sampleCount,
        healthSuccessCount,
        refreshStatusSuccessCount,
        maxLatencyMs,
      });
      if (!controlPlaneSnapshotValid(result)) {
        fail("REAL_HISTORY_QA_CONTROL_PLANE_UNRESPONSIVE", "refresh", "control_plane_unresponsive");
      }
      return result;
    }
    await wait(CONTROL_PLANE_SAMPLE_INTERVAL_MS);
  }
  fail("REAL_HISTORY_QA_CONTROL_PLANE_UNRESPONSIVE", "refresh", "control_plane_unresponsive");
}

async function waitCancelHttpResponse(session) {
  try {
    const response = await waitFor(() => {
      const entries = session.controlPlane.snapshot().filter(
        (entry) => entry.method === "POST"
          && entry.path === "/api/local/refresh/cancel",
      );
      if (entries.length > 1) {
        fail("REAL_HISTORY_QA_CANCEL_HTTP_INVALID", "cancel", "cancel_http_invalid");
      }
      return entries.length === 1 ? entries[0] : null;
    }, 8_000, "refresh cancellation HTTP response", 100);
    if (!cancelHttpResponseValid(response)) {
      fail("REAL_HISTORY_QA_CANCEL_HTTP_INVALID", "cancel", "cancel_http_invalid");
    }
    return Object.freeze({
      requestCount: 1,
      status: 202,
      latencyMs: response.latencyMs,
      accepted: true,
    });
  } catch (error) {
    if (error?.qaStage) throw error;
    fail("REAL_HISTORY_QA_CANCEL_HTTP_INVALID", "cancel", "cancel_http_invalid");
  }
}

function coherentDegraded(refresh) {
  const generation = refresh?.result?.unifiedIndex?.generation;
  const accounting = refresh?.result?.accounting;
  const reasonCount = Number.isSafeInteger(generation?.reasonCounts?.[refresh?.failureCode])
    ? generation.reasonCounts[refresh.failureCode]
    : null;
  return refresh?.status === "degraded"
    && refresh?.errorCode === "refresh_degraded"
    && refresh?.failedStep === "unified_index"
    && DEGRADED_FAILURE_CODES.has(refresh.failureCode)
    && refresh?.result?.unifiedIndex?.status === "ingested"
    && generation?.status === "partial"
    && generation?.blockReason === "codex_rollout_sources_quarantined"
    && Number.isSafeInteger(generation.skippedSourceCount)
    && generation.skippedSourceCount > 0
    && Number.isSafeInteger(generation.skippedThreadCount)
    && generation.skippedThreadCount > 0
    && reasonCount !== null
    && reasonCount > 0
    && generation.discoveryComplete === true
    && generation.diagnosticsComplete === true
    && generation.usageProvenanceComplete === true
    && generation.sourceOrderComplete === true
    && generation.quotaProvenanceComplete === true
    && accounting?.status === "replay_safe"
    && accounting.sourceMode === "unified"
    && accounting.coverageStatus === "partial"
    && accounting.generationMatched === true
    && accounting.fallbackCount === 0
    && accounting.diagnosticsAvailable === true;
}

export function classifyRealHistoryTerminal(refresh) {
  if (refresh?.status === "succeeded") return Object.freeze({
    accepted: true,
    terminalStatus: "succeeded",
    degradedFailureCode: null,
  });
  if (coherentDegraded(refresh)) return Object.freeze({
    accepted: true,
    terminalStatus: "degraded",
    degradedFailureCode: refresh.failureCode,
  });
  if (refresh?.status === "degraded") return Object.freeze({
    accepted: false,
    terminalStatus: "degraded",
    degradedFailureCode: null,
  });
  if (["failed", "cancelled"].includes(refresh?.status)) return Object.freeze({
    accepted: false,
    terminalStatus: refresh.status,
    degradedFailureCode: null,
  });
  return Object.freeze({ accepted: false, terminalStatus: null, degradedFailureCode: null });
}

async function waitForStartupRefresh(
  session,
  previousRefreshId = null,
  { sampleTimer = false } = {},
) {
  let refreshId = null;
  await waitFor(async () => {
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      fail("REAL_HISTORY_QA_REFRESH_NOT_STARTED", "refresh", "refresh_not_started");
    }
    const requests = session.observer.snapshot();
    if (requests.length === 0) return null;
    if (requests.length > 1) {
      fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "refresh", "refresh_duplicate");
    }
    const status = await refreshStatus(session);
    const candidate = status?.refresh;
    if (typeof candidate?.refreshId !== "string" || candidate.refreshId.length === 0) return null;
    if (candidate.refreshId === previousRefreshId) return null;
    if (!["running", "cancelling", "succeeded", "degraded"].includes(candidate.status)) return null;
    refreshId = candidate.refreshId;
    return true;
  }, REAL_HISTORY_QA_TIMEOUTS.refreshMs, "real-history startup refresh acceptance", 1_000);

  let timerResult = null;
  let timerError = null;
  const timerPromise = sampleTimer
    ? sampleAdvancingTimer(session).then((result) => {
      timerResult = result;
    }).catch((error) => {
      timerError = error;
    })
    : null;
  let terminal = null;
  let degradedFailureCode = null;
  try {
    await waitFor(async () => {
      const requests = session.observer.snapshot();
      if (requests.length !== 1) {
        fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "refresh", "refresh_duplicate");
      }
      const status = await refreshStatus(session);
      const refresh = status?.refresh;
      if (refresh?.refreshId !== refreshId) return null;
      const decision = classifyRealHistoryTerminal(refresh);
      if (!decision.terminalStatus) return null;
      if (!decision.accepted) {
        fail(
          decision.terminalStatus === "degraded"
            ? "REAL_HISTORY_QA_REFRESH_DEGRADED_INVALID"
            : "REAL_HISTORY_QA_REFRESH_WRONG_TERMINAL",
          "refresh",
          decision.terminalStatus === "degraded"
            ? "refresh_degraded_invalid"
            : "refresh_wrong_terminal",
        );
      }
      terminal = decision.terminalStatus;
      degradedFailureCode = decision.degradedFailureCode;
      return true;
    }, REAL_HISTORY_QA_TIMEOUTS.refreshMs, "real-history startup refresh completion", 2_000);
  } finally {
    if (timerPromise !== null) await timerPromise;
  }
  if (timerError !== null) throw timerError;
  session.observer.seal();
  return Object.freeze({
    requestCount: 1,
    refreshIdChanged: true,
    terminalStatus: terminal,
    degradedFailureCode,
    timer: timerResult,
    // Deliberately private: callers use it to fence relaunch IDs, but the
    // receipt builder below never copies it.
    refreshId,
  });
}

function elapsedSeconds(text) {
  const value = String(text ?? "");
  const minutes = /(?:^|\s)(\d+)m\s+(\d+)s(?:\s|$)/u.exec(value);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const seconds = /(?:^|\s|…)(\d+)s(?:\s|$)/u.exec(value);
  return seconds ? Number(seconds[1]) : null;
}

async function uiSnapshot(session) {
  return session.cdp.evaluate(`(() => {
    const refresh = document.querySelector("#refresh-button");
    const cancel = document.querySelector("#cancel-refresh");
    const latest = document.querySelector("#latest-observation")?.textContent?.trim() ?? "";
    const source = document.querySelector("#data-source")?.textContent?.trim() ?? "";
    return {
      ready: document.documentElement?.dataset?.localDashboardReady === "true",
      refreshText: refresh?.textContent?.replace(/\\s+/gu, " ").trim() ?? "",
      refreshDisabled: Boolean(refresh?.disabled),
      cancelHidden: Boolean(cancel?.hidden),
      cancelDisabled: Boolean(cancel?.disabled),
      dataFlow: latest.length > 0 && latest !== "Checking…"
        && source.toLowerCase().includes("local companion"),
    };
  })()`);
}

async function sampleAdvancingTimer(session) {
  const values = [];
  const deadline = Date.now() + REAL_HISTORY_QA_TIMEOUTS.timerMs;
  while (Date.now() < deadline && new Set(values).size < 5) {
    const snapshot = await uiSnapshot(session);
    const elapsed = elapsedSeconds(snapshot?.refreshText);
    if (elapsed !== null) values.push(elapsed);
    await wait(1_000);
  }
  const unique = [...new Set(values)];
  const advanced = unique.length >= 4 && unique.at(-1) - unique[0] >= 3;
  if (!advanced) fail("REAL_HISTORY_QA_TIMER_STALLED", "refresh", "timer_stalled");
  return Object.freeze({
    sampleCount: values.length,
    uniqueCount: unique.length,
    advanced: true,
  });
}

async function waitRefreshTerminal(session, expectedRefreshId, timeoutMs) {
  return waitFor(async () => {
    if (session.observer.snapshot().length !== 1) {
      fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "refresh", "refresh_duplicate");
    }
    const status = await refreshStatus(session);
    const refresh = status?.refresh;
    if (refresh?.refreshId !== expectedRefreshId) return null;
    return ["cancelled", "failed", "succeeded", "degraded"].includes(refresh.status)
      ? refresh
      : null;
  }, timeoutMs, "refresh terminal status", 1_000);
}

async function waitUiReleased(session) {
  return waitFor(async () => {
    const snapshot = await uiSnapshot(session);
    return snapshot?.refreshDisabled === false && snapshot?.cancelHidden === true;
  }, REAL_HISTORY_QA_TIMEOUTS.uiMs, "refresh UI release");
}

async function clickCancel(session) {
  const clicked = await session.cdp.evaluate(`(() => {
    const button = document.querySelector("#cancel-refresh");
    if (!button || button.hidden || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) fail("REAL_HISTORY_QA_CANCEL_UNAVAILABLE", "cancel", "cancel_unavailable");
}

async function waitCancelAcknowledged(session) {
  return waitFor(async () => {
    const [status, snapshot] = await Promise.all([
      refreshStatus(session),
      uiSnapshot(session),
    ]);
    return ["cancelling", "cancelled"].includes(status?.refresh?.status)
      || snapshot?.cancelDisabled === true
      ? true
      : null;
  }, 8_000, "refresh cancellation acknowledgement", 250);
}

async function runCancelMode(session) {
  const first = await waitFor(async () => {
    const requests = session.observer.snapshot();
    if (requests.length > 1) {
      fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "cancel", "refresh_duplicate");
    }
    if (requests.length !== 1) return null;
    const status = await refreshStatus(session);
    return status?.refresh?.status === "running"
      && typeof status.refresh.refreshId === "string"
      ? status.refresh
      : null;
  }, REAL_HISTORY_QA_TIMEOUTS.startupMs, "cancel mode refresh start");
  session.controlPlane.reset();
  const timer = await sampleAdvancingTimer(session);
  const controlPlane = await sampleControlPlane(session, first.refreshId);
  const cancelStartedAt = Date.now();
  await clickCancel(session);
  await waitCancelAcknowledged(session);
  const acknowledgedMs = Date.now() - cancelStartedAt;
  const cancelHttp = await waitCancelHttpResponse(session);
  const firstTerminal = await waitRefreshTerminal(
    session,
    first.refreshId,
    REAL_HISTORY_QA_TIMEOUTS.cancelMs,
  );
  if (firstTerminal.status !== "cancelled") {
    fail("REAL_HISTORY_QA_CANCEL_WRONG_TERMINAL", "cancel", "cancel_wrong_terminal");
  }
  const terminalMs = Date.now() - cancelStartedAt;
  await waitUiReleased(session);
  session.observer.reset();
  const retryClicked = await session.cdp.evaluate(`(() => {
    const button = document.querySelector("#refresh-button");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (retryClicked !== true) fail("REAL_HISTORY_QA_RETRY_REJECTED", "cancel", "retry_rejected");
  session.controlPlane.reset();
  const retry = await waitFor(async () => {
    const requests = session.observer.snapshot();
    if (requests.length > 1) {
      fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "cancel", "refresh_duplicate");
    }
    if (requests.length !== 1) return null;
    const status = await refreshStatus(session);
    return status?.refresh?.status === "running"
      && typeof status.refresh.refreshId === "string"
      && status.refresh.refreshId !== first.refreshId
      ? status.refresh
      : null;
  }, REAL_HISTORY_QA_TIMEOUTS.retryMs, "cancel mode retry");
  await wait(2_000);
  await clickCancel(session);
  await waitCancelAcknowledged(session);
  const retryCancelHttp = await waitCancelHttpResponse(session);
  const retryTerminal = await waitRefreshTerminal(
    session,
    retry.refreshId,
    REAL_HISTORY_QA_TIMEOUTS.cancelMs,
  );
  if (retryTerminal.status !== "cancelled") {
    fail("REAL_HISTORY_QA_CANCEL_WRONG_TERMINAL", "cancel", "cancel_wrong_terminal");
  }
  return Object.freeze({
    timer,
    controlPlane,
    cancel: Object.freeze({
      acknowledgedMs,
      terminalMs,
      terminalStatus: "cancelled",
      http: cancelHttp,
    }),
    retry: Object.freeze({
      newRefreshId: true,
      accepted: true,
      terminalStatus: "cancelled",
      cancelHttp: retryCancelHttp,
    }),
  });
}

function visibleInRenderer(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

async function assertDashboardData(session) {
  try {
    return await waitFor(async () => {
      const snapshot = await session.cdp.evaluate(`(() => {
        const latest = document.querySelector("#latest-observation")?.textContent?.trim() ?? "";
        const source = document.querySelector("#data-source")?.textContent?.trim() ?? "";
        return latest.length > 0 && latest !== "Checking…"
          && source.toLowerCase().includes("local companion")
          ? { populated: true }
          : null;
      })()`);
      return snapshot?.populated === true ? snapshot : null;
    }, REAL_HISTORY_QA_TIMEOUTS.uiMs, "real-history dashboard data");
  } catch {
    fail("REAL_HISTORY_QA_USAGE_INVALID", "parity", "usage_invalid");
  }
}

function meaningfulRows(rows, allowUnavailable = false) {
  return [...rows].filter((row) => {
    const text = row.textContent?.trim() ?? "";
    if (text.length === 0) return false;
    if (/(?:^|[^0-9])([1-9][0-9]*(?:[.,][0-9]+)?|0\.[0-9]+)/u.test(text)) return true;
    return allowUnavailable
      && (text.includes("—") || /not reported|not priced|unavailable|withheld/iu.test(text));
  }).length;
}

export function classifyAdvancedModuleText(value) {
  const text = String(value ?? "").trim();
  const placeholder = /\b(?:loading|preparing|checking)\b/iu.test(text);
  const explicitUnavailable = !placeholder
    && /no eligible|no .* (?:available|priced|reported)|unavailable|not available|insufficient|withheld|not reported|not priced/iu.test(text);
  const terminalEvidence = text.length > 0 && !placeholder;
  return Object.freeze({
    explicitContent: terminalEvidence,
    explicitUnavailable,
    placeholder,
    terminalEvidence,
  });
}

export function usageParitySnapshotValid(snapshot) {
  return snapshot?.route === "#accounting"
    && snapshot?.pageVisible === true
    && snapshot?.periodCount === 4
    && snapshot?.summaryCardCount >= 4
    && snapshot?.tokenCountRows >= 1
    && snapshot?.costContributionRows >= 1
    && snapshot?.modelIdentityRows >= 1
    && snapshot?.meaningfulTokenRows >= 1
    && snapshot?.meaningfulCostRows >= 1
    && snapshot?.meaningfulModelRows >= 1
    && Number.isSafeInteger(snapshot?.meaningfulModelMetricCells)
    && snapshot.meaningfulModelMetricCells >= 2
    && snapshot?.priceCoverage === true
    && snapshot?.advancedModuleShellCount === 3
    && snapshot?.advancedModulesExplicit === true
    && snapshot?.advancedModulesReady === true;
}

export function communityParitySnapshotValid(
  snapshot,
  health,
  { requirePartialDetail = false } = {},
) {
  return health?.capabilities?.contributionDevicePairing === true
    && health?.capabilities?.incrementalContributionSync === "telemetry-contribution-v1.0"
    && health?.serviceReachabilityProven === true
    && snapshot?.route === "#community"
    && snapshot?.pageVisible === true
    && snapshot?.journeyStageCount === 2
    && snapshot?.indexTerminal === true
    && snapshot?.indexDetail === true
    && (!requirePartialDetail || snapshot?.partialHistoryDetail === true)
    && snapshot?.googleButton === true
    && snapshot?.appleButton === true
    && snapshot?.googleButtonEnabled === true
    && snapshot?.appleButtonEnabled === true
    && snapshot?.currentLayout === true
    && snapshot?.noServiceCopy === false;
}

async function assertUsage(session) {
  const usage = await waitFor(async () => session.cdp.evaluate(`(() => {
    const visible = ${visibleInRenderer.toString()};
    const positiveNumber = (value) => {
      const matches = String(value ?? '').match(/(?:^|[^0-9])([1-9][0-9]*(?:[.,][0-9]+)?|0\\.[0-9]+)/u);
      return matches !== null && Number(matches[1].replace(',', '.')) > 0;
    };
    document.querySelector('[data-nav="method"]')?.click();
    const page = document.querySelector('#accounting[data-dashboard-page="method"]');
    const tokenRows = document.querySelectorAll('#accounting-component-counts .component-row');
    const costRows = document.querySelectorAll('#accounting-component-costs .component-row');
    const modelRows = [...document.querySelectorAll('#accounting-models > tr')]
      .filter((row) => row.querySelector(
        ':scope > .model-identity:not(.model-component-identity)',
      ));
    const modelMetricCells = modelRows.flatMap((row) => [...row.querySelectorAll(
      ':scope > .numeric-cell',
    )]);
    const advanced = [
      '#cache-switch-details',
      '#cache-reuse-outcome',
      '#cache-continuity-details',
    ].map((selector) => {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim() ?? '';
      const evidence = ${classifyAdvancedModuleText.toString()}(text);
      return {
        present: element !== null,
        visible: visible(element),
        ...evidence,
      };
    });
    return {
      route: location.hash,
      pageVisible: visible(page) && page?.inert !== true,
      periodCount: document.querySelectorAll('#accounting-period-controls [data-period]').length,
      summaryCardCount: document.querySelectorAll('#accounting-summary .metric-card').length,
      tokenCountRows: tokenRows.length,
      costContributionRows: costRows.length,
      modelIdentityRows: modelRows.length,
      meaningfulTokenRows: ${meaningfulRows.toString()}(tokenRows),
      meaningfulCostRows: ${meaningfulRows.toString()}(costRows, true),
      meaningfulModelRows: modelRows.filter((row) => [...row.querySelectorAll(
        ':scope > .numeric-cell',
      )].some((cell) => positiveNumber(cell.textContent))).length,
      meaningfulModelMetricCells: modelMetricCells.filter((cell) => positiveNumber(cell.textContent)).length,
      priceCoverage: visible(document.querySelector('#accounting-price-coverage'))
        && (document.querySelector('#accounting-price-coverage')?.textContent?.trim() ?? '').length > 0,
      advancedModuleShellCount: advanced.filter((item) => item.present).length,
      advancedModuleAvailableCount: advanced.filter((item) => item.present
        && item.visible && item.explicitContent && !item.explicitUnavailable).length,
      advancedModuleUnavailableCount: advanced.filter((item) => item.present
        && item.visible && item.explicitContent && item.explicitUnavailable).length,
      advancedModulesExplicit: advanced.length === 3 && advanced.every((item) =>
        item.present && item.visible && item.terminalEvidence),
      advancedModulesReady: advanced.length === 3 && advanced.every((item) =>
        item.present && item.visible && item.terminalEvidence),
    };
  })()`), REAL_HISTORY_QA_TIMEOUTS.uiMs, "real-history Usage parity");
  const valid = usageParitySnapshotValid(usage);
  if (!valid) fail("REAL_HISTORY_QA_USAGE_INVALID", "parity", "usage_invalid");
  return Object.freeze({
    pageVisible: true,
    periodCount: usage.periodCount,
    summaryCardCount: usage.summaryCardCount,
    tokenCountRows: usage.tokenCountRows,
    costContributionRows: usage.costContributionRows,
    modelIdentityRows: usage.modelIdentityRows,
    meaningfulTokenRows: usage.meaningfulTokenRows,
    meaningfulCostRows: usage.meaningfulCostRows,
    meaningfulModelRows: usage.meaningfulModelRows,
    meaningfulModelMetricCells: usage.meaningfulModelMetricCells,
    priceCoverage: usage.priceCoverage,
    advancedModuleShells: usage.advancedModuleShellCount === 3,
    advancedModulesAvailable: usage.advancedModuleAvailableCount,
    advancedModulesUnavailable: usage.advancedModuleUnavailableCount,
    advancedModulesExplicit: usage.advancedModulesExplicit,
    advancedModulesReady: usage.advancedModulesReady,
  });
}

async function assertCommunity(session, health, terminalStatus) {
  const community = await waitFor(async () => session.cdp.evaluate(`(() => {
    const visible = ${visibleInRenderer.toString()};
    document.querySelector('[data-nav="community"]')?.click();
    const page = document.querySelector('#community[data-dashboard-page="community"]');
    const pageText = page?.textContent?.toLowerCase() ?? '';
    const detail = document.querySelector('#journey-stage-index-detail')?.textContent?.trim() ?? '';
    return {
      route: location.hash,
      pageVisible: visible(page) && page?.inert !== true,
      journeyStageCount: document.querySelectorAll('#community-journey .journey-stage').length,
      indexTerminal: document.querySelector('#journey-stage-index')?.classList?.contains('journey-stage-done') === true,
      indexDetail: detail.length > 0,
      partialHistoryDetail: /partial|quarantined/iu.test(detail),
      googleButton: visible(document.querySelector('#identity-google-signin')),
      appleButton: visible(document.querySelector('#identity-apple-signin')),
      googleButtonEnabled: (() => {
        const button = document.querySelector('#identity-google-signin');
        return visible(button) && button.disabled !== true;
      })(),
      appleButtonEnabled: (() => {
        const button = document.querySelector('#identity-apple-signin');
        return visible(button) && button.disabled !== true;
      })(),
      currentLayout: visible(document.querySelector('#identity-signin-next'))
        && (document.querySelector('#identity-signin-next')?.textContent?.trim() ?? '').length > 0
        && visible(document.querySelector('#incremental-consent'))
        && (document.querySelector('#incremental-consent')?.textContent?.trim() ?? '').length > 0,
      noServiceCopy: pageText.includes('no contribution service'),
    };
  })()`), REAL_HISTORY_QA_TIMEOUTS.uiMs, "real-history Community parity");
  const valid = communityParitySnapshotValid(community, health, {
    requirePartialDetail: terminalStatus === "degraded",
  });
  if (!valid) fail("REAL_HISTORY_QA_COMMUNITY_INVALID", "parity", "community_invalid");
  return Object.freeze({
    pageVisible: true,
    serviceConfigured: true,
    serviceReachability: "ok",
    serviceReachabilityProven: true,
    journeyStageCount: community.journeyStageCount,
    currentLayout: true,
    providerControls: true,
    providerControlsEnabled: community.googleButtonEnabled === true
      && community.appleButtonEnabled === true,
    indexTerminal: true,
    partialHistoryDetail: community.partialHistoryDetail,
  });
}

async function assertParity(session, startup) {
  const dashboard = await assertDashboardData(session);
  const health = await dashboardHealth(session);
  const usage = await assertUsage(session);
  const community = await assertCommunity(session, health, startup.terminalStatus);
  return Object.freeze({ dashboard, usage, community });
}

async function cleanQuit(session) {
  const result = await closeSession(session);
  if (result.exited !== true
      || result.capturedDescendantCount < 1
      || result.descendantsGone !== true
      || result.exitCode !== 0) {
    fail("REAL_HISTORY_QA_QUIT_INVALID", "quit", "quit_invalid");
  }
  return Object.freeze({ clean: true, descendantsGone: true });
}

export function buildRealHistoryReceipt({
  mode = "full",
  status = "failed",
  cleanQuit = false,
  timer = {},
  startup = {},
  parity = {},
  controlPlane = {},
  cancel = {},
  retry = {},
  relaunch = {},
  artifactSha256 = null,
  artifactIdentityVerified = false,
  failureStage = null,
  failureReason = null,
} = {}) {
  const acceptedMode = REAL_HISTORY_QA_MODES.includes(mode) ? mode : "full";
  const passed = status === "passed";
  const identityBound = artifactIdentityVerified === true
    && SHA256_PATTERN.test(artifactSha256 ?? "");
  const controlPlaneValid = controlPlaneSnapshotValid(controlPlane);
  const boundedLatency = (value) => Number.isSafeInteger(value)
      && value >= 0
      && value <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS
    ? value
    : 0;
  const validLatency = (value) => Number.isSafeInteger(value)
      && value >= 0
      && value <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS;
  const cancelHttp = {
    requestCount: cancel.http?.requestCount === 1 ? 1 : 0,
    status: cancel.http?.status === 202 ? 202 : 0,
    latencyMs: boundedLatency(cancel.http?.latencyMs),
    accepted: cancel.http?.requestCount === 1
      && cancel.http?.status === 202
      && cancel.http?.accepted === true
      && validLatency(cancel.http?.latencyMs),
  };
  const retryCancelHttp = {
    requestCount: retry.cancelHttp?.requestCount === 1 ? 1 : 0,
    status: retry.cancelHttp?.status === 202 ? 202 : 0,
    latencyMs: boundedLatency(retry.cancelHttp?.latencyMs),
    accepted: retry.cancelHttp?.requestCount === 1
      && retry.cancelHttp?.status === 202
      && retry.cancelHttp?.accepted === true
      && validLatency(retry.cancelHttp?.latencyMs),
  };
  return Object.freeze({
    schemaVersion: REAL_HISTORY_SCHEMA_VERSION,
    status: passed ? "passed" : "failed",
    mode: acceptedMode,
    target: "darwin-arm64-electron-app",
    qualification: "development-real-history",
    artifact: Object.freeze({
      sha256: identityBound ? artifactSha256 : null,
      identityBound,
    }),
    profileIsolated: true,
    contentFree: true,
    cleanQuit: cleanQuit === true,
    failureStage: !passed && FAILURE_STAGES.has(failureStage) ? failureStage : null,
    failureReason: !passed && FAILURE_REASONS.has(failureReason)
      ? failureReason
      : !passed ? "runtime_failed" : null,
    timer: Object.freeze({
      sampleCount: Number.isInteger(timer.sampleCount) ? timer.sampleCount : 0,
      uniqueCount: Number.isInteger(timer.uniqueCount) ? timer.uniqueCount : 0,
      advanced: timer.advanced === true,
    }),
    startupRefresh: Object.freeze({
      requestCount: Number.isInteger(startup.requestCount) ? startup.requestCount : 0,
      refreshIdChanged: startup.refreshIdChanged === true,
      terminalStatus: ["succeeded", "degraded"].includes(startup.terminalStatus)
        ? startup.terminalStatus
        : "unknown",
      degradedFailureCode: startup.terminalStatus === "degraded"
          && DEGRADED_FAILURE_CODES.has(startup.degradedFailureCode)
        ? startup.degradedFailureCode
        : null,
    }),
    controlPlane: Object.freeze({
      active: controlPlaneValid,
      sampleCount: controlPlaneValid ? controlPlane.sampleCount : 0,
      healthSuccessCount: controlPlaneValid ? controlPlane.healthSuccessCount : 0,
      refreshStatusSuccessCount: controlPlaneValid
        ? controlPlane.refreshStatusSuccessCount : 0,
      maxLatencyMs: controlPlaneValid ? controlPlane.maxLatencyMs : 0,
    }),
    parity: Object.freeze({
      dashboardPopulated: parity.dashboard?.populated === true,
      usage: Object.freeze({
        pageVisible: parity.usage?.pageVisible === true,
        periodCount: Number.isInteger(parity.usage?.periodCount) ? parity.usage.periodCount : 0,
        summaryCardCount: Number.isInteger(parity.usage?.summaryCardCount)
          ? parity.usage.summaryCardCount : 0,
        meaningfulTokenRows: Number.isInteger(parity.usage?.meaningfulTokenRows)
          ? parity.usage.meaningfulTokenRows : 0,
        meaningfulCostRows: Number.isInteger(parity.usage?.meaningfulCostRows)
          ? parity.usage.meaningfulCostRows : 0,
        meaningfulModelRows: Number.isInteger(parity.usage?.meaningfulModelRows)
          ? parity.usage.meaningfulModelRows : 0,
        meaningfulModelMetricCells: Number.isInteger(parity.usage?.meaningfulModelMetricCells)
          ? parity.usage.meaningfulModelMetricCells : 0,
        advancedModulesExplicit: parity.usage?.advancedModulesExplicit === true,
        advancedModulesAvailable: Number.isInteger(parity.usage?.advancedModulesAvailable)
          ? parity.usage.advancedModulesAvailable : 0,
        advancedModulesUnavailable: Number.isInteger(parity.usage?.advancedModulesUnavailable)
          ? parity.usage.advancedModulesUnavailable : 0,
        advancedModulesReady: parity.usage?.advancedModulesReady === true,
      }),
      community: Object.freeze({
        pageVisible: parity.community?.pageVisible === true,
        serviceConfigured: parity.community?.serviceConfigured === true,
        serviceReachability: ["ok", "unavailable", "not_configured"].includes(
          parity.community?.serviceReachability,
        ) ? parity.community.serviceReachability : "unknown",
        serviceReachabilityProven: parity.community?.serviceReachabilityProven === true,
        currentLayout: parity.community?.currentLayout === true,
        providerControlsEnabled: parity.community?.providerControlsEnabled === true,
        indexTerminal: parity.community?.indexTerminal === true,
        partialHistoryDetail: parity.community?.partialHistoryDetail === true,
      }),
    }),
    cancel: Object.freeze({
      acknowledgedMs: Number.isSafeInteger(cancel.acknowledgedMs) ? cancel.acknowledgedMs : 0,
      terminalMs: Number.isSafeInteger(cancel.terminalMs) ? cancel.terminalMs : 0,
      terminalStatus: cancel.terminalStatus === "cancelled" ? "cancelled" : "unknown",
      http: Object.freeze(cancelHttp),
    }),
    retry: Object.freeze({
      newRefreshId: retry.newRefreshId === true,
      accepted: retry.accepted === true,
      terminalStatus: retry.terminalStatus === "cancelled" ? "cancelled" : "unknown",
      cancelHttp: Object.freeze(retryCancelHttp),
    }),
    relaunch: Object.freeze({
      persistedDashboard: relaunch.persistedDashboard === true,
      newAutomaticRefresh: relaunch.newAutomaticRefresh === true,
      firstTerminalStatus: ["succeeded", "degraded"].includes(relaunch.firstTerminalStatus)
        ? relaunch.firstTerminalStatus : "unknown",
      secondTerminalStatus: ["succeeded", "degraded"].includes(relaunch.secondTerminalStatus)
        ? relaunch.secondTerminalStatus : "unknown",
    }),
  });
}

async function persistReceipt(receipt, destination) {
  if (destination === null) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(dirname(destination), 0o700).catch(() => {});
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, destination);
}

async function runQa(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("REAL_HISTORY_QA_MAC_ARM64_REQUIRED", "input", "input_invalid");
  }
  await assertAppInput(options.appPath);
  const verifiedArtifactSha256 = await verifyPackagedArtifactIdentity(
    options.appPath,
    options.artifactSha256,
  );
  await ensureDirectoryInput(options.codexHomePath, "Codex home");
  const fixture = await prepareProfile(options.profilePath, options.codexHomePath);
  const debugPort = options.debugPort ?? await freeTcpPort();
  const appOptions = {
    appPath: options.appPath,
    codexHomePath: options.codexHomePath,
    fixture,
    debugPort,
  };
  let session = null;
  let cleanQuitReceipt = false;
  let timer = {};
  let startup = {};
  let parity = {};
  let controlPlane = {};
  let cancel = {};
  let retry = {};
  let relaunch = {};
  let networkInvalid = false;
  let unlistenBoundary = null;
  try {
    session = await launchSession(appOptions);
    unlistenBoundary = session.takeNetworkBoundary;
    await dashboardHealth(session);
    if (options.mode === "cancel") {
      // The startup pass is already owned by the renderer.  Observe the real
      // toolbar and exercise its user-facing cancellation/retry controls.
      const result = await runCancelMode(session);
      timer = result.timer;
      controlPlane = result.controlPlane;
      cancel = result.cancel;
      retry = result.retry;
    } else if (options.mode === "relaunch") {
      const firstStartup = await waitForStartupRefresh(session, null, { sampleTimer: true });
      timer = firstStartup.timer ?? {};
      const firstParity = await assertParity(session, firstStartup);
      const firstQuit = await cleanQuit(session);
      networkInvalid ||= unlistenBoundary();
      unlistenBoundary = null;
      cleanQuitReceipt = firstQuit.clean;
      session = null;

      session = await launchSession(appOptions);
      unlistenBoundary = session.takeNetworkBoundary;
      const persistedDashboard = await waitFor(
        async () => (await uiSnapshot(session)).dataFlow === true,
        REAL_HISTORY_QA_TIMEOUTS.uiMs,
        "persisted dashboard render",
      ).catch(() => false);
      if (!persistedDashboard) {
        fail("REAL_HISTORY_QA_RELAUNCH_PERSISTENCE_INVALID", "relaunch", "relaunch_persistence_invalid");
      }
      const secondStartup = await waitForStartupRefresh(session, firstStartup.refreshId);
      const secondParity = await assertParity(session, secondStartup);
      void firstParity;
      void secondParity;
      const secondQuit = await cleanQuit(session);
      networkInvalid ||= unlistenBoundary();
      unlistenBoundary = null;
      cleanQuitReceipt = secondQuit.clean;
      session = null;
      relaunch = {
        persistedDashboard: true,
        newAutomaticRefresh: secondStartup.refreshIdChanged === true
          && secondStartup.refreshId !== firstStartup.refreshId,
        firstTerminalStatus: firstStartup.terminalStatus,
        secondTerminalStatus: secondStartup.terminalStatus,
      };
      if (relaunch.newAutomaticRefresh !== true) {
        fail("REAL_HISTORY_QA_RELAUNCH_REFRESH_INVALID", "relaunch", "relaunch_refresh_invalid");
      }
      startup = secondStartup;
      parity = secondParity;
    } else {
      startup = await waitForStartupRefresh(session, null, { sampleTimer: true });
      timer = startup.timer ?? {};
      parity = await assertParity(session, startup);
      const quit = await cleanQuit(session);
      networkInvalid ||= unlistenBoundary();
      unlistenBoundary = null;
      cleanQuitReceipt = quit.clean;
      session = null;
    }
    if (unlistenBoundary !== null) networkInvalid ||= unlistenBoundary();
    if (networkInvalid) {
      fail("REAL_HISTORY_QA_NETWORK_BOUNDARY_INVALID", "parity", "network_boundary_invalid");
    }
    if (options.mode === "cancel") {
      const quit = await cleanQuit(session);
      cleanQuitReceipt = quit.clean;
      session = null;
    }
    return buildRealHistoryReceipt({
      mode: options.mode,
      status: "passed",
      cleanQuit: cleanQuitReceipt,
      timer,
      startup,
      parity,
      controlPlane,
      cancel,
      retry,
      relaunch,
      artifactSha256: verifiedArtifactSha256,
      artifactIdentityVerified: true,
    });
  } catch (error) {
    // Main-level failure receipts may retain a verified digest, but never the
    // merely expected CLI value. This keeps an artifact mismatch unbound.
    if (verifiedArtifactSha256 !== null) error.verifiedArtifactSha256 = verifiedArtifactSha256;
    throw error;
  } finally {
    if (session !== null) {
      await closeSession(session).catch(() => {});
    }
  }
}

function failureReason(error) {
  return FAILURE_REASONS.has(error?.qaReason) ? error.qaReason : "runtime_failed";
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/qa-electron-macos-real-history.mjs",
    "  --app <absolute TiboTattle Dev.app>",
    "  --profile <absolute persistent isolated profile>",
    "  --codex-home <absolute real Codex home>",
    "  --artifact-sha256 <lowercase artifact verifier SHA-256>",
    "  [--mode cancel|full|relaunch] [--debug-port <1024..65535>] [--receipt <absolute JSON>]",
    "",
    "The profile is private and persistent; this command never deletes it.",
  ].join("\n") + "\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let options;
  let receipt;
  try {
    options = parseRealHistoryArguments();
    if (options.help) {
      printHelp();
      process.exitCode = 0;
    } else {
      receipt = await runQa(options);
    }
  } catch (error) {
    receipt = buildRealHistoryReceipt({
      mode: options?.mode ?? "full",
      status: "failed",
      failureStage: FAILURE_STAGES.has(error?.qaStage) ? error.qaStage : "input",
      failureReason: failureReason(error),
      artifactSha256: error?.verifiedArtifactSha256 ?? null,
      artifactIdentityVerified: typeof error?.verifiedArtifactSha256 === "string",
    });
    process.exitCode = 1;
  }
  if (receipt) {
    await persistReceipt(receipt, options?.receipt ?? null).catch(() => {});
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
}
