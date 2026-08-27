#!/usr/bin/env node

/**
 * Qualify the packaged, unsigned macOS Electron prototype against a disposable
 * local profile.  This is a development-only runtime smoke: it does not prove
 * signing, updater, notification identity, or production distribution.
 *
 * The lane intentionally launches an already-packaged TiboTattle Dev.app.  A
 * build step is kept outside the smoke so the receipt always identifies the
 * exact artifact the caller selected, rather than silently testing a stale
 * staging directory or a different architecture.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "../apps/electron/desktop-first-run.js";
import {
  DESKTOP_DEFAULT_CODEX_ROOT_ID,
} from "../apps/electron/desktop-codex-roots.js";
import {
  DESKTOP_SETTINGS_SCHEMA_VERSION,
} from "../apps/electron/desktop-contract.js";

const MAX_STARTUP_MS = 30_000;
const MAX_OPERATION_MS = 10_000;
const MAX_REFRESH_MS = 45_000;
const MAX_SHUTDOWN_MS = 10_000;
const MACOS_SMOKE_SCHEMA_VERSION = "tibotattle-electron-macos-smoke-v2";
const MACOS_SMOKE_CONTROL = "quit-v1";
const MACOS_LOCAL_QA_TEST_LANE = "macos-electron-local-qa-v1";
const REQUIRED_APP_NAME = "TiboTattle Dev";
const CLI_FAILURE_STATUS = "ELECTRON_MACOS_SMOKE_FAILED";
const MACOS_SMOKE_CODEX_ROOT_LIMIT = 8;
const MACOS_SMOKE_CODEX_ROOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MACOS_SMOKE_CUSTOM_CODEX_ROOT_ID = "11111111-1111-4111-8111-111111111111";

export const ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES = Object.freeze({
  duplicate: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_DUPLICATED",
  invalidReceipt: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID",
  changedReceipt: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED",
  failed: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_FAILED",
  cancelled: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_CANCELLED",
  degradedInvalid: "ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_DEGRADED_INVALID",
  boundaryInvalid: "ELECTRON_MACOS_SMOKE_REFRESH_BOUNDARY_INVALID",
});

export const ELECTRON_MACOS_SMOKE_DEGRADED_FAILURE_CODES = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
]);

const DEGRADED_FAILURE_CODE_SET = new Set(
  ELECTRON_MACOS_SMOKE_DEGRADED_FAILURE_CODES,
);

const FAILURE_STAGES = new Set([
  "contract",
  "launch",
  "dashboard",
  "startup_refresh",
  "parity",
  "share",
  "settings",
  "quit",
]);

export const ELECTRON_MACOS_SMOKE_FAILURE_REASONS = Object.freeze([
  "app_contract_invalid",
  "launch_failed",
  "port_unavailable",
  "remote_debugging_unavailable",
  "dashboard_target_unavailable",
  "dashboard_renderer_unavailable",
  "dashboard_chrome_invalid",
  "dashboard_data_unavailable",
  "dashboard_origin_invalid",
  "companion_not_ready",
  "companion_not_running",
  "startup_refresh_boundary_invalid",
  "startup_refresh_duplicate",
  "startup_refresh_receipt_invalid",
  "startup_refresh_receipt_changed",
  "startup_refresh_failed",
  "startup_refresh_cancelled",
  "usage_parity_invalid",
  "community_parity_invalid",
  "share_flow_invalid",
  "settings_flow_invalid",
  "settings_tabs_invalid",
  "clean_quit_invalid",
  "quit_signal_failed",
  "non_loopback_request",
  "runtime_failed",
]);

const FAILURE_REASON_BY_CODE = Object.freeze({
  ELECTRON_MACOS_SMOKE_NATIVE_ARM64_REQUIRED: "app_contract_invalid",
  ELECTRON_MACOS_SMOKE_APP_REQUIRED: "app_contract_invalid",
  ELECTRON_MACOS_SMOKE_PACKAGED_ARM64_APP_INVALID: "app_contract_invalid",
  ELECTRON_MACOS_SMOKE_PORT_UNAVAILABLE: "port_unavailable",
  ELECTRON_MACOS_SMOKE_PROCESS_UNAVAILABLE: "launch_failed",
  ELECTRON_MACOS_SMOKE_REMOTE_DEBUGGING_UNAVAILABLE: "remote_debugging_unavailable",
  ELECTRON_MACOS_SMOKE_DASHBOARD_TARGET_UNAVAILABLE: "dashboard_target_unavailable",
  ELECTRON_MACOS_SMOKE_DASHBOARD_RENDERER_UNAVAILABLE: "dashboard_renderer_unavailable",
  ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID: "dashboard_origin_invalid",
  ELECTRON_MACOS_SMOKE_COMPANION_NOT_READY: "companion_not_ready",
  ELECTRON_MACOS_SMOKE_COMPANION_NOT_RUNNING: "companion_not_running",
  ELECTRON_MACOS_SMOKE_DASHBOARD_CHROME_INVALID: "dashboard_chrome_invalid",
  ELECTRON_MACOS_SMOKE_DASHBOARD_DATA_INVALID: "dashboard_data_unavailable",
  ELECTRON_MACOS_SMOKE_NON_LOOPBACK_REQUEST: "non_loopback_request",
  ELECTRON_MACOS_SMOKE_EXITED_BEFORE_REFRESH: "startup_refresh_failed",
  ELECTRON_MACOS_SMOKE_EXITED_DURING_REFRESH: "startup_refresh_failed",
  ELECTRON_MACOS_SMOKE_USAGE_PARITY_INVALID: "usage_parity_invalid",
  ELECTRON_MACOS_SMOKE_COMMUNITY_PARITY_INVALID: "community_parity_invalid",
  ELECTRON_MACOS_SMOKE_SHARE_FLOW_INVALID: "share_flow_invalid",
  ELECTRON_MACOS_SMOKE_SETTINGS_FLOW_INVALID: "settings_flow_invalid",
  ELECTRON_MACOS_SMOKE_SETTINGS_TABS_INVALID: "settings_tabs_invalid",
  ELECTRON_MACOS_SMOKE_EXITED_BEFORE_QUIT: "clean_quit_invalid",
  ELECTRON_MACOS_SMOKE_QUIT_SIGNAL_FAILED: "quit_signal_failed",
  ELECTRON_MACOS_SMOKE_CLEAN_QUIT_INVALID: "clean_quit_invalid",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.boundaryInvalid]:
    "startup_refresh_boundary_invalid",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate]:
    "startup_refresh_duplicate",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.invalidReceipt]:
    "startup_refresh_receipt_invalid",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.changedReceipt]:
    "startup_refresh_receipt_changed",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.failed]:
    "startup_refresh_failed",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.cancelled]:
    "startup_refresh_cancelled",
  [ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.degradedInvalid]:
    "startup_refresh_failed",
});

const FAILURE_STAGE_DEFAULT_REASONS = Object.freeze({
  contract: "app_contract_invalid",
  launch: "launch_failed",
  dashboard: "runtime_failed",
  startup_refresh: "startup_refresh_failed",
  parity: "usage_parity_invalid",
  share: "share_flow_invalid",
  settings: "settings_flow_invalid",
  quit: "clean_quit_invalid",
});

function failureReasonForCode(code, stage = "launch") {
  const selected = FAILURE_REASON_BY_CODE[code]
    ?? FAILURE_STAGE_DEFAULT_REASONS[stage]
    ?? "runtime_failed";
  return ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes(selected)
    ? selected
    : "runtime_failed";
}

function failureReasonForError(error, stage = "launch") {
  const selected = error?.smokeReason;
  return ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes(selected)
    ? selected
    : failureReasonForCode(error?.code, stage);
}

function fixedError(code, stage = "launch", reason = undefined) {
  const error = new Error(code);
  error.code = code;
  error.smokeStage = stage;
  error.smokeReason = reason ?? failureReasonForCode(code, stage);
  return error;
}

function fail(code, stage = "launch", reason = undefined) {
  throw fixedError(code, stage, reason);
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

export async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (typeof error?.code === "string"
          && error.code.startsWith("ELECTRON_MACOS_SMOKE_")) {
        throw error;
      }
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
  if (!Number.isSafeInteger(port) || port < 1) {
    fail("ELECTRON_MACOS_SMOKE_PORT_UNAVAILABLE", "launch");
  }
  return port;
}

/**
 * Pure bundle contract used by the source lane and by the runtime before any
 * child process is started.  The file/architecture booleans are injected so
 * unit tests do not need a macOS app bundle.
 */
export function assertMacAppContract({
  platform = process.platform,
  architecture = process.arch,
  appPath,
  appName = REQUIRED_APP_NAME,
  bundleExists = true,
  executableExists = true,
  asarExists = true,
  executableArchitecture = "arm64",
} = {}) {
  if (platform !== "darwin") {
    throw new TypeError("macOS Electron smoke requires darwin");
  }
  if (architecture !== "arm64") {
    throw new TypeError("macOS Electron smoke requires arm64");
  }
  if (typeof appPath !== "string"
      || !isAbsolute(appPath)
      || basename(appPath) !== `${appName}.app`) {
    throw new TypeError("macOS Electron app bundle is invalid");
  }
  if (bundleExists !== true || executableExists !== true || asarExists !== true) {
    throw new TypeError("macOS Electron app bundle is incomplete");
  }
  if (executableArchitecture !== "arm64") {
    throw new TypeError("macOS Electron app executable is not arm64");
  }
  return Object.freeze({
    platform,
    architecture,
    appName,
    target: "darwin-arm64",
  });
}

async function assertPackagedMacApp(appPath) {
  const executable = join(appPath, "Contents", "MacOS", REQUIRED_APP_NAME);
  const asar = join(appPath, "Contents", "Resources", "app.asar");
  const [bundleMetadata, executableMetadata, asarMetadata] = await Promise.all([
    stat(appPath).catch(() => null),
    stat(executable).catch(() => null),
    stat(asar).catch(() => null),
  ]);
  let executableArchitecture = "unknown";
  if (executableMetadata?.isFile?.()) {
    try {
      const description = execFileSync("file", [executable], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      executableArchitecture = /\barm64\b/u.test(description) ? "arm64" : "unknown";
    } catch {
      executableArchitecture = "unknown";
    }
  }
  try {
    return assertMacAppContract({
      appPath,
      bundleExists: bundleMetadata?.isDirectory?.() === true,
      executableExists: executableMetadata?.isFile?.() === true,
      asarExists: asarMetadata?.isFile?.() === true,
      executableArchitecture,
    });
  } catch {
    fail("ELECTRON_MACOS_SMOKE_PACKAGED_ARM64_APP_INVALID", "contract");
  }
}

async function createSyntheticFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-macos-"));
  const profile = join(root, "profile");
  const home = join(profile, "home");
  const codexHome = join(home, ".codex");
  const secondaryCodexHome = join(profile, "codex-secondary");
  const claudeHome = join(home, ".claude");
  const sessions = join(codexHome, "sessions");
  const secondarySessions = join(secondaryCodexHome, "sessions");
  const archivedSessions = join(codexHome, "archived_sessions");
  const stateRoot = join(profile, "state");
  const userData = join(profile, "user-data");
  const settingsRoot = join(userData, "desktop-settings");
  const runtimeDirectory = join(profile, "runtime");
  const configHome = join(home, ".config");
  const dataHome = join(home, ".local", "share");
  const cacheHome = join(home, ".cache");
  const directories = [
    root,
    profile,
    home,
    codexHome,
    secondaryCodexHome,
    sessions,
    secondarySessions,
    archivedSessions,
    claudeHome,
    stateRoot,
    userData,
    settingsRoot,
    runtimeDirectory,
    configHome,
    dataHome,
    cacheHome,
  ];
  try {
    await Promise.all(directories.map((directory) => mkdir(directory, {
      recursive: true,
      mode: 0o700,
    })));
    await Promise.all(directories.map((directory) => chmod(directory, 0o700)));

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
        payload: { id: "macos-electron-smoke" },
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
      join(sessions, "rollout-macos-electron-smoke.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
    const secondaryRows = rows.map((row) => row.type === "session_meta"
      ? { ...row, payload: { id: "macos-electron-smoke-secondary" } }
      : row);
    await writeFile(
      join(secondarySessions, "rollout-macos-electron-smoke-secondary.jsonl"),
      `${secondaryRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(codexHome, "config.toml"), 'service_tier = "standard"\n', {
      mode: 0o600,
    });
    await writeFile(join(claudeHome, "settings.json"), "{}\n", { mode: 0o600 });

    // Seed one custom root so the Settings smoke exercises the real pathful
    // settings-only read.  The dashboard-facing getSettings() projection is
    // still checked separately and must not contain this path.
    await writeFile(
      join(settingsRoot, "desktop-settings-v1.json"),
      `${JSON.stringify({
        schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
        codexHomes: {
          activityRoots: [
            {
              rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
              kind: "default",
              path: null,
              enabled: true,
            },
            {
              rootId: MACOS_SMOKE_CUSTOM_CODEX_ROOT_ID,
              kind: "custom",
              path: secondaryCodexHome,
              enabled: true,
            },
          ],
          primaryRootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
        },
        language: "system",
        appearance: "system",
        refreshIntervalSeconds: 300,
        startAtLogin: false,
        notifications: { enabled: false, threshold: "off" },
        sidebarCollapsed: false,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(join(settingsRoot, "desktop-settings-v1.json"), 0o600);

    // This is a returning-user qualification fixture.  It uses the same
    // content-free receipt validated by the production POSIX backend and
    // prevents a native consent dialog from racing the CDP observer.
    await writeFile(
      join(settingsRoot, "desktop-first-run-v1.json"),
      `${JSON.stringify({
        schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
        acknowledged: true,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(join(settingsRoot, "desktop-first-run-v1.json"), 0o600);

    return Object.freeze({
      root,
      profile,
      home,
      codexHome,
      secondaryCodexHome,
      claudeHome,
      stateRoot,
      userData,
      runtimeDirectory,
      configHome,
      dataHome,
      cacheHome,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function jsonFetch(url) {
  return withTimeout(fetch(url), MAX_OPERATION_MS, "JSON request")
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket error")), { once: true });
  }), MAX_OPERATION_MS, "CDP connection");

  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Map();
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) {
      for (const handler of eventHandlers.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "CDP request failed"));
    else request.resolve(message.result ?? {});
  };
  socket.addEventListener("message", onMessage);

  const request = (method, params = {}) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      throw error;
    }
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
    on(method, handler) {
      if (typeof method !== "string" || typeof handler !== "function") {
        throw new TypeError("CDP event method and handler are required");
      }
      let handlers = eventHandlers.get(method);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(method, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) eventHandlers.delete(method);
      };
    },
    close() {
      try {
        socket.close();
      } catch {
        // CDP cleanup is best effort after the app has begun quitting.
      }
      for (const { reject } of pending.values()) reject(new Error("CDP connection closed"));
      pending.clear();
      eventHandlers.clear();
    },
  });
}

function mainFrameLoaderId(cdp) {
  return cdp.request("Page.getFrameTree").then((tree) => {
    const loaderId = tree?.frameTree?.frame?.loaderId;
    return typeof loaderId === "string" && loaderId.length > 0 ? loaderId : null;
  });
}

/**
 * Observe renderer refresh mutations before the dashboard says it is ready.
 * Selecting the origin and loader later deliberately discards any request
 * from another local port or a stale document.
 */
export function observeLocalRefreshRequests(cdp) {
  const requests = [];
  let activeLoaderId = null;
  let activeOrigin = null;
  let sealed = false;
  const unsubscribe = cdp.on(
    "Network.requestWillBeSent",
    ({ request, requestId, loaderId } = {}) => {
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
      if (activeOrigin !== null && parsed.origin !== activeOrigin) return;
      requests.push(Object.freeze({
        requestId: typeof requestId === "string" ? requestId : null,
        loaderId: typeof loaderId === "string" ? loaderId : null,
        origin: parsed.origin,
      }));
    },
  );
  return Object.freeze({
    reset() {
      requests.length = 0;
      activeLoaderId = null;
      activeOrigin = null;
      sealed = false;
    },
    selectOrigin(origin) {
      try {
        const parsed = new URL(origin);
        activeOrigin = parsed.protocol === "http:"
          && parsed.hostname === "127.0.0.1"
          && parsed.origin === origin
          ? parsed.origin
          : null;
      } catch {
        activeOrigin = null;
      }
      if (activeOrigin === null) {
        requests.length = 0;
      } else {
        const retained = requests.filter((entry) => entry.origin === activeOrigin);
        requests.length = 0;
        requests.push(...retained);
      }
      return activeOrigin;
    },
    selectLoader(loaderId) {
      activeLoaderId = typeof loaderId === "string" && loaderId.length > 0
        ? loaderId
        : null;
      if (activeLoaderId === null) {
        requests.length = 0;
        return null;
      }
      const retained = requests.filter((entry) => entry.loaderId === activeLoaderId);
      requests.length = 0;
      requests.push(...retained);
      return activeLoaderId;
    },
    seal() {
      sealed = true;
    },
    snapshot() {
      if (activeOrigin === null || activeLoaderId === null) return [];
      return requests.filter((entry) => entry.origin === activeOrigin
        && entry.loaderId === activeLoaderId);
    },
    dispose() {
      unsubscribe?.();
    },
  });
}

function selectRequiredRefreshLoader(refreshObserver, loaderId) {
  if (typeof loaderId !== "string"
      || loaderId.length === 0
      || refreshObserver.selectLoader(loaderId) !== loaderId) {
    fail(
      ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.boundaryInvalid,
      "startup_refresh",
    );
  }
}

async function bindMacSmokeRefreshObserver(cdp, refreshObserver, expectedOrigin) {
  const binding = await waitFor(async () => {
    const loaderId = await mainFrameLoaderId(cdp);
    const value = await cdp.evaluate("location.href");
    try {
      const parsed = new URL(value);
      return typeof loaderId === "string"
        && loaderId.length > 0
        && isExactMacLoopbackOrigin(parsed.origin)
        && parsed.origin === expectedOrigin
        && parsed.pathname === "/"
        && parsed.search === ""
        && parsed.hash === ""
        ? Object.freeze({ loaderId, origin: parsed.origin })
        : null;
    } catch {
      return null;
    }
  }, MAX_STARTUP_MS, "Electron dashboard origin");
  selectRequiredRefreshLoader(refreshObserver, binding.loaderId);
  if (refreshObserver.selectOrigin(binding.origin) !== expectedOrigin) {
    fail("ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID", "dashboard");
  }
  return binding;
}

async function releaseMacSmokeRefreshGate(cdp) {
  const released = await cdp.evaluate(`(() => {
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
  })()`);
  if (released !== true) {
    fail(
      ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.boundaryInvalid,
      "startup_refresh",
    );
  }
}

export function classifyAutomaticStartupRefreshReceipt({
  phase,
  requestCount,
  refresh,
  previousRefreshId = null,
  expectedRefreshId = null,
} = {}) {
  const codes = ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES;
  if (!Number.isInteger(requestCount) || requestCount < 0 || requestCount > 1) {
    return Object.freeze({ status: "failed", errorCode: codes.duplicate });
  }
  if (requestCount === 0 && phase === "acceptance") return Object.freeze({ status: "pending" });
  if (requestCount === 0) return Object.freeze({ status: "failed", errorCode: codes.duplicate });
  if (refresh?.status === "idle") return Object.freeze({ status: "pending" });
  if (typeof refresh?.refreshId !== "string" || refresh.refreshId.length === 0) {
    return Object.freeze({ status: "failed", errorCode: codes.invalidReceipt });
  }
  if (phase === "acceptance") {
    if (refresh.refreshId === previousRefreshId) return Object.freeze({ status: "pending" });
    return Object.freeze({ status: "accepted", refreshId: refresh.refreshId });
  }
  if (phase !== "completion" || refresh.refreshId !== expectedRefreshId) {
    return Object.freeze({ status: "failed", errorCode: codes.changedReceipt });
  }
  if (refresh.status === "succeeded") {
    return Object.freeze({
      status: "completed",
      refreshId: refresh.refreshId,
      terminalStatus: "succeeded",
    });
  }
  if (refresh.status === "degraded") {
    const generation = refresh.result?.unifiedIndex?.generation;
    const accounting = refresh.result?.accounting;
    const coherent = refresh.errorCode === "refresh_degraded"
      && refresh.failedStep === "unified_index"
      && DEGRADED_FAILURE_CODE_SET.has(refresh.failureCode)
      && refresh.result?.unifiedIndex?.status === "ingested"
      && generation?.status === "partial"
      && generation?.blockReason === "codex_rollout_sources_quarantined"
      && Number.isSafeInteger(generation.skippedSourceCount)
      && generation.skippedSourceCount > 0
      && Number.isSafeInteger(generation.skippedThreadCount)
      && generation.skippedThreadCount > 0
      && Number.isSafeInteger(generation.reasonCounts?.[refresh.failureCode])
      && generation.reasonCounts[refresh.failureCode] > 0
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
    return coherent
      ? Object.freeze({
        status: "completed",
        refreshId: refresh.refreshId,
        terminalStatus: "degraded",
        degradedFailureCode: refresh.failureCode,
      })
      : Object.freeze({
        status: "failed",
        errorCode: codes.degradedInvalid,
      });
  }
  if (refresh.status === "failed") return Object.freeze({ status: "failed", errorCode: codes.failed });
  if (refresh.status === "cancelled") {
    return Object.freeze({ status: "failed", errorCode: codes.cancelled });
  }
  return Object.freeze({ status: "pending", refreshId: refresh.refreshId });
}

async function assertAutomaticStartupRefresh({
  child,
  dashboardUrl,
  refreshObserver,
  previousRefreshId = null,
}) {
  const refreshUrl = new URL("/api/local/refresh", dashboardUrl);
  let refreshId = null;
  let terminalStatus = null;
  let degradedFailureCode = null;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("ELECTRON_MACOS_SMOKE_EXITED_BEFORE_REFRESH", "startup_refresh");
    }
    const requests = refreshObserver.snapshot();
    if (requests.length === 0) return null;
    const status = await jsonFetch(refreshUrl);
    const decision = classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: requests.length,
      refresh: status?.refresh,
      previousRefreshId,
    });
    if (decision.status === "pending") return null;
    if (decision.status === "failed") fail(decision.errorCode, "startup_refresh");
    refreshId = decision.refreshId;
    return true;
  }, MAX_REFRESH_MS, "automatic startup refresh acceptance");

  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("ELECTRON_MACOS_SMOKE_EXITED_DURING_REFRESH", "startup_refresh");
    }
    const requests = refreshObserver.snapshot();
    if (requests.length !== 1) {
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: requests.length,
        expectedRefreshId: refreshId,
      });
      if (decision.status === "failed") fail(decision.errorCode, "startup_refresh");
      return false;
    }
    const status = await jsonFetch(refreshUrl);
    const decision = classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: requests.length,
      refresh: status?.refresh,
      expectedRefreshId: refreshId,
    });
    if (decision.status === "pending") return false;
    if (decision.status === "failed") fail(decision.errorCode, "startup_refresh");
    terminalStatus = decision.terminalStatus;
    degradedFailureCode = decision.degradedFailureCode ?? null;
    return true;
  }, MAX_REFRESH_MS, "automatic startup refresh completion");
  refreshObserver.seal();
  return Object.freeze({
    requestCount: refreshObserver.snapshot().length,
    originBound: true,
    activeLoaderBound: true,
    refreshIdChanged: true,
    terminalStatus,
    degradedFailureCode,
  });
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

/**
 * A cost row is meaningful only when it carries a positive amount or names
 * why an amount cannot be priced.  A bare em dash (or a formatted $0.00) is
 * the renderer's placeholder for withheld pricing, not parity evidence: it
 * would let an empty/stale cost table satisfy the packaged smoke.
 */
export function hasMeaningfulMacCostEvidence(value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return false;
  const matches = text.match(
    /(?:^|[^0-9])([1-9][0-9]*(?:[.,][0-9]+)?|0\.[0-9]+)/u,
  );
  if (matches !== null && Number(matches[1].replace(",", ".")) > 0) {
    return true;
  }
  return /\b(?:unavailable|not\s+(?:priced|reported|available|provided)|(?:no|without)\s+(?:published\s+)?price|(?:price|cost)\s+(?:unavailable|withheld|not\s+(?:available|provided))|separate\s+allowance|withheld)\b/iu.test(text);
}

function isPlainSmokeRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactSmokeKeys(value, keys) {
  return isPlainSmokeRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function looksLikeAbsoluteSmokePath(value) {
  return typeof value === "string"
    && (/^\//u.test(value)
      || /^[A-Za-z]:[\\/]/u.test(value)
      || /^\\\\/u.test(value));
}

function containsSmokePath(value, seen = new Set()) {
  if (typeof value === "string") return looksLikeAbsoluteSmokePath(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsSmokePath(entry, seen));
  return Object.entries(value).some(([key, entry]) => /path/iu.test(key)
    || containsSmokePath(entry, seen));
}

/**
 * Validate the renderer-facing Codex-root metadata projection.  This is kept
 * deliberately stricter than a "no path property" check: every root must use
 * the path-free shape, and unexpected path-like values anywhere in the
 * generic desktop snapshot fail the smoke.
 */
export function isMacPathFreeSettingsSnapshot(value) {
  if (!isPlainSmokeRecord(value)) return false;
  const settings = isPlainSmokeRecord(value.settings) ? value.settings : value;
  const homes = settings.codexHomes;
  if (!isPlainSmokeRecord(homes)
      || !hasExactSmokeKeys(homes, ["activityRoots", "primaryRootId"])
      || !Array.isArray(homes.activityRoots)
      || homes.activityRoots.length < 1
      || homes.activityRoots.length > MACOS_SMOKE_CODEX_ROOT_LIMIT
      || !MACOS_SMOKE_CODEX_ROOT_ID_PATTERN.test(homes.primaryRootId)) {
    return false;
  }
  const ids = new Set();
  for (const root of homes.activityRoots) {
    if (!hasExactSmokeKeys(root, ["rootId", "kind", "enabled"])
        || !MACOS_SMOKE_CODEX_ROOT_ID_PATTERN.test(root.rootId)
        || !["default", "custom"].includes(root.kind)
        || root.enabled !== true
        || ids.has(root.rootId)) {
      return false;
    }
    ids.add(root.rootId);
  }
  return ids.has(homes.primaryRootId) && !containsSmokePath(value);
}

/** Validate the settings-only projection, which may carry pathful roots. */
export function isMacPathfulCodexHomes(value) {
  if (!isPlainSmokeRecord(value)
      || !hasExactSmokeKeys(value, ["activityRoots", "primaryRootId"])
      || !Array.isArray(value.activityRoots)
      || value.activityRoots.length < 1
      || value.activityRoots.length > MACOS_SMOKE_CODEX_ROOT_LIMIT
      || !MACOS_SMOKE_CODEX_ROOT_ID_PATTERN.test(value.primaryRootId)) {
    return false;
  }
  const ids = new Set();
  let primaryCount = 0;
  let defaultCount = 0;
  for (const root of value.activityRoots) {
    if (!hasExactSmokeKeys(root, ["rootId", "kind", "path", "enabled"])
        || !MACOS_SMOKE_CODEX_ROOT_ID_PATTERN.test(root.rootId)
        || !["default", "custom"].includes(root.kind)
        || root.enabled !== true
        || ids.has(root.rootId)) {
      return false;
    }
    ids.add(root.rootId);
    if (root.rootId === value.primaryRootId) primaryCount += 1;
    if (root.kind === "default") {
      if (++defaultCount > 1
          || root.rootId !== DESKTOP_DEFAULT_CODEX_ROOT_ID
          || root.path !== null) {
        return false;
      }
    } else if (root.rootId === DESKTOP_DEFAULT_CODEX_ROOT_ID
        || !looksLikeAbsoluteSmokePath(root.path)) {
      return false;
    }
  }
  return ids.has(value.primaryRootId) && primaryCount === 1;
}

/**
 * Classify only content-free Settings evidence.  The returned object is safe
 * to put in a smoke receipt: it contains counts/booleans, never root paths or
 * renderer snapshots.
 */
export function classifyMacSettingsEvidence({
  rootCount = 0,
  renderedRootCount = 0,
  primaryRadioCount = 0,
  selectedPrimaryCount = 0,
  primaryCardCount = 0,
  selectedPrimaryRootId = null,
  listRole = false,
  cardsHaveSemantics = false,
  addPresent = false,
  addDisabled = true,
  genericSettings = null,
  genericDashboardSettings = null,
  pathfulRoots = null,
} = {}) {
  const normalizedRootCount = Number.isInteger(rootCount) ? rootCount : 0;
  const normalizedRenderedRootCount = Number.isInteger(renderedRootCount)
    ? renderedRootCount
    : 0;
  const belowLimit = normalizedRootCount >= 1
    && normalizedRootCount < MACOS_SMOKE_CODEX_ROOT_LIMIT;
  const genericSnapshotPathFree = isMacPathFreeSettingsSnapshot(genericSettings)
    && isMacPathFreeSettingsSnapshot(genericDashboardSettings);
  const pathfulRead = isMacPathfulCodexHomes(pathfulRoots);
  const genericHomes = isPlainSmokeRecord(genericSettings?.settings)
    ? genericSettings.settings.codexHomes
    : genericSettings?.codexHomes;
  const genericDashboardHomes = isPlainSmokeRecord(genericDashboardSettings?.settings)
    ? genericDashboardSettings.settings.codexHomes
    : genericDashboardSettings?.codexHomes;
  const primaryIdentityMatches = typeof selectedPrimaryRootId === "string"
    && selectedPrimaryRootId === genericHomes?.primaryRootId
    && selectedPrimaryRootId === genericDashboardHomes?.primaryRootId
    && selectedPrimaryRootId === pathfulRoots?.primaryRootId;
  const primarySelected = normalizedRootCount >= 1
    && primaryRadioCount === normalizedRootCount
    && selectedPrimaryCount === 1
    && primaryCardCount === 1
    && primaryIdentityMatches;
  const listSemantics = listRole === true && cardsHaveSemantics === true;
  const addEnabled = addPresent === true && addDisabled === false;
  const addSemantics = addPresent === true
    && (belowLimit ? addDisabled === false : addDisabled === true);
  const pathfulRootCount = Array.isArray(pathfulRoots?.activityRoots)
    ? pathfulRoots.activityRoots.length
    : 0;
  const genericRootCount = Array.isArray(genericSettings?.settings?.codexHomes?.activityRoots)
    ? genericSettings.settings.codexHomes.activityRoots.length
    : Array.isArray(genericSettings?.codexHomes?.activityRoots)
      ? genericSettings.codexHomes.activityRoots.length
      : 0;
  const genericDashboardRootCount = Array.isArray(
    genericDashboardSettings?.settings?.codexHomes?.activityRoots,
  )
    ? genericDashboardSettings.settings.codexHomes.activityRoots.length
    : Array.isArray(genericDashboardSettings?.codexHomes?.activityRoots)
      ? genericDashboardSettings.codexHomes.activityRoots.length
      : 0;
  const status = normalizedRootCount >= 1
    && normalizedRenderedRootCount >= 1
    && normalizedRenderedRootCount === normalizedRootCount
    && primarySelected
    && listSemantics
    && addSemantics
    && genericSnapshotPathFree
    && pathfulRead
    && pathfulRootCount === normalizedRootCount
    && genericRootCount === normalizedRootCount
    && genericDashboardRootCount === normalizedRootCount;

  return Object.freeze({
    status: status ? "passed" : "failed",
    rootCount: normalizedRootCount,
    renderedRootCount: normalizedRenderedRootCount,
    primarySelected,
    listSemantics,
    addPresent: addPresent === true,
    addEnabled,
    genericSnapshotPathFree,
    pathfulRead,
  });
}

async function assertDashboardShell(cdp) {
  const snapshot = await cdp.evaluate(`(() => {
    const visible = ${visible.toString()};
    const navLinks = [...document.querySelectorAll("[data-nav]")];
    return {
      topbar: visible(document.querySelector(".topbar")),
      sidebar: visible(document.querySelector(".dashboard-sidebar")),
      navCount: navLinks.length,
      activeLinkCount: navLinks.filter((link) => link.classList.contains("active")
        && link.getAttribute("aria-current") === "page").length,
      activePageCount: document.querySelectorAll(
        ".dashboard-section[data-dashboard-page]:not(.dashboard-page-inactive)",
      ).length,
      refresh: Boolean(document.querySelector("#refresh-button")),
      share: Boolean(document.querySelector("#electron-share-button")),
      settings: Boolean(document.querySelector("#electron-settings-button")),
    };
  })()`);
  if (snapshot?.topbar !== true
      || snapshot?.sidebar !== true
      || snapshot?.navCount !== 5
      || snapshot?.activeLinkCount !== 1
      || snapshot?.activePageCount !== 1
      || snapshot?.refresh !== true
      || snapshot?.share !== true
      || snapshot?.settings !== true) {
    fail("ELECTRON_MACOS_SMOKE_DASHBOARD_CHROME_INVALID", "dashboard");
  }
  return Object.freeze({
    chrome: true,
    navCount: snapshot.navCount,
  });
}

async function assertDashboardData(cdp) {
  try {
    await waitFor(async () => {
      const candidate = await cdp.evaluate(`(() => {
        const latest = document.querySelector("#latest-observation")
          ?.textContent?.trim() ?? "";
        const source = document.querySelector("#data-source")
          ?.textContent?.trim() ?? "";
        const state = document.querySelector("#global-state")
          ?.textContent?.trim() ?? "";
        const setup = document.querySelector("#setup-card");
        return {
          latest,
          source,
          state,
          setupVisible: setup?.hidden === false,
          dataFlow: source.toLowerCase().includes("local companion")
            && latest.length > 0
            && latest !== "Checking…",
        };
      })()`);
      return candidate?.dataFlow === true ? candidate : null;
    }, MAX_REFRESH_MS, "dashboard data render");
  } catch {
    fail("ELECTRON_MACOS_SMOKE_DASHBOARD_DATA_INVALID", "dashboard");
  }
  return Object.freeze({
    dataFlow: true,
  });
}

function usageParitySnapshotValid(snapshot) {
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
    && snapshot?.priceCoverage === true
    && snapshot?.advancedModuleShellCount === 3
    && snapshot?.advancedModulesReady === true;
}

function communityParitySnapshotValid(snapshot, health, { requirePartialDetail = false } = {}) {
  return health?.capabilities?.contributionDevicePairing === true
    && health?.capabilities?.incrementalContributionSync
      === "telemetry-contribution-v1.0"
    && snapshot?.route === "#community"
    && snapshot?.pageVisible === true
    && snapshot?.journeyStageCount === 2
    && snapshot?.indexTerminal === true
    && snapshot?.indexDetail === true
    && (!requirePartialDetail || snapshot?.partialHistoryDetail === true)
    && snapshot?.googleButton === true
    && snapshot?.appleButton === true
    && snapshot?.currentLayout === true
    && snapshot?.noServiceCopy === false;
}

export function classifyMacDashboardParityEvidence({
  health = {},
  usage = {},
  community = {},
  startupRefresh = {},
} = {}) {
  if (!usageParitySnapshotValid(usage)) {
    return Object.freeze({ status: "failed", reason: "usage" });
  }
  if (!communityParitySnapshotValid(community, health, {
    requirePartialDetail: startupRefresh.terminalStatus === "degraded",
  })) {
    return Object.freeze({ status: "failed", reason: "community" });
  }
  return Object.freeze({ status: "passed", reason: null });
}

async function assertDashboardParitySurfaces(cdp, health, startupRefresh = {}) {

  const usage = await waitFor(async () => {
    const snapshot = await cdp.evaluate(`(() => {
      const visible = ${visible.toString()};
      const positiveNumber = (value) => {
        const matches = String(value ?? "").match(/(?:^|[^0-9])([1-9][0-9]*(?:[.,][0-9]+)?|0\\.[0-9]+)/u);
        return matches !== null
          && Number(matches[1].replace(",", ".")) > 0;
      };
      const meaningfulRows = (selector, { costEvidence = false } = {}) => {
        const rows = [...document.querySelectorAll(selector)];
        return rows.filter((row) => {
          const text = row.textContent?.trim() ?? "";
          if (text.length === 0) return false;
          if (costEvidence) return ${hasMeaningfulMacCostEvidence.toString()}(text);
          if (positiveNumber(text)) return true;
          return false;
        }).length;
      };
      const advancedSelectors = [
        "#cache-switch-details",
        "#cache-reuse-outcome",
        "#cache-continuity-details",
      ];
      const advancedModules = advancedSelectors.map((selector) => {
        const element = document.querySelector(selector);
        const text = element?.textContent?.trim() ?? "";
        return {
          present: element !== null,
          visible: visible(element),
          explicitContent: text.length > 0,
          explicitUnavailable: /no eligible|no .* (?:available|priced|reported)|unavailable|not available|insufficient/iu.test(text),
        };
      });
      const indexDetail = document.querySelector("#journey-stage-index-detail")
        ?.textContent?.trim() ?? "";
      document.querySelector('[data-nav="method"]')?.click();
      const page = document.querySelector('#accounting[data-dashboard-page="method"]');
      const tokenRows = document.querySelectorAll('#accounting-component-counts .component-row');
      const costRows = document.querySelectorAll('#accounting-component-costs .component-row');
      const modelRows = [...document.querySelectorAll('#accounting-models > tr')]
        .filter((row) => row.querySelector(
          ':scope > .model-identity:not(.model-component-identity)',
        ));
      const priceCoverage = document.querySelector('#accounting-price-coverage');
      return {
        route: location.hash,
        pageVisible: visible(page) && page?.inert !== true,
        periodCount: document.querySelectorAll('#accounting-period-controls [data-period]').length,
        summaryCardCount: document.querySelectorAll('#accounting-summary .metric-card').length,
        tokenCountRows: tokenRows.length,
        costContributionRows: costRows.length,
        modelIdentityRows: modelRows.length,
        meaningfulTokenRows: meaningfulRows('#accounting-component-counts .component-row'),
        meaningfulCostRows: meaningfulRows('#accounting-component-costs .component-row', {
          costEvidence: true,
        }),
        meaningfulModelRows: modelRows.filter((row) => [...row.querySelectorAll(
          ':scope > .numeric-cell',
        )].some((cell) => positiveNumber(cell.textContent))).length,
        priceCoverage: visible(priceCoverage)
          && (priceCoverage.textContent?.trim() ?? "").length > 0,
        advancedModuleShellCount: advancedModules.filter((module) => module.present).length,
        advancedModuleAvailableCount: advancedModules.filter(
          (module) => module.visible
            && module.explicitContent
            && !module.explicitUnavailable,
        ).length,
        advancedModuleUnavailableCount: advancedModules.filter(
          (module) => module.visible
            && module.explicitContent
            && module.explicitUnavailable,
        ).length,
        advancedModulesReady: advancedModules.length === 3
          && advancedModules.every((module) => module.present
            && module.visible
            && module.explicitContent),
        indexDetail: indexDetail.length > 0,
        partialHistoryDetail: /partial|quarantined/iu.test(indexDetail),
      };
    })()`);
    return usageParitySnapshotValid(snapshot) ? snapshot : null;
  }, MAX_OPERATION_MS, "Usage parity surfaces").catch(() => null);
  if (usage === null) {
    fail("ELECTRON_MACOS_SMOKE_USAGE_PARITY_INVALID", "parity");
  }

  const community = await waitFor(async () => {
    const snapshot = await cdp.evaluate(`(() => {
      const visible = ${visible.toString()};
      document.querySelector('[data-nav="community"]')?.click();
      const page = document.querySelector('#community[data-dashboard-page="community"]');
      const pageText = page?.textContent?.toLowerCase() ?? '';
      const indexDetail = document.querySelector('#journey-stage-index-detail')
        ?.textContent?.trim() ?? '';
      const nextAction = document.querySelector('#identity-signin-next');
      const consent = document.querySelector('#incremental-consent');
      return {
        route: location.hash,
        pageVisible: visible(page) && page?.inert !== true,
        journeyStageCount: document.querySelectorAll('#community-journey .journey-stage').length,
        indexTerminal: document.querySelector('#journey-stage-index')
          ?.classList?.contains('journey-stage-done') === true,
        indexDetail: indexDetail.length > 0,
        partialHistoryDetail: /partial|quarantined/iu.test(indexDetail),
        googleButton: visible(document.querySelector('#identity-google-signin')),
        appleButton: visible(document.querySelector('#identity-apple-signin')),
        currentLayout: visible(nextAction)
          && (nextAction.textContent?.trim() ?? '').length > 0
          && visible(consent)
          && (consent.textContent?.trim() ?? '').length > 0,
        noServiceCopy: pageText.includes('no contribution service'),
      };
    })()`);
    return communityParitySnapshotValid(snapshot, health) ? snapshot : null;
  }, MAX_OPERATION_MS, "Community parity surfaces").catch(() => null);
  if (community === null) {
    fail("ELECTRON_MACOS_SMOKE_COMMUNITY_PARITY_INVALID", "parity");
  }
  const classification = classifyMacDashboardParityEvidence({
    health,
    usage,
    community,
    startupRefresh,
  });
  if (classification.status !== "passed") {
    fail(
      classification.reason === "community"
        ? "ELECTRON_MACOS_SMOKE_COMMUNITY_PARITY_INVALID"
        : "ELECTRON_MACOS_SMOKE_USAGE_PARITY_INVALID",
      "parity",
    );
  }

  return Object.freeze({
    usage: Object.freeze({
      pageVisible: true,
      periodCount: usage.periodCount,
      summaryCardCount: usage.summaryCardCount,
      tokenCountRows: usage.tokenCountRows,
      costContributionRows: usage.costContributionRows,
      modelIdentityRows: usage.modelIdentityRows,
      meaningfulTokenRows: usage.meaningfulTokenRows,
      meaningfulCostRows: usage.meaningfulCostRows,
      meaningfulModelRows: usage.meaningfulModelRows,
      priceCoverage: usage.priceCoverage,
      advancedModuleShells: usage.advancedModuleShellCount === 3,
      advancedModulesAvailable: usage.advancedModuleAvailableCount,
      advancedModulesUnavailable: usage.advancedModuleUnavailableCount,
      advancedModulesReady: usage.advancedModulesReady,
    }),
    community: Object.freeze({
      pageVisible: true,
      serviceConfigured: true,
      journeyStageCount: community.journeyStageCount,
      currentLayout: true,
      providerControls: true,
      indexTerminal: true,
      partialHistoryDetail: community.partialHistoryDetail,
    }),
  });
}

/**
 * Select only the main dashboard page for this smoke's ephemeral server.
 *
 * Electron exposes loading, recovery, settings, and other renderer targets
 * through the same /json endpoint.  A page target is not sufficient evidence
 * of the dashboard: the URL must be the exact loopback root for this run, so
 * a stale page cannot be mistaken for the document whose loader and network
 * requests we qualify below.
 */
export function isMacDashboardTarget(target, debugPort) {
  if (target === null
      || typeof target !== "object"
      || Array.isArray(target)
      || target.type !== "page"
      || typeof target.webSocketDebuggerUrl !== "string"
      || target.webSocketDebuggerUrl.length === 0
      || !Number.isInteger(debugPort)
      || debugPort < 1
      || debugPort > 65_535
      || typeof target.url !== "string") {
    return false;
  }
  let parsed;
  let websocket;
  try {
    parsed = new URL(target.url);
    websocket = new URL(target.webSocketDebuggerUrl);
  } catch {
    return false;
  }
  const dashboardPort = Number(parsed.port);
  return parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && Number.isInteger(dashboardPort)
    && dashboardPort >= 1
    && dashboardPort <= 65_535
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.username === ""
    && parsed.password === ""
    && websocket.protocol === "ws:"
    && websocket.hostname === "127.0.0.1"
    && websocket.port === String(debugPort)
    && /^\/devtools\/page\//u.test(websocket.pathname)
    && websocket.search === ""
    && websocket.hash === ""
    && websocket.username === ""
    && websocket.password === "";
}

export function selectMacDashboardTarget(targets, debugPort) {
  if (!Array.isArray(targets)) return undefined;
  return targets.find((target) => isMacDashboardTarget(target, debugPort));
}

function isExactMacLoopbackOrigin(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const port = Number(parsed.port);
  return parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && Number.isInteger(port)
    && port >= 1
    && port <= 65_535
    && parsed.origin === value
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.username === ""
    && parsed.password === "";
}

/**
 * Select only the Settings page belonging to this smoke's dashboard origin
 * and remote-debugging endpoint.  Chromium can expose stale Settings,
 * recovery, or hostile page targets through the same /json list, so a path
 * suffix alone is not a safe binding.
 */
export function isMacSettingsTarget(target, dashboardOrigin, debugPort) {
  if (target === null
      || typeof target !== "object"
      || Array.isArray(target)
      || target.type !== "page"
      || typeof target.url !== "string"
      || typeof target.webSocketDebuggerUrl !== "string"
      || target.webSocketDebuggerUrl.length === 0
      || !isExactMacLoopbackOrigin(dashboardOrigin)
      || !Number.isInteger(debugPort)
      || debugPort < 1
      || debugPort > 65_535) {
    return false;
  }
  let parsed;
  let websocket;
  try {
    parsed = new URL(target.url);
    websocket = new URL(target.webSocketDebuggerUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && parsed.origin === dashboardOrigin
    && parsed.pathname === "/electron-settings.html"
    && parsed.search === ""
    && parsed.username === ""
    && parsed.password === ""
    && websocket.protocol === "ws:"
    && websocket.hostname === "127.0.0.1"
    && websocket.port === String(debugPort)
    && /^\/devtools\/page\//u.test(websocket.pathname)
    && websocket.search === ""
    && websocket.hash === ""
    && websocket.username === ""
    && websocket.password === "";
}

export function selectMacSettingsTarget(targets, dashboardOrigin, debugPort) {
  if (!Array.isArray(targets)) return undefined;
  return targets.find((target) => isMacSettingsTarget(target, dashboardOrigin, debugPort));
}

async function assertShareFlow(cdp) {
  const share = await waitFor(async () => {
    const snapshot = await cdp.evaluate(`(() => {
    document.querySelector("#electron-share-button")?.click();
    const panel = document.querySelector("#share-panel");
    const canvas = document.querySelector("#share-card-canvas");
    return {
      route: location.hash,
      panelVisible: ${visible.toString()}(panel),
      panelFocused: document.activeElement === panel,
      canvas: Boolean(canvas) && canvas.width > 0 && canvas.height > 0
        && ${visible.toString()}(canvas),
      save: Boolean(document.querySelector("#share-card-download")),
      copy: Boolean(document.querySelector("#share-card-copy")),
    };
  })()`);
    return snapshot?.route === "#weekly"
      && snapshot?.panelVisible === true
      && snapshot?.panelFocused === true
      && snapshot?.canvas === true
      && snapshot?.save === true
      && snapshot?.copy === true
      ? snapshot
      : null;
  }, MAX_OPERATION_MS, "Share panel");
  if (share?.route !== "#weekly"
      || share?.panelVisible !== true
      || share?.panelFocused !== true
      || share?.canvas !== true
      || share?.save !== true
      || share?.copy !== true) {
    fail("ELECTRON_MACOS_SMOKE_SHARE_FLOW_INVALID", "share");
  }
  return Object.freeze({
    route: "#weekly",
    panelVisible: true,
    panelFocused: true,
    canvas: true,
  });
}

async function findSettingsTarget(port, dashboardOrigin) {
  const targets = await jsonFetch(`http://127.0.0.1:${port}/json`);
  return selectMacSettingsTarget(targets, dashboardOrigin, port);
}

async function assertSettingsFlow(cdp, port, dashboardOrigin) {
  const genericDashboardSettings = await cdp.evaluate(
    "globalThis.tibotattleDesktop?.getSettings?.()",
  );
  await cdp.evaluate("document.querySelector('#electron-settings-button')?.click()");
  const target = await waitFor(
    () => findSettingsTarget(port, dashboardOrigin),
    MAX_STARTUP_MS,
    "Electron Settings target",
  );
  const settingsCdp = await connectCdp(target);
  try {
    await settingsCdp.request("Page.enable");
    const state = await waitFor(async () => {
      const snapshot = await settingsCdp.evaluate(`(() => {
      const status = document.querySelector("#settings-bridge-status");
      const tabs = [...document.querySelectorAll("[data-settings-tab]")];
      const general = document.querySelector('[data-settings-panel="general"]');
      return {
        title: document.title,
        connected: status?.classList.contains("is-ready") === true,
        tabCount: tabs.length,
        generalVisible: general?.hidden === false,
      };
    })()`);
      return snapshot?.title === "TiboTattle Settings"
        && snapshot?.connected === true
        && snapshot?.tabCount === 3
        && snapshot?.generalVisible === true
        ? snapshot
        : null;
    }, MAX_STARTUP_MS, "Electron Settings render");
    if (state?.title !== "TiboTattle Settings"
        || state?.connected !== true
        || state?.tabCount !== 3
        || state?.generalVisible !== true) {
      fail("ELECTRON_MACOS_SMOKE_SETTINGS_FLOW_INVALID", "settings");
    }
    const tabs = await settingsCdp.evaluate(`(() => {
      const notifications = document.querySelector('[data-settings-tab="notifications"]');
      const about = document.querySelector('[data-settings-tab="about"]');
      notifications?.click();
      const notificationsVisible = document.querySelector(
        '[data-settings-panel="notifications"]',
      )?.hidden === false;
      about?.click();
      const aboutVisible = document.querySelector(
        '[data-settings-panel="about"]',
      )?.hidden === false;
      return { notificationsVisible, aboutVisible };
    })()`);
    if (tabs?.notificationsVisible !== true || tabs?.aboutVisible !== true) {
      fail("ELECTRON_MACOS_SMOKE_SETTINGS_TABS_INVALID", "settings");
    }
    // The root list lives on General. Return to that panel before collecting
    // rendered-root evidence; otherwise a semantically correct list would be
    // hidden behind the About tab and look like an empty UI.
    await settingsCdp.evaluate(
      "document.querySelector('[data-settings-tab=\"general\"]')?.click(); true",
    );
    const evidence = await settingsCdp.evaluate(`(async () => {
      const visible = ${visible.toString()};
      const list = document.querySelector("#settings-codex-roots");
      const cards = list === null
        ? []
        : [...list.children].filter((element) => element.getAttribute("role") === "listitem");
      const radios = [...document.querySelectorAll(
        '#settings-codex-roots input[type="radio"][name="settings-primary-codex-root"]',
      )];
      const selected = radios.filter((input) => input.checked === true);
      const primaryCards = cards.filter((card) => card.dataset.primary === "true");
      const cardsHaveSemantics = cards.length > 0 && cards.every((card) => {
        const heading = card.querySelector("h4");
        const radio = card.querySelector(
          'input[type="radio"][name="settings-primary-codex-root"]',
        );
        return heading !== null
          && typeof heading.id === "string"
          && heading.id.startsWith("settings-codex-root-")
          && card.getAttribute("aria-labelledby") === heading.id
          && radio !== null
          && typeof radio.value === "string"
          && radio.value.length > 0;
      });
      const genericSettings = await globalThis.tibotattleDesktop?.getSettings?.();
      const pathfulRoots = await globalThis.tibotattleDesktop?.getCodexHomesForSettings?.();
      return {
        rootCount: cards.length,
        renderedRootCount: cards.filter(visible).length,
        primaryRadioCount: radios.length,
        selectedPrimaryCount: selected.length,
        selectedPrimaryRootId: selected.length === 1 ? selected[0].value : null,
        primaryCardCount: primaryCards.length,
        listRole: list?.getAttribute("role") === "list",
        cardsHaveSemantics,
        addPresent: document.querySelector("#settings-add-codex-root") !== null,
        addDisabled: document.querySelector("#settings-add-codex-root")?.disabled === true,
        genericSettings,
        pathfulRoots,
      };
    })()`);
    evidence.genericDashboardSettings = genericDashboardSettings;
    const settingsEvidence = classifyMacSettingsEvidence(evidence);
    if (settingsEvidence.status !== "passed") {
      fail("ELECTRON_MACOS_SMOKE_SETTINGS_FLOW_INVALID", "settings");
    }
    return Object.freeze({
      connected: true,
      tabCount: 3,
      tabs: true,
      rootCount: settingsEvidence.rootCount,
      renderedRootCount: settingsEvidence.renderedRootCount,
      primarySelected: settingsEvidence.primarySelected,
      listSemantics: settingsEvidence.listSemantics,
      addPresent: settingsEvidence.addPresent,
      addEnabled: settingsEvidence.addEnabled,
      genericSnapshotPathFree: settingsEvidence.genericSnapshotPathFree,
      pathfulRead: settingsEvidence.pathfulRead,
    });
  } finally {
    settingsCdp.close();
  }
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

const SMOKE_PROGRESS_KEYS = new Set([
  "dashboard",
  "startupRefresh",
  "parity",
  "share",
  "settings",
]);

function recordSmokeProgress(progress, key, value) {
  if (progress === null
      || typeof progress !== "object"
      || Array.isArray(progress)
      || !SMOKE_PROGRESS_KEYS.has(key)) {
    return;
  }
  progress[key] = value;
}

/** Return only allowlisted, content-free fields suitable for persistence. */
export function buildClosedReceipt({
  status = "passed",
  cleanQuit = false,
  startupRefresh = {},
  dashboard = {},
  parity = {},
  settings = {},
  share = {},
  failureStage = null,
  failureReason = null,
} = {}) {
  const normalizedStatus = status === "passed" ? "passed" : "failed";
  const normalizedStage = FAILURE_STAGES.has(failureStage) ? failureStage : null;
  const normalizedReason = normalizedStatus === "failed"
    ? (ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes(failureReason)
      ? failureReason
      : "runtime_failed")
    : null;
  return Object.freeze({
    schemaVersion: MACOS_SMOKE_SCHEMA_VERSION,
    status: normalizedStatus,
    target: "darwin-arm64-electron-app",
    qualification: "development-only",
    cleanQuit: cleanQuit === true,
    contentFree: true,
    failureStage: normalizedStage,
    failureReason: normalizedReason,
    startupRefresh: Object.freeze({
      requestCount: Number.isInteger(startupRefresh.requestCount)
        ? startupRefresh.requestCount
        : 0,
      originBound: startupRefresh.originBound === true,
      activeLoaderBound: startupRefresh.activeLoaderBound === true,
      refreshIdChanged: startupRefresh.refreshIdChanged === true,
      terminalStatus: startupRefresh.terminalStatus === "succeeded"
        ? "succeeded"
        : startupRefresh.terminalStatus === "degraded"
          && DEGRADED_FAILURE_CODE_SET.has(startupRefresh.degradedFailureCode)
          ? "degraded"
          : "unknown",
      degradedFailureCode: startupRefresh.terminalStatus === "degraded"
          && DEGRADED_FAILURE_CODE_SET.has(startupRefresh.degradedFailureCode)
        ? startupRefresh.degradedFailureCode
        : null,
    }),
    dashboard: Object.freeze({
      chrome: dashboard.chrome === true,
      dataFlow: dashboard.dataFlow === true,
      navCount: Number.isInteger(dashboard.navCount) ? dashboard.navCount : 0,
    }),
    parity: Object.freeze({
      usage: Object.freeze({
        pageVisible: parity.usage?.pageVisible === true,
        periodCount: Number.isInteger(parity.usage?.periodCount)
          ? parity.usage.periodCount
          : 0,
        summaryCardCount: Number.isInteger(parity.usage?.summaryCardCount)
          ? parity.usage.summaryCardCount
          : 0,
        tokenCountRows: Number.isInteger(parity.usage?.tokenCountRows)
          ? parity.usage.tokenCountRows
          : 0,
        costContributionRows: Number.isInteger(parity.usage?.costContributionRows)
          ? parity.usage.costContributionRows
          : 0,
        modelIdentityRows: Number.isInteger(parity.usage?.modelIdentityRows)
          ? parity.usage.modelIdentityRows
          : 0,
        meaningfulTokenRows: Number.isInteger(parity.usage?.meaningfulTokenRows)
          ? parity.usage.meaningfulTokenRows
          : 0,
        meaningfulCostRows: Number.isInteger(parity.usage?.meaningfulCostRows)
          ? parity.usage.meaningfulCostRows
          : 0,
        meaningfulModelRows: Number.isInteger(parity.usage?.meaningfulModelRows)
          ? parity.usage.meaningfulModelRows
          : 0,
        priceCoverage: parity.usage?.priceCoverage === true,
        advancedModuleShells: parity.usage?.advancedModuleShells === true,
        advancedModulesAvailable: Number.isInteger(
          parity.usage?.advancedModulesAvailable,
        ) ? parity.usage.advancedModulesAvailable : 0,
        advancedModulesUnavailable: Number.isInteger(
          parity.usage?.advancedModulesUnavailable,
        ) ? parity.usage.advancedModulesUnavailable : 0,
        advancedModulesReady: parity.usage?.advancedModulesReady === true,
      }),
      community: Object.freeze({
        pageVisible: parity.community?.pageVisible === true,
        serviceConfigured: parity.community?.serviceConfigured === true,
        journeyStageCount: Number.isInteger(parity.community?.journeyStageCount)
          ? parity.community.journeyStageCount
          : 0,
        currentLayout: parity.community?.currentLayout === true,
        providerControls: parity.community?.providerControls === true,
        indexTerminal: parity.community?.indexTerminal === true,
        partialHistoryDetail: parity.community?.partialHistoryDetail === true,
      }),
    }),
    settings: Object.freeze({
      connected: settings.connected === true,
      tabCount: Number.isInteger(settings.tabCount) ? settings.tabCount : 0,
      tabs: settings.tabs === true,
      rootCount: Number.isInteger(settings.rootCount) ? settings.rootCount : 0,
      renderedRootCount: Number.isInteger(settings.renderedRootCount)
        ? settings.renderedRootCount
        : 0,
      primarySelected: settings.primarySelected === true,
      listSemantics: settings.listSemantics === true,
      addPresent: settings.addPresent === true,
      addEnabled: settings.addEnabled === true,
      genericSnapshotPathFree: settings.genericSnapshotPathFree === true,
      pathfulRead: settings.pathfulRead === true,
    }),
    share: Object.freeze({
      route: share.route === "#weekly" ? "#weekly" : "unknown",
      panelVisible: share.panelVisible === true,
      panelFocused: share.panelFocused === true,
      canvas: share.canvas === true,
    }),
  });
}

function appPathFromArguments(argumentsList = process.argv.slice(2)) {
  const index = argumentsList.indexOf("--app");
  if (index >= 0 && typeof argumentsList[index + 1] === "string") {
    return resolve(argumentsList[index + 1]);
  }
  const value = process.env.TIBOTATTLE_ELECTRON_APP
    ?? process.env.ELECTRON_MACOS_APP;
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

function receiptPathFromArguments(argumentsList = process.argv.slice(2)) {
  const index = argumentsList.indexOf("--receipt");
  if (index >= 0 && typeof argumentsList[index + 1] === "string") {
    return resolve(argumentsList[index + 1]);
  }
  const value = process.env.TIBOTATTLE_ELECTRON_MACOS_RECEIPT;
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

async function persistReceipt(receipt, destination) {
  if (destination === null) return;
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700).catch(() => {});
  const temporary = join(
    parent,
    `.${basename(destination)}.${process.pid}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, destination);
}

async function runSmoke(appPath, progress = {}) {
  await assertPackagedMacApp(appPath);
  const fixture = await createSyntheticFixture();
  const executable = join(appPath, "Contents", "MacOS", REQUIRED_APP_NAME);
  const environment = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    // A disposable HOME has no default login Keychain and makes macOS show a
    // destructive-looking "Keychain Not Found" dialog. Preserve only HOME;
    // all application, fixture, XDG, Claude, and temporary state stays below
    // this smoke's private root.
    HOME: process.env.HOME,
    TMPDIR: fixture.root,
    CODEX_HOME: fixture.codexHome,
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
    XDG_CACHE_HOME: fixture.cacheHome,
    XDG_RUNTIME_DIR: fixture.runtimeDirectory,
    USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: MACOS_SMOKE_CONTROL,
    USAGE_MONITOR_TEST_LANE: MACOS_LOCAL_QA_TEST_LANE,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  };
  let port = null;
  let child = null;
  let cdp = null;
  let refreshObserver = null;
  let stage = "launch";
  const progressRecord = progress !== null
    && typeof progress === "object"
    && !Array.isArray(progress)
    ? progress
    : {};
  let dashboardReceipt = {};
  let startupReceipt = {};
  let parityReceipt = {};
  let settingsReceipt = {};
  let shareReceipt = {};
  let cleanQuit = false;
  try {
    port = await freeTcpPort();
    child = spawn(executable, [
      `--user-data-dir=${fixture.userData}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ], {
      cwd: join(appPath, "Contents", "Resources"),
      env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
      stdio: "ignore",
    });
    // A missing executable or a launch-service rejection otherwise emits an
    // unhandled ChildProcess error before the bounded endpoint timeout can
    // classify the run and write its content-free failure receipt.
    child.on("error", () => {});
    if (!child.pid) fail("ELECTRON_MACOS_SMOKE_PROCESS_UNAVAILABLE", "launch");
    let version;
    try {
      version = await waitFor(
        () => jsonFetch(`http://127.0.0.1:${port}/json/version`),
        MAX_STARTUP_MS,
        "Electron remote debugging endpoint",
      );
    } catch {
      fail("ELECTRON_MACOS_SMOKE_REMOTE_DEBUGGING_UNAVAILABLE", "launch");
    }
    let target;
    try {
      target = await waitFor(async () => {
        const targets = await jsonFetch(`http://127.0.0.1:${port}/json`);
        return selectMacDashboardTarget(targets, port);
      }, MAX_STARTUP_MS, "Electron dashboard target");
    } catch {
      fail("ELECTRON_MACOS_SMOKE_DASHBOARD_TARGET_UNAVAILABLE", "dashboard");
    }
    let targetDashboardOrigin;
    try {
      const targetURL = new URL(target.url);
      if (!isExactMacLoopbackOrigin(targetURL.origin)
          || targetURL.pathname !== "/"
          || targetURL.search !== ""
          || targetURL.hash !== "") {
        fail("ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID", "dashboard");
      }
      targetDashboardOrigin = targetURL.origin;
    } catch {
      fail("ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID", "dashboard");
    }
    cdp = await connectCdp(target);
    refreshObserver = observeLocalRefreshRequests(cdp);
    const observedNetworkUrls = [];
    let networkEvidenceInvalid = false;
    const observeNetworkURL = (url) => {
      if (typeof url !== "string" || url.length === 0 || url.length > 2_048) {
        networkEvidenceInvalid = true;
        return;
      }
      if (observedNetworkUrls.length < 512) observedNetworkUrls.push(url);
    };
    cdp.on("Network.requestWillBeSent", ({ request } = {}) => observeNetworkURL(request?.url));
    cdp.on("Network.webSocketCreated", ({ url } = {}) => observeNetworkURL(url));
    // Enable both domains before releasing the preload-owned startup gate. A
    // status GET can never substitute for the CDP POST evidence; the gate
    // ensures the first request cannot race this observer's attachment.
    await cdp.request("Page.enable");
    await cdp.request("Network.enable");
    const refreshBinding = await bindMacSmokeRefreshObserver(
      cdp,
      refreshObserver,
      targetDashboardOrigin,
    );
    await releaseMacSmokeRefreshGate(cdp);
    stage = "dashboard";
    let ready;
    try {
      ready = await waitFor(async () => {
        const snapshot = await cdp.evaluate(`(() => ({
          ready: document.documentElement?.dataset?.localDashboardReady === "true",
          title: document.title,
          heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
          location: location.href,
        }))()`);
        return snapshot.ready && snapshot.title === "TiboTattle" && snapshot.heading
          ? snapshot
          : null;
      }, MAX_STARTUP_MS, "dashboard renderer readiness");
    } catch {
      fail("ELECTRON_MACOS_SMOKE_DASHBOARD_RENDERER_UNAVAILABLE", "dashboard");
    }
    const readyLoaderId = await mainFrameLoaderId(cdp);
    if (readyLoaderId !== refreshBinding.loaderId) {
      fail(
        ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES.boundaryInvalid,
        "startup_refresh",
      );
    }
    selectRequiredRefreshLoader(refreshObserver, refreshBinding.loaderId);
    const dashboardUrl = new URL(ready.location);
    if (!isExactMacLoopbackOrigin(dashboardUrl.origin)
        || dashboardUrl.origin !== refreshBinding.origin) {
      fail("ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID", "dashboard");
    }
    if (refreshObserver.selectOrigin(dashboardUrl.origin) !== dashboardUrl.origin) {
      fail("ELECTRON_MACOS_SMOKE_DASHBOARD_ORIGIN_INVALID", "dashboard");
    }
    const health = await jsonFetch(new URL("/api/local/health", dashboardUrl));
    if (health.status !== "ready") fail("ELECTRON_MACOS_SMOKE_COMPANION_NOT_READY", "dashboard");
    dashboardReceipt = await assertDashboardShell(cdp);
    recordSmokeProgress(progressRecord, "dashboard", dashboardReceipt);
    stage = "startup_refresh";
    startupReceipt = await assertAutomaticStartupRefresh({
      child,
      dashboardUrl,
      refreshObserver,
    });
    recordSmokeProgress(progressRecord, "startupRefresh", startupReceipt);
    // The first dashboard document can still display its honest loading
    // placeholders while the main-owned startup pass is running.  Wait for
    // the terminal refresh receipt before asserting that rendered local data
    // has replaced those placeholders.
    stage = "dashboard";
    dashboardReceipt = Object.freeze({
      ...dashboardReceipt,
      ...(await assertDashboardData(cdp)),
    });
    recordSmokeProgress(progressRecord, "dashboard", dashboardReceipt);
    const postRefreshHealth = await jsonFetch(new URL("/api/local/health", dashboardUrl));
    stage = "parity";
    parityReceipt = await assertDashboardParitySurfaces(
      cdp,
      postRefreshHealth,
      startupReceipt,
    );
    recordSmokeProgress(progressRecord, "parity", parityReceipt);
    stage = "share";
    shareReceipt = await assertShareFlow(cdp);
    recordSmokeProgress(progressRecord, "share", shareReceipt);
    stage = "settings";
    settingsReceipt = await assertSettingsFlow(cdp, port, dashboardUrl.origin);
    recordSmokeProgress(progressRecord, "settings", settingsReceipt);
    if (networkEvidenceInvalid
        || observedNetworkUrls.some((url) => {
          try {
            const parsed = new URL(url);
            return (parsed.protocol === "http:" || parsed.protocol === "https:")
              && parsed.origin !== dashboardUrl.origin;
          } catch {
            return false;
          }
        })) {
      fail("ELECTRON_MACOS_SMOKE_NON_LOOPBACK_REQUEST", "dashboard");
    }
    if (descendantsOf(child.pid).length < 1) {
      fail("ELECTRON_MACOS_SMOKE_COMPANION_NOT_RUNNING", "dashboard");
    }
    cdp.close();
    cdp = null;
    stage = "quit";
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("ELECTRON_MACOS_SMOKE_EXITED_BEFORE_QUIT", "quit");
    }
    if (!child.kill("SIGUSR2")) fail("ELECTRON_MACOS_SMOKE_QUIT_SIGNAL_FAILED", "quit");
    await withTimeout(once(child, "exit"), MAX_SHUTDOWN_MS, "Electron clean quit");
    await waitFor(
      () => descendantsOf(child.pid).length === 0,
      MAX_SHUTDOWN_MS,
      "Electron companion cleanup",
    );
    if (child.signalCode !== null || child.exitCode !== 0) {
      fail("ELECTRON_MACOS_SMOKE_CLEAN_QUIT_INVALID", "quit");
    }
    cleanQuit = true;
    void version;
    return buildClosedReceipt({
      status: "passed",
      cleanQuit,
      startupRefresh: startupReceipt,
      dashboard: dashboardReceipt,
      parity: parityReceipt,
      settings: settingsReceipt,
      share: shareReceipt,
    });
  } catch (error) {
    if (!FAILURE_STAGES.has(stage)) stage = "launch";
    if (error && typeof error === "object") {
      error.smokeStage = stage;
      error.smokeReason = failureReasonForError(error, stage);
    }
    throw error;
  } finally {
    refreshObserver?.dispose?.();
    cdp?.close?.();
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // A launch-service failure can leave a ChildProcess object without a
        // live PID.  Cleanup must still reach the disposable-profile removal.
      }
      await Promise.race([
        once(child, "exit").catch(() => null),
        wait(2_000),
      ]);
    }
    await rm(fixture.root, { recursive: true, force: true }).catch(() => {});
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const appPath = appPathFromArguments();
  const receiptPath = receiptPathFromArguments();
  const progress = {};
  let receipt;
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      fail("ELECTRON_MACOS_SMOKE_NATIVE_ARM64_REQUIRED", "contract");
    }
    if (appPath === null) fail("ELECTRON_MACOS_SMOKE_APP_REQUIRED", "contract");
    receipt = await runSmoke(appPath, progress);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    receipt = buildClosedReceipt({
      status: "failed",
      failureStage: FAILURE_STAGES.has(error?.smokeStage)
        ? error.smokeStage
        : "launch",
      failureReason: failureReasonForError(
        error,
        FAILURE_STAGES.has(error?.smokeStage) ? error.smokeStage : "launch",
      ),
      dashboard: progress.dashboard,
      parity: progress.parity,
      startupRefresh: progress.startupRefresh,
      share: progress.share,
      settings: progress.settings,
    });
    process.stderr.write(`${CLI_FAILURE_STATUS}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await persistReceipt(receipt, receiptPath);
    } catch {
      // Receipt persistence is useful evidence, but must not expose a local
      // path or replace the fixed failure status with filesystem diagnostics.
      process.stderr.write("ELECTRON_MACOS_SMOKE_RECEIPT_WRITE_FAILED\n");
      process.exitCode = 1;
    }
    if (receipt && process.exitCode === 1 && receipt.status === "failed") {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
  }
}
