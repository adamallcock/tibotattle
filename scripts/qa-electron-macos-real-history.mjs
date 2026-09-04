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
 *   snapshot seeded snapshot -> Usage/Community parity -> timer/control-plane -> cancel
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
// v3 binds the receipt to the exact source revision and verified packaged
// artifact, and records the bounded quick-result/control-plane evidence.
const REAL_HISTORY_SCHEMA_VERSION = "tibotattle-electron-macos-real-history-v3";
const FIRST_RUN_SCHEMA_VERSION = "tibotattle-desktop-first-run-v1";
const SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v1";
const QUIT_CONTROL = "quit-v1";
const MACOS_LOCAL_QA_TEST_LANE = "macos-electron-local-qa-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const INCREMENTAL_CONTRIBUTION_SYNC_CAPABILITY = "telemetry-contribution-v1.0";

export const REAL_HISTORY_QA_MODES = Object.freeze(["cancel", "snapshot", "full", "relaunch"]);
export const REAL_HISTORY_QA_TIMEOUTS = Object.freeze({
  operationMs: 10_000,
  startupMs: 60_000,
  healthMs: 10_000,
  timerMs: 30_000,
  controlPlaneMs: 10_000,
  cancelMs: 45_000,
  retryMs: 15_000,
  uiMs: 30_000,
  // G1 gives a full real-history refresh one absolute forty-five-minute
  // budget. This is intentionally separate from the shorter startup and
  // control-plane budgets, which still detect a frozen user experience.
  refreshMs: 45 * 60_000,
  quitMs: 15_000,
});

// The loopback control plane is intentionally independent of the dashboard
// snapshot. A response that takes longer than this while the refresh is still
// running is user-visible as a frozen counter/cancel button, even when the
// eventual refresh result is correct. Keep this per-request ceiling separate
// from the G1 p95 ceiling and the much longer work/terminal budgets below.
export const REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS = 3_000;
// G1 requires the sampled health/status control-plane latency p95 to remain at
// or below 250 ms. The max ceiling above remains in force for every sample;
// p95 is an additional aggregate gate, not a replacement for that check.
export const REAL_HISTORY_QA_CONTROL_PLANE_P95_MAX_LATENCY_MS = 250;
// The first useful refresh result is a separate G1 startup gate. Snapshot mode
// deliberately does not evaluate it, so its receipt may retain null here.
export const REAL_HISTORY_QA_QUICK_RESULT_MAX_MS = 30_000;
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
  "refresh_timeout",
  "quick_result_timeout",
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
  "network_external_invalid",
  "network_identity_mutation_invalid",
  "network_contribution_mutation_invalid",
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

// Receipt timing must not depend on wall-clock corrections or the renderer's
// localized text. Keep a process-local monotonic origin so the values below
// are safe, integer milliseconds since the harness started and never expose a
// timestamp or a private refresh identifier.
const MONOTONIC_ORIGIN_NS = process.hrtime.bigint();
function monotonicNowMs() {
  return Number(process.hrtime.bigint() - MONOTONIC_ORIGIN_NS) / 1_000_000;
}

function validQuickResultAt(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value));
}

function quickResultDurationMs(startedAtMonotonicMs, refresh) {
  if (!Number.isFinite(startedAtMonotonicMs) || !validQuickResultAt(refresh?.quickResultAt)) {
    return null;
  }
  return Math.max(0, Math.round(monotonicNowMs() - startedAtMonotonicMs));
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
export function parseRealHistoryArguments(argv = process.argv.slice(2), environment = process.env) {
  if (argv.includes("--help")) return Object.freeze({ help: true });
  const known = new Set([
    "--app",
    "--profile",
    "--codex-home",
    "--mode",
    "--debug-port",
    "--receipt",
    "--artifact-sha256",
    "--source-revision",
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
  const sourceRevisionArgument = argumentValue(argv, "--source-revision");
  const environmentRevisionPresent = environment !== null
    && typeof environment === "object"
    && Object.hasOwn(environment, "SOURCE_REVISION");
  const environmentRevision = environmentRevisionPresent
    ? environment.SOURCE_REVISION
    : null;
  // Accept an explicit CLI value or SOURCE_REVISION from the invoking
  // environment, but never silently choose one when both disagree. This
  // prevents a receipt from being attributed to an unreviewed source SHA.
  const sourceRevision = sourceRevisionArgument ?? environmentRevision;
  const debugPort = debugPortText === null ? null : Number(debugPortText);
  if (!appPath || !profilePath || !codexHomePath
      || !REAL_HISTORY_QA_MODES.includes(mode)
      || !isAbsolute(appPath)
      || !isAbsolute(profilePath)
      || !isAbsolute(codexHomePath)
      || (receiptPath !== null && !isAbsolute(receiptPath))
      || !SHA256_PATTERN.test(artifactSha256 ?? "")
      || !SOURCE_REVISION_PATTERN.test(sourceRevision ?? "")
      || (sourceRevisionArgument !== null
        && environmentRevisionPresent
        && sourceRevisionArgument !== environmentRevision)
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
    sourceRevision,
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
    // Keep the host HOME so Security.framework can resolve the user's login
    // Keychain. The app's writable data remains isolated by --user-data-dir,
    // USAGE_MONITOR_STATE_ROOT, and the XDG/Claude directories below.
    HOME: process.env.HOME,
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
    USAGE_MONITOR_TEST_LANE: MACOS_LOCAL_QA_TEST_LANE,
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
      // This is an internal observation only. The receipt stores the bounded
      // elapsed duration derived from it, never this process-local timestamp.
      startedAtMonotonicMs: monotonicNowMs(),
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

export function createNetworkBoundaryObserver(cdp, expectedOrigin) {
  let violation = null;
  const unsubscribe = cdp.on("Network.requestWillBeSent", ({ request } = {}) => {
    if (typeof request?.url !== "string") return;
    try {
      const parsed = new URL(request.url);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:")
          && parsed.origin !== expectedOrigin) {
        violation ??= "external_http";
      }
      if (parsed.origin === expectedOrigin
          && request?.method !== "GET"
          && parsed.pathname.startsWith("/api/local/contribution/")
          && parsed.pathname !== "/api/local/contribution/sync-next") {
        violation ??= "local_contribution_mutation";
      }
      if (parsed.origin === expectedOrigin
          && request?.method !== "GET"
          && parsed.pathname.startsWith("/api/local/identity/")) {
        violation ??= "local_identity_mutation";
      }
    } catch {
      violation ??= "invalid_url";
    }
  });
  return () => {
    unsubscribe();
    return violation;
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

async function launchSession({
  appPath,
  codexHomePath,
  fixture,
  debugPort,
  deferStartupRefresh = false,
}) {
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
    let startupRefreshReleased = false;
    const releaseStartupRefresh = async () => {
      if (startupRefreshReleased) return false;
      const released = await releaseRealHistoryRefreshGate(cdp);
      startupRefreshReleased = released === true;
      return released;
    };
    if (!deferStartupRefresh) await releaseStartupRefresh();
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
      releaseStartupRefresh,
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

async function refreshStatus(session, timeoutMs = REAL_HISTORY_QA_TIMEOUTS.healthMs) {
  return fetchJson(
    new URL("/api/local/refresh", session.dashboardUrl),
    timeoutMs,
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

/**
 * Calculate the nearest-rank p95 without retaining the individual response
 * timings in a receipt. A p95 of a small sample is intentionally conservative:
 * with six request timings (three health/status pairs), it is the maximum.
 */
export function controlPlaneLatencyP95Ms(values) {
  if (!Array.isArray(values)
      || values.length === 0
      || !values.every((value) => Number.isSafeInteger(value) && value >= 0
        && value <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS)) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * 0.95));
  return sorted[rank - 1];
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
    && snapshot.maxLatencyMs <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS
    && Number.isSafeInteger(snapshot.p95LatencyMs)
    && snapshot.p95LatencyMs >= 0
    && snapshot.p95LatencyMs <= REAL_HISTORY_QA_CONTROL_PLANE_P95_MAX_LATENCY_MS
    && snapshot.p95LatencyMs <= snapshot.maxLatencyMs;
}

export function cancelHttpResponseValid(response) {
  return response?.method === "POST"
    && response?.path === "/api/local/refresh/cancel"
    && response?.status === 202
    && Number.isSafeInteger(response.latencyMs)
    && response.latencyMs >= 0
    && response.latencyMs <= REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS;
}

function attachQaEvidence(error, evidence = {}) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return error;
  }
  const previous = error.qaEvidence && typeof error.qaEvidence === "object"
    ? error.qaEvidence
    : {};
  try {
    Object.defineProperty(error, "qaEvidence", {
      value: Object.freeze({ ...previous, ...evidence }),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // The original classified error remains the fail-closed signal. Evidence
    // is best effort and must never turn a QA failure into a new failure.
  }
  return error;
}

function samplerEvidence(error, key) {
  const evidence = error?.qaEvidence?.[key];
  return evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence
    : {};
}

/**
 * Run the renderer timer and direct loopback control-plane probes together.
 * A timer failure must not cancel the health/status probes: the resulting
 * classified error carries only their bounded summary so the failure receipt
 * can distinguish a frozen renderer from an unresponsive companion.
 */
export async function sampleTimerAndControlPlaneConcurrently(
  timerSampler,
  controlPlaneSampler,
) {
  if (typeof timerSampler !== "function" || typeof controlPlaneSampler !== "function") {
    throw new TypeError("real-history QA samplers must be functions");
  }
  const [timerResult, controlPlaneResult] = await Promise.allSettled([
    Promise.resolve().then(timerSampler),
    Promise.resolve().then(controlPlaneSampler),
  ]);
  const timer = timerResult.status === "fulfilled"
    ? timerResult.value ?? {}
    : samplerEvidence(timerResult.reason, "timer");
  const controlPlane = controlPlaneResult.status === "fulfilled"
    ? controlPlaneResult.value ?? {}
    : samplerEvidence(controlPlaneResult.reason, "controlPlane");
  if (timerResult.status === "rejected" || controlPlaneResult.status === "rejected") {
    const reason = timerResult.status === "rejected"
      ? timerResult.reason
      : controlPlaneResult.reason;
    const error = reason instanceof Error
      ? reason
      : new Error("real-history QA sampler failed");
    attachQaEvidence(error, { timer, controlPlane });
    throw error;
  }
  return Object.freeze({ timer, controlPlane });
}

async function sampleControlPlaneStatus(
  session,
  expectedRefreshId,
  maxDurationMs = REAL_HISTORY_QA_TIMEOUTS.controlPlaneMs,
) {
  const healthUrl = new URL("/api/local/health", session.dashboardUrl);
  const refreshUrl = new URL("/api/local/refresh", session.dashboardUrl);
  const requestTimeoutMs = Math.min(
    REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS,
    Math.max(0, maxDurationMs),
  );
  const deadline = Date.now() + Math.min(
    REAL_HISTORY_QA_TIMEOUTS.controlPlaneMs,
    Math.max(0, maxDurationMs),
  );
  let sampleCount = 0;
  let healthSuccessCount = 0;
  let refreshStatusSuccessCount = 0;
  let maxLatencyMs = 0;
  const latencySamples = [];
  const failure = () => {
    const error = qaError(
      "REAL_HISTORY_QA_CONTROL_PLANE_UNRESPONSIVE",
      "refresh",
      "control_plane_unresponsive",
    );
    attachQaEvidence(error, {
      controlPlane: {
        active: false,
        sampleCount,
        healthSuccessCount,
        refreshStatusSuccessCount,
        maxLatencyMs,
        p95LatencyMs: controlPlaneLatencyP95Ms(latencySamples),
      },
    });
    return error;
  };
  while (Date.now() < deadline) {
    const [health, status] = await Promise.all([
      fetchJsonMeasured(healthUrl, requestTimeoutMs),
      fetchJsonMeasured(refreshUrl, requestTimeoutMs),
    ]);
    sampleCount += 1;
    latencySamples.push(health.latencyMs, status.latencyMs);
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
      throw failure();
    }
    if (healthSuccessCount >= CONTROL_PLANE_MIN_SAMPLES
        && refreshStatusSuccessCount >= CONTROL_PLANE_MIN_SAMPLES) {
      const result = Object.freeze({
        active: true,
        sampleCount,
        healthSuccessCount,
        refreshStatusSuccessCount,
        maxLatencyMs,
        p95LatencyMs: controlPlaneLatencyP95Ms(latencySamples),
      });
      if (!controlPlaneSnapshotValid(result)) {
        const error = failure();
        attachQaEvidence(error, { controlPlane: result });
        throw error;
      }
      return result;
    }
    await wait(CONTROL_PLANE_SAMPLE_INTERVAL_MS);
  }
  throw failure();
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
  { sampleTimer = false, sampleControlPlane = false } = {},
) {
  // Acceptance and terminal polling share one monotonic deadline. A refresh
  // that spends the entire budget before publishing a refresh id must not get
  // a second budget merely because terminal polling has not begun.
  const refreshDeadlineMonotonicMs = monotonicNowMs() + REAL_HISTORY_QA_TIMEOUTS.refreshMs;
  const remainingRefreshBudgetMs = () => Math.max(
    0,
    Math.ceil(refreshDeadlineMonotonicMs - monotonicNowMs()),
  );
  let refreshId = null;
  let requestStartedAtMonotonicMs = null;
  let quickResultDurationObservedMs = null;
  const timeoutEvidence = () => ({
    startup: {
      requestCount: session.observer.snapshot().length,
      refreshIdChanged: refreshId !== null,
      terminalStatus: "unknown",
      terminalEvaluated: false,
      quickResultObserved: quickResultDurationObservedMs !== null,
      quickResultDurationMs: quickResultDurationObservedMs,
      timedOut: true,
    },
  });
  try {
    await waitFor(async () => {
      if (session.child.exitCode !== null || session.child.signalCode !== null) {
        fail("REAL_HISTORY_QA_REFRESH_NOT_STARTED", "refresh", "refresh_not_started");
      }
      const requests = session.observer.snapshot();
      if (requests.length === 0) return null;
      if (requests.length > 1) {
        fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "refresh", "refresh_duplicate");
      }
      requestStartedAtMonotonicMs ??= refreshRequestStartedAtMonotonicMs(session);
      const status = await refreshStatus(
        session,
        Math.min(REAL_HISTORY_QA_TIMEOUTS.healthMs, remainingRefreshBudgetMs()),
      );
      const candidate = status?.refresh;
      if (typeof candidate?.refreshId !== "string" || candidate.refreshId.length === 0) return null;
      if (candidate.refreshId === previousRefreshId) return null;
      if (!["running", "cancelling", "succeeded", "degraded"].includes(candidate.status)) return null;
      quickResultDurationObservedMs ??= observeStartupQuickResult(
        requestStartedAtMonotonicMs,
        candidate,
      );
      refreshId = candidate.refreshId;
      return true;
    }, remainingRefreshBudgetMs(), "real-history startup refresh acceptance", 1_000);
  } catch (error) {
    if (error?.qaStage) throw error;
    const timeout = qaError("REAL_HISTORY_QA_REFRESH_TIMEOUT", "refresh", "refresh_timeout");
    attachQaEvidence(timeout, timeoutEvidence());
    throw timeout;
  }

  let timerResult = null;
  let timerError = null;
  const timerPromise = sampleTimer
    ? sampleAdvancingTimer(session).then((result) => {
      timerResult = result;
    }).catch((error) => {
      timerError = error;
    })
    : null;
  let controlPlaneResult = null;
  let controlPlaneError = null;
  const controlPlanePromise = sampleControlPlane
    ? sampleControlPlaneStatus(session, refreshId, remainingRefreshBudgetMs()).then((result) => {
      controlPlaneResult = result;
    }).catch((error) => {
      controlPlaneError = error;
    })
    : null;
  let terminal = null;
  let degradedFailureCode = null;
  let completionError = null;
  try {
    await waitFor(async () => {
      const requests = session.observer.snapshot();
      if (requests.length !== 1) {
        fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "refresh", "refresh_duplicate");
      }
      const status = await refreshStatus(
        session,
        Math.min(REAL_HISTORY_QA_TIMEOUTS.healthMs, remainingRefreshBudgetMs()),
      );
      const refresh = status?.refresh;
      if (refresh?.refreshId !== refreshId) return null;
      quickResultDurationObservedMs ??= observeStartupQuickResult(
        requestStartedAtMonotonicMs,
        refresh,
      );
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
    }, remainingRefreshBudgetMs(), "real-history startup refresh completion", 2_000);
  } catch (error) {
    if (error?.qaStage) {
      completionError = error;
    } else {
      completionError = qaError(
        "REAL_HISTORY_QA_REFRESH_TIMEOUT",
        "refresh",
        "refresh_timeout",
      );
      attachQaEvidence(completionError, timeoutEvidence());
    }
  } finally {
    if (timerPromise !== null) await timerPromise;
    if (controlPlanePromise !== null) await controlPlanePromise;
  }
  if (completionError !== null) {
    // The timer and control-plane samplers often finish long before a large
    // refresh reaches its deadline. Preserve their bounded evidence on the
    // terminal failure instead of turning an observed healthy control plane
    // into zeroes merely because the deep work timed out.
    attachQaEvidence(completionError, {
      timer: timerResult ?? samplerEvidence(timerError, "timer"),
      controlPlane: controlPlaneResult
        ?? samplerEvidence(controlPlaneError, "controlPlane"),
    });
    throw completionError;
  }
  if (timerError !== null) throw timerError;
  if (controlPlaneError !== null) throw controlPlaneError;
  session.observer.seal();
  return Object.freeze({
    requestCount: 1,
    refreshIdChanged: true,
    terminalStatus: terminal,
    terminalEvaluated: true,
    quickResultObserved: quickResultDurationObservedMs !== null,
    quickResultDurationMs: quickResultDurationObservedMs,
    degradedFailureCode,
    timer: timerResult,
    controlPlane: controlPlaneResult,
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
  if (!advanced) {
    const error = qaError("REAL_HISTORY_QA_TIMER_STALLED", "refresh", "timer_stalled");
    attachQaEvidence(error, {
      timer: {
        sampleCount: values.length,
        uniqueCount: unique.length,
        advanced: false,
      },
    });
    throw error;
  }
  return Object.freeze({
    sampleCount: values.length,
    uniqueCount: unique.length,
    advanced: true,
  });
}

function refreshRequestStartedAtMonotonicMs(session) {
  const entry = session.observer.snapshot()[0];
  return Number.isFinite(entry?.startedAtMonotonicMs)
    ? entry.startedAtMonotonicMs
    : null;
}

function observeStartupQuickResult(startedAtMonotonicMs, refresh) {
  const durationMs = quickResultDurationMs(startedAtMonotonicMs, refresh);
  if (durationMs !== null && durationMs > REAL_HISTORY_QA_QUICK_RESULT_MAX_MS) {
    fail("REAL_HISTORY_QA_QUICK_RESULT_TIMEOUT", "refresh", "quick_result_timeout");
  }
  return durationMs;
}

async function waitRefreshTerminal(session, expectedRefreshId, timeoutMs) {
  try {
    return await waitFor(async () => {
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
  } catch (error) {
    if (error?.qaStage) throw error;
    fail("REAL_HISTORY_QA_CANCEL_WRONG_TERMINAL", "cancel", "cancel_wrong_terminal");
  }
}

async function waitUiReleased(session) {
  try {
    return await waitFor(async () => {
      const snapshot = await uiSnapshot(session);
      return snapshot?.refreshDisabled === false && snapshot?.cancelHidden === true;
    }, REAL_HISTORY_QA_TIMEOUTS.uiMs, "refresh UI release");
  } catch (error) {
    if (error?.qaStage) throw error;
    fail("REAL_HISTORY_QA_CANCEL_WRONG_TERMINAL", "cancel", "cancel_wrong_terminal");
  }
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
  try {
    return await waitFor(async () => {
      const [status, snapshot] = await Promise.all([
        refreshStatus(session),
        uiSnapshot(session),
      ]);
      return ["cancelling", "cancelled"].includes(status?.refresh?.status)
        || snapshot?.cancelDisabled === true
        ? true
        : null;
    }, 8_000, "refresh cancellation acknowledgement", 250);
  } catch (error) {
    if (error?.qaStage) throw error;
    fail(
      "REAL_HISTORY_QA_CANCEL_NOT_ACKNOWLEDGED",
      "cancel",
      "cancel_not_acknowledged",
    );
  }
}

export function realHistoryCancelBoundaryReady(refresh) {
  if (refresh === null
      || typeof refresh !== "object"
      || Array.isArray(refresh)
      || refresh.status !== "running"
      || typeof refresh.refreshId !== "string"
      || refresh.refreshId.length === 0
      || typeof refresh.quickResultAt !== "string"
      || !Number.isFinite(Date.parse(refresh.quickResultAt))) return false;
  if (refresh.progress?.phase === "quick_result") return true;
  const progress = refresh.progress;
  return progress?.kind === "unified_index"
    && progress.status === "scanning"
    && progress.phase === "rollout_index"
    && [
      progress.filesDiscovered,
      progress.filesSelected,
      progress.filesProcessed,
      progress.recordsWritten,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
    && progress.filesSelected <= progress.filesDiscovered
    && progress.filesProcessed <= progress.filesSelected;
}

async function runCancelMode(session) {
  let first;
  let requestStartedAtMonotonicMs = null;
  let quickResultDurationObservedMs = null;
  try {
    first = await waitFor(async () => {
      const requests = session.observer.snapshot();
      if (requests.length > 1) {
        fail("REAL_HISTORY_QA_REFRESH_DUPLICATE", "cancel", "refresh_duplicate");
      }
      if (requests.length !== 1) return null;
      requestStartedAtMonotonicMs ??= refreshRequestStartedAtMonotonicMs(session);
      const status = await refreshStatus(session);
      quickResultDurationObservedMs ??= observeStartupQuickResult(
        requestStartedAtMonotonicMs,
        status?.refresh,
      );
      return realHistoryCancelBoundaryReady(status?.refresh)
        ? status.refresh : null;
    }, REAL_HISTORY_QA_TIMEOUTS.startupMs, "cancel mode quick-result boundary");
  } catch (error) {
    if (error?.qaStage) throw error;
    fail("REAL_HISTORY_QA_REFRESH_NOT_STARTED", "refresh", "refresh_not_started");
  }
  session.controlPlane.reset();
  let timer = {};
  let controlPlane = {};
  let cancelEvidence = {};
  let retryEvidence = {};
  try {
    ({ timer, controlPlane } = await sampleTimerAndControlPlaneConcurrently(
      () => sampleAdvancingTimer(session),
      () => sampleControlPlaneStatus(session, first.refreshId),
    ));
    const cancelStartedAt = Date.now();
    await clickCancel(session);
    await waitCancelAcknowledged(session);
    const acknowledgedMs = Date.now() - cancelStartedAt;
    cancelEvidence = { acknowledgedMs };
    const cancelHttp = await waitCancelHttpResponse(session);
    cancelEvidence = { ...cancelEvidence, http: cancelHttp };
    const firstTerminal = await waitRefreshTerminal(
      session,
      first.refreshId,
      REAL_HISTORY_QA_TIMEOUTS.cancelMs,
    );
    if (firstTerminal.status !== "cancelled") {
      fail("REAL_HISTORY_QA_CANCEL_WRONG_TERMINAL", "cancel", "cancel_wrong_terminal");
    }
    const terminalMs = Date.now() - cancelStartedAt;
    cancelEvidence = {
      ...cancelEvidence,
      terminalMs,
      terminalStatus: "cancelled",
    };
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
    let retry;
    try {
      retry = await waitFor(async () => {
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
    } catch (error) {
      if (error?.qaStage) throw error;
      fail("REAL_HISTORY_QA_RETRY_REJECTED", "cancel", "retry_rejected");
    }
    retryEvidence = { newRefreshId: true, accepted: true };
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
    retryEvidence = {
      ...retryEvidence,
      terminalStatus: "cancelled",
      cancelHttp: retryCancelHttp,
    };
    return Object.freeze({
      startup: Object.freeze({
        requestCount: 1,
        refreshIdChanged: true,
        // Cancel mode deliberately stops at the in-flight boundary. A
        // separate full/snapshot run is required before making any terminal
        // refresh claim.
        terminalStatus: "not_evaluated",
        terminalEvaluated: false,
        quickResultObserved: quickResultDurationObservedMs !== null,
        quickResultDurationMs: quickResultDurationObservedMs,
        // Deliberately private: the receipt builder never copies it.
        refreshId: first.refreshId,
      }),
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
  } catch (error) {
    attachQaEvidence(error, {
      timer: Object.keys(timer).length > 0 ? timer : samplerEvidence(error, "timer"),
      controlPlane: Object.keys(controlPlane).length > 0
        ? controlPlane
        : samplerEvidence(error, "controlPlane"),
      cancel: Object.keys(cancelEvidence).length > 0
        ? cancelEvidence
        : samplerEvidence(error, "cancel"),
      retry: Object.keys(retryEvidence).length > 0
        ? retryEvidence
        : samplerEvidence(error, "retry"),
    });
    throw error;
  }
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

// The QA lane has two valid, deliberately disjoint service states.  A local
// test app must expose an exact all-disabled capability set; a production
// service proof must expose the complete enabled set and a successful bounded
// liveness check.  Treat every partial, missing, or contradictory combination
// as invalid so it cannot accidentally select the weaker local assertions.
export function communityServiceConfigurationState(health) {
  const capabilities = health?.capabilities;
  const centralServiceProxy = capabilities?.centralServiceProxy;
  const contributionDevicePairing = capabilities?.contributionDevicePairing;
  const incrementalContributionSync = capabilities?.incrementalContributionSync;
  const localQaState = centralServiceProxy === false
    && contributionDevicePairing === false
    && incrementalContributionSync === false
    && health?.serviceReachability === "not_configured"
    && health?.serviceReachabilityProven === false;
  if (localQaState) return "not_configured";

  const productionState = centralServiceProxy === true
    && contributionDevicePairing === true
    && incrementalContributionSync === INCREMENTAL_CONTRIBUTION_SYNC_CAPABILITY
    && health?.serviceReachability === "ok"
    && health?.serviceReachabilityProven === true;
  if (productionState) return "configured";
  return "invalid";
}

export function communityParitySnapshotValid(
  snapshot,
  health,
  { requirePartialDetail = false } = {},
) {
  return communityServiceConfigurationState(health) === "configured"
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
    && snapshot?.consentVisible === true
    && snapshot?.noServiceCopy === false;
}

export function localQaCommunityParitySnapshotValid(
  snapshot,
  health,
  { requirePartialDetail = false } = {},
) {
  return communityServiceConfigurationState(health) === "not_configured"
    && snapshot?.route === "#community"
    && snapshot?.pageVisible === true
    && snapshot?.journeyStageCount === 2
    && snapshot?.indexTerminal === true
    && snapshot?.indexDetail === true
    && (!requirePartialDetail || snapshot?.partialHistoryDetail === true)
    && snapshot?.googleButton === true
    && snapshot?.appleButton === true
    && snapshot?.googleButtonEnabled === false
    && snapshot?.appleButtonEnabled === false
    && snapshot?.currentLayout === true
    && snapshot?.consentVisible === false
    && snapshot?.noServiceCopy === true
    && snapshot?.noServiceNoticeCount === 1;
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
        && document.querySelector('#incremental-consent') !== null
        && (document.querySelector('#incremental-consent')?.textContent?.trim() ?? '').length > 0,
      consentVisible: visible(document.querySelector('#incremental-consent')),
      noServiceCopy: pageText.includes('no contribution service'),
      noServiceNoticeCount: [
        document.querySelector('#identity-google-unavailable'),
        document.querySelector('#identity-apple-unavailable'),
      ].filter((element) => visible(element)
        && (element?.textContent?.toLowerCase() ?? '').includes('no contribution service')).length,
    };
  })()`), REAL_HISTORY_QA_TIMEOUTS.uiMs, "real-history Community parity");
  const serviceState = communityServiceConfigurationState(health);
  const serviceConfigured = serviceState === "configured";
  const valid = serviceState === "configured"
    ? communityParitySnapshotValid(community, health, {
      requirePartialDetail: terminalStatus === "degraded",
    })
    : serviceState === "not_configured"
      ? localQaCommunityParitySnapshotValid(community, health, {
        requirePartialDetail: terminalStatus === "degraded",
      })
      : false;
  if (!valid) fail("REAL_HISTORY_QA_COMMUNITY_INVALID", "parity", "community_invalid");
  return Object.freeze({
    pageVisible: true,
    serviceConfigured,
    serviceReachability: health.serviceReachability,
    serviceReachabilityProven: health.serviceReachabilityProven,
    journeyStageCount: community.journeyStageCount,
    currentLayout: true,
    providerControls: true,
    providerControlsEnabled: serviceConfigured
      && community.googleButtonEnabled === true
      && community.appleButtonEnabled === true,
    indexTerminal: true,
    partialHistoryDetail: community.partialHistoryDetail,
    noServiceCopy: community.noServiceCopy,
    noServiceNoticeCount: community.noServiceNoticeCount,
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
  sourceRevision = null,
  failureStage = null,
  failureReason = null,
} = {}) {
  const acceptedMode = REAL_HISTORY_QA_MODES.includes(mode) ? mode : "full";
  const requestedPassed = status === "passed";
  const sourceRevisionBound = SOURCE_REVISION_PATTERN.test(sourceRevision ?? "");
  const artifactIdentityBound = artifactIdentityVerified === true
    && SHA256_PATTERN.test(artifactSha256 ?? "");
  const controlPlaneValid = controlPlaneSnapshotValid(controlPlane);
  const quickResultDurationProvided = startup.quickResultDurationMs !== undefined
    && startup.quickResultDurationMs !== null;
  const quickResultDurationValid = !quickResultDurationProvided
    || (Number.isSafeInteger(startup.quickResultDurationMs)
      && startup.quickResultDurationMs >= 0
      && startup.quickResultDurationMs <= REAL_HISTORY_QA_QUICK_RESULT_MAX_MS);
  // A caller may construct a failure receipt with partial evidence, but a
  // receipt claiming `passed` must be bound to the exact source revision, the
  // verified app.asar digest, and a control-plane summary that passed the
  // p95/max gates. This keeps the content-free receipt fail-closed even when
  // called outside runQa().
  const passed = requestedPassed
    && sourceRevisionBound
    && artifactIdentityBound
    && controlPlaneValid
    && quickResultDurationValid;
  const sourceBindingFailure = requestedPassed && !sourceRevisionBound;
  const artifactBindingFailure = requestedPassed
    && sourceRevisionBound
    && !artifactIdentityBound;
  const controlPlaneFailure = requestedPassed
    && sourceRevisionBound
    && artifactIdentityBound
    && !controlPlaneValid;
  const quickResultFailure = requestedPassed
    && sourceRevisionBound
    && artifactIdentityBound
    && controlPlaneValid
    && !quickResultDurationValid;
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
    sourceRevision: sourceRevisionBound ? sourceRevision : null,
    sourceRevisionBound,
    artifact: Object.freeze({
      sha256: artifactIdentityBound ? artifactSha256 : null,
      identityBound: artifactIdentityBound,
    }),
    profileIsolated: true,
    contentFree: true,
    cleanQuit: cleanQuit === true,
    failureStage: !passed
      ? sourceBindingFailure
        ? "input"
        : artifactBindingFailure
          ? "input"
          : controlPlaneFailure || quickResultFailure
            ? "refresh"
            : FAILURE_STAGES.has(failureStage) ? failureStage : null
      : null,
    failureReason: !passed
      ? sourceBindingFailure
        ? "input_invalid"
        : artifactBindingFailure
          ? "artifact_invalid"
          : controlPlaneFailure
            ? "control_plane_unresponsive"
            : quickResultFailure
              ? "quick_result_timeout"
              : FAILURE_REASONS.has(failureReason) ? failureReason : "runtime_failed"
      : null,
    timer: Object.freeze({
      sampleCount: Number.isInteger(timer.sampleCount) ? timer.sampleCount : 0,
      uniqueCount: Number.isInteger(timer.uniqueCount) ? timer.uniqueCount : 0,
      advanced: timer.advanced === true,
    }),
    startupRefresh: Object.freeze({
      requestCount: Number.isInteger(startup.requestCount) ? startup.requestCount : 0,
      refreshIdChanged: startup.refreshIdChanged === true,
      terminalStatus: startup.terminalStatus === "not_evaluated"
          && startup.terminalEvaluated !== true
        ? "not_evaluated"
        : ["succeeded", "degraded"].includes(startup.terminalStatus)
          ? startup.terminalStatus
          : "unknown",
      terminalEvaluated: startup.terminalStatus === "not_evaluated"
        ? false
        : startup.terminalEvaluated === true
          || ["succeeded", "degraded"].includes(startup.terminalStatus),
      quickResultObserved: startup.quickResultObserved === true && quickResultDurationValid,
      quickResultDurationMs: quickResultDurationValid && quickResultDurationProvided
        ? startup.quickResultDurationMs
        : null,
      timedOut: startup.timedOut === true,
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
      // Preserve bounded latency diagnostics even on a failed gate so the
      // receipt explains a p95 breach without ever accepting it as active.
      maxLatencyMs: boundedLatency(controlPlane.maxLatencyMs),
      p95LatencyMs: boundedLatency(controlPlane.p95LatencyMs),
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
        noServiceCopy: parity.community?.noServiceCopy === true,
        noServiceNoticeCount: Number.isInteger(parity.community?.noServiceNoticeCount)
          ? parity.community.noServiceNoticeCount : 0,
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
    // Snapshot mode reads the already-seeded dashboard before releasing the
    // launch refresh. This keeps the bounded parity proof independent from a
    // potentially long cold rebuild while retaining a real, user-facing
    // refresh to cancel immediately afterwards.
    deferStartupRefresh: options.mode === "snapshot",
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
  let networkViolation = null;
  let unlistenBoundary = null;
  try {
    session = await launchSession(appOptions);
    unlistenBoundary = session.takeNetworkBoundary;
    await dashboardHealth(session);
    if (options.mode === "cancel") {
      // The startup pass is already owned by the renderer.  Observe the real
      // toolbar and exercise its user-facing cancellation/retry controls.
      const result = await runCancelMode(session);
      startup = result.startup ?? {};
      timer = result.timer;
      controlPlane = result.controlPlane;
      cancel = result.cancel;
      retry = result.retry;
    } else if (options.mode === "snapshot") {
      // The launch gate is intentionally still held here. The dashboard has
      // completed its initial local snapshot render, but no cold rebuild has
      // been released yet, so these assertions prove the seeded state itself.
      parity = await assertParity(session, {
        terminalStatus: "not_evaluated",
        terminalEvaluated: false,
      });
      await session.releaseStartupRefresh();
      const result = await runCancelMode(session);
      startup = result.startup ?? {};
      timer = result.timer;
      controlPlane = result.controlPlane;
      cancel = result.cancel;
      retry = result.retry;
    } else if (options.mode === "relaunch") {
      const firstStartup = await waitForStartupRefresh(session, null, {
        sampleTimer: true,
        sampleControlPlane: true,
      });
      timer = firstStartup.timer ?? {};
      const firstParity = await assertParity(session, firstStartup);
      const firstQuit = await cleanQuit(session);
      networkViolation ||= unlistenBoundary();
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
      const secondStartup = await waitForStartupRefresh(session, firstStartup.refreshId, {
        sampleControlPlane: true,
      });
      const secondParity = await assertParity(session, secondStartup);
      void firstParity;
      void secondParity;
      const secondQuit = await cleanQuit(session);
      networkViolation ||= unlistenBoundary();
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
      controlPlane = secondStartup.controlPlane ?? {};
    } else {
      startup = await waitForStartupRefresh(session, null, {
        sampleTimer: true,
        sampleControlPlane: true,
      });
      timer = startup.timer ?? {};
      controlPlane = startup.controlPlane ?? {};
      parity = await assertParity(session, startup);
      const quit = await cleanQuit(session);
      networkViolation ||= unlistenBoundary();
      unlistenBoundary = null;
      cleanQuitReceipt = quit.clean;
      session = null;
    }
    if (unlistenBoundary !== null) networkViolation ||= unlistenBoundary();
    if (networkViolation !== null) {
      const reason = networkViolation === "external_http"
        ? "network_external_invalid"
        : networkViolation === "local_identity_mutation"
          ? "network_identity_mutation_invalid"
          : networkViolation === "local_contribution_mutation"
            ? "network_contribution_mutation_invalid"
          : "network_boundary_invalid";
      fail("REAL_HISTORY_QA_NETWORK_BOUNDARY_INVALID", "parity", reason);
    }
    if (options.mode === "cancel" || options.mode === "snapshot") {
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
      sourceRevision: options.sourceRevision,
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
    "  --source-revision <lowercase 40-hex source revision> (or SOURCE_REVISION)",
    "  [--mode cancel|snapshot|full|relaunch] [--debug-port <1024..65535>] [--receipt <absolute JSON>]",
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
    const evidence = error?.qaEvidence && typeof error.qaEvidence === "object"
      ? error.qaEvidence
      : {};
    receipt = buildRealHistoryReceipt({
      mode: options?.mode ?? "full",
      status: "failed",
      failureStage: FAILURE_STAGES.has(error?.qaStage) ? error.qaStage : "input",
      failureReason: failureReason(error),
      timer: evidence.timer,
      startup: evidence.startup,
      controlPlane: evidence.controlPlane,
      cancel: evidence.cancel,
      retry: evidence.retry,
      artifactSha256: error?.verifiedArtifactSha256 ?? null,
      artifactIdentityVerified: typeof error?.verifiedArtifactSha256 === "string",
      sourceRevision: options?.sourceRevision ?? null,
    });
    process.exitCode = 1;
  }
  if (receipt) {
    await persistReceipt(receipt, options?.receiptPath ?? null).catch(() => {});
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
}
