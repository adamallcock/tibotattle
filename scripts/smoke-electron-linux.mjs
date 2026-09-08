#!/usr/bin/env node

/**
 * Run the shared Electron shell against a disposable synthetic home.
 *
 * This is intentionally a source-checkout smoke, not a Linux release claim:
 * the container supplies Electron's Linux runtime and Xvfb, while Windows
 * native bindings, credentials, signing, and installers remain out of scope.
 * The caller must provide the network boundary (`docker run --network none`).
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer, isIP } from "node:net";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  validateDesktopFirstRunReceipt,
} from "../apps/electron/desktop-first-run.js";

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ELECTRON_MAIN = resolve(REPOSITORY_ROOT, "apps/electron/main.js");
const MAX_STARTUP_MS = 30_000;
const MAX_OPERATION_MS = 10_000;
const MAX_REFRESH_MS = 45_000;
const MAX_SHUTDOWN_MS = 10_000;
const MAX_NETWORK_EVIDENCE_URLS = 512;
const MAX_NETWORK_EVIDENCE_URL_LENGTH = 2_048;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const MAX_CDP_PAGE_TARGETS = 16;
const RENDERER_READINESS_DIAGNOSTIC_PROBE_MS = 2_000;
const RENDERER_READINESS_COMPANION_HEALTH_POLL_MS = 500;
const RENDERER_READINESS_COMPANION_HEALTH_REQUEST_MS = 2_000;
const RENDERER_READINESS_COMPANION_HEALTH_MAX_BODY_BYTES = 64 * 1024;
const CLI_FAILURE_STATUS = "ELECTRON_LINUX_SMOKE_FAILED";
const NETWORK_BOUNDARY = "network-none";
export const LINUX_COMPANION_PROCESS_DIAGNOSTIC_SCHEMA =
  "tibotattle-electron-linux-companion-process-diagnostic-v1";
export const LINUX_DASHBOARD_FAILURE_DIAGNOSTIC_SCHEMA =
  "tibotattle-electron-linux-dashboard-failure-diagnostic-v1";
const COMPANION_PROCESS_PREFIX = "TIBOTATTLE_ELECTRON_COMPANION_PROCESS ";
const DASHBOARD_FAILURE_PREFIX = "TIBOTATTLE_ELECTRON_DASHBOARD_FAILURE ";
const RENDER_PROCESS_FAILURE_REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "unknown",
]);
const COMPANION_PROCESS_OUTCOMES = new Set([
  "exit_zero", "exit_nonzero", "signal_abrt", "signal_segv", "signal_kill", "signal_term", "signal_other",
]);

function validateCompanionProcessEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 3
      || !["starting", "ready", "stopping"].includes(value.phase)) return null;
  if (value.event === "started" && value.phase === "starting" && value.outcome === null
      || value.event === "exited" && COMPANION_PROCESS_OUTCOMES.has(value.outcome)) {
    return Object.freeze({ event: value.event, phase: value.phase, outcome: value.outcome });
  }
  return null;
}

export function validateLinuxCompanionProcessDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 2) return null;
  const lastEvent = value.lastEvent === null ? null : validateCompanionProcessEvent(value.lastEvent);
  const firstUnexpectedExit = value.firstUnexpectedExit === null ? null
    : validateCompanionProcessEvent(value.firstUnexpectedExit);
  if (value.lastEvent !== null && lastEvent === null
      || value.firstUnexpectedExit !== null && firstUnexpectedExit === null
      || firstUnexpectedExit !== null && (lastEvent === null
        || firstUnexpectedExit.event !== "exited" || firstUnexpectedExit.phase === "stopping")) return null;
  return Object.freeze({ lastEvent, firstUnexpectedExit });
}

function createDiagnosticLineReader(onLine) {
  let pending = "";
  let discarding = false;
  return (chunk) => {
    const pieces = Buffer.from(chunk).toString("utf8").split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      if (!discarding) {
        if (pending.length + pieces[index].length > 512) { pending = ""; discarding = true; }
        else pending += pieces[index];
      }
      if (index < pieces.length - 1) {
        if (!discarding) onLine(pending);
        pending = ""; discarding = false;
      }
    }
  };
}

export function validateLinuxDashboardFailureDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 2) return null;
  const boundedNetworkCode = Number.isInteger(value.reason) && value.reason >= -999 && value.reason <= -1;
  if ((value.stage === "load_url" || value.stage === "did_fail_load") && (value.reason === null || boundedNetworkCode)
      || value.stage === "render_process_gone" && RENDER_PROCESS_FAILURE_REASONS.has(value.reason)) {
    return Object.freeze({ stage: value.stage, reason: value.reason });
  }
  return null;
}

export function createLinuxDashboardFailureDiagnostics() {
  let failure = null;
  return Object.freeze({
    feed: createDiagnosticLineReader((line) => {
      if (failure !== null || !line.startsWith(DASHBOARD_FAILURE_PREFIX)) return;
      try { failure = validateLinuxDashboardFailureDiagnostic(JSON.parse(line.slice(DASHBOARD_FAILURE_PREFIX.length))); }
      catch { /* Other stderr is discarded. */ }
    }),
    snapshot: () => failure,
  });
}

/** Consume only a closed main-process marker; discard every other stderr byte. */
export function createLinuxCompanionProcessDiagnostics() {
  let lastEvent = null;
  let firstUnexpectedExit = null;
  function line(value) {
    if (!value.startsWith(COMPANION_PROCESS_PREFIX)) return;
    let event;
    try { event = validateCompanionProcessEvent(JSON.parse(value.slice(COMPANION_PROCESS_PREFIX.length))); }
    catch { return; }
    if (event === null) return;
    lastEvent = event;
    if (firstUnexpectedExit === null && event.event === "exited" && event.phase !== "stopping") {
      firstUnexpectedExit = event;
    }
  }
  return Object.freeze({
    feed: createDiagnosticLineReader(line),
    snapshot: () => validateLinuxCompanionProcessDiagnostics({ lastEvent, firstUnexpectedExit }),
  });
}
const PLATFORM_ARCHITECTURES = Object.freeze({
  "linux/arm64": "arm64",
  "linux/amd64": "x64",
});
export const ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES = Object.freeze({
  duplicate: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_DUPLICATED",
  invalidReceipt: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID",
  changedReceipt: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED",
  acceptanceTimeout: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ACCEPTANCE_TIMEOUT",
  completionTimeout: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_COMPLETION_TIMEOUT",
  failed: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_FAILED",
  cancelled: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_CANCELLED",
  degradedInvalid: "ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_DEGRADED_INVALID",
  boundaryInvalid: "ELECTRON_LINUX_SMOKE_REFRESH_BOUNDARY_INVALID",
});
const STARTUP_REFRESH_TIMEOUT_PHASES = new Set(["acceptance", "completion"]);
const STARTUP_REFRESH_TIMEOUT_REQUEST_COUNTS = new Set(["zero", "one", "multiple", "invalid"]);
const STARTUP_REFRESH_TIMEOUT_STATUSES = new Set([
  "not_observed", "missing", "idle", "running", "succeeded", "degraded", "failed", "cancelled",
  "other", "unavailable",
]);
export const ELECTRON_LINUX_SMOKE_DEGRADED_FAILURE_CODES = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
]);
/**
 * A caller can retain only one of these coarse journey boundaries when a
 * shared source smoke fails. The value identifies the assertion region, never
 * an Electron, renderer, or fixture error.
 */
export const ELECTRON_LINUX_SMOKE_FAILURE_STAGES = Object.freeze([
  "startup",
  "target",
  "renderer_readiness_unobserved",
  "renderer_readiness_marker_false_title_false_heading_false",
  "renderer_readiness_marker_false_title_false_heading_true",
  "renderer_readiness_marker_false_title_true_heading_false",
  "renderer_readiness_marker_false_title_true_heading_true",
  "renderer_readiness_marker_true_title_false_heading_false",
  "renderer_readiness_marker_true_title_false_heading_true",
  "renderer_readiness_marker_true_title_true_heading_false",
  "renderer_origin",
  "renderer_health",
  "renderer_resource",
  "renderer_navigation",
  "initial_refresh",
  "reload_refresh",
  "observation",
  "renderer_late_network",
  "quit_cleanup",
]);
const ELECTRON_LINUX_SMOKE_FAILURE_STAGE_SET = new Set(ELECTRON_LINUX_SMOKE_FAILURE_STAGES);
const DEGRADED_FAILURE_CODE_SET = new Set(
  ELECTRON_LINUX_SMOKE_DEGRADED_FAILURE_CODES,
);
const RENDERER_READINESS_ASSETS = Object.freeze([
  "app.js",
  "community-data.js",
  "data-client.js",
  "desktop-shell.js",
  "i18n.generated.js",
  "install-cta.js",
  "lib.js",
  "localization.js",
  "navigation.js",
  "telemetry-envelope.js",
  "telemetry-shared.generated.js",
  "ui-format.js",
]);
const RENDERER_READINESS_ASSET_SET = new Set(RENDERER_READINESS_ASSETS);
const RENDERER_READINESS_PRIMARY_ENDPOINTS = Object.freeze([
  Object.freeze({ name: "overview", path: "/api/local/overview" }),
  Object.freeze({ name: "gradient", path: "/api/local/gradient" }),
  Object.freeze({ name: "weekly", path: "/api/local/weekly" }),
  Object.freeze({ name: "quality", path: "/api/local/quality" }),
]);
const RENDERER_READINESS_ENDPOINT_BY_PATH = new Map(
  RENDERER_READINESS_PRIMARY_ENDPOINTS.map((endpoint) => [endpoint.path, endpoint.name]),
);
const RENDERER_READINESS_RESPONSE_CLASSES = new Set([
  "unobserved", "1xx", "2xx", "3xx", "4xx", "5xx", "other",
]);
const RENDERER_READINESS_COMPLETIONS = new Set([
  "unobserved", "finished", "failed", "timing_recorded",
]);
const RENDERER_READINESS_EXCEPTION_CLASSES = new Set([
  "unobserved", "syntax", "reference", "type", "other",
]);
const RENDERER_READINESS_PROBE_OUTCOMES = new Set([
  "unobserved", "response", "timeout", "request_failed",
]);
const RENDERER_READINESS_COMPANION_SNAPSHOT_STATUSES = new Set([
  "unobserved", "building", "ready", "failed",
]);
const RENDERER_READINESS_COMPANION_SNAPSHOT_ERROR_CODE = /^[a-z0-9_]{1,64}$/u;
const MAX_RENDERER_DIAGNOSTIC_LINE = 250_000;

function rendererResponseClass(status) {
  if (!Number.isFinite(status)) return "unobserved";
  const normalized = Math.trunc(status);
  if (normalized >= 100 && normalized < 600) return `${Math.floor(normalized / 100)}xx`;
  return "other";
}

function rendererExceptionClass(value) {
  if (value === "SyntaxError") return "syntax";
  if (value === "ReferenceError") return "reference";
  if (value === "TypeError") return "type";
  return "other";
}

function rendererDiagnosticTarget(value, origin) {
  if (typeof value !== "string" || typeof origin !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") return null;
  const endpoint = RENDERER_READINESS_ENDPOINT_BY_PATH.get(parsed.pathname);
  if (endpoint !== undefined) return { kind: "endpoint", name: endpoint };
  const asset = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "";
  return RENDERER_READINESS_ASSET_SET.has(asset) ? { kind: "asset", name: asset } : null;
}

function selectedRendererDashboardOrigin(value) {
  if (typeof value !== "string") return null;
  let dashboard;
  try {
    dashboard = new URL(value);
  } catch {
    return null;
  }
  const port = Number(dashboard.port);
  return dashboard.protocol === "http:"
    && dashboard.hostname === "127.0.0.1"
    && Number.isInteger(port)
    && port >= 1
    && port <= 65_535
    && dashboard.pathname === "/"
    && dashboard.search === ""
    && dashboard.hash === ""
    && dashboard.username === ""
    && dashboard.password === ""
    ? dashboard.origin
    : null;
}

function rendererDiagnosticLine(value) {
  return Number.isInteger(value) && value >= 0 && value < MAX_RENDERER_DIAGNOSTIC_LINE
    ? value + 1
    : null;
}

function isRendererReadinessFailureStage(stage) {
  return stage === "renderer_readiness_unobserved"
    || typeof stage === "string" && stage.startsWith("renderer_readiness_marker_");
}

/**
 * Return only fixed renderer startup evidence.  It deliberately contains no
 * URL, exception text, stack, response body, or fixture value.  "unobserved"
 * means CDP attached too late to prove the event was absent.
 */
export function validateRendererReadinessDiagnostics(value) {
  const expectedKeys = [
    "exception", "assets", "primaryApis", "primaryProbe", "companionSnapshot",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== expectedKeys.length
      || !expectedKeys.every((key) => Object.hasOwn(value, key))) return null;
  const exception = value.exception;
  const companionSnapshot = validateRendererCompanionSnapshot(value.companionSnapshot);
  if (!exception || typeof exception !== "object" || Array.isArray(exception)
      || typeof exception.observed !== "boolean"
      || !RENDERER_READINESS_EXCEPTION_CLASSES.has(exception.classification)
      || (exception.asset !== null && !RENDERER_READINESS_ASSET_SET.has(exception.asset))
      || (exception.line !== null && (!Number.isInteger(exception.line)
        || exception.line < 1 || exception.line > MAX_RENDERER_DIAGNOSTIC_LINE))) {
    return null;
  }
  if (!exception.observed && (exception.classification !== "unobserved"
      || exception.asset !== null || exception.line !== null)
      || exception.observed && exception.classification === "unobserved") {
    return null;
  }
  if (companionSnapshot === null) return null;
  if (!Array.isArray(value.assets) || value.assets.length !== RENDERER_READINESS_ASSETS.length
      || !Array.isArray(value.primaryApis)
      || value.primaryApis.length !== RENDERER_READINESS_PRIMARY_ENDPOINTS.length
      || !Array.isArray(value.primaryProbe)
      || value.primaryProbe.length !== RENDERER_READINESS_PRIMARY_ENDPOINTS.length) {
    return null;
  }
  const validateRows = (rows, expected, key) => rows.every((row, index) => (
    row && typeof row === "object" && !Array.isArray(row)
      && row[key] === expected[index]
      && RENDERER_READINESS_RESPONSE_CLASSES.has(row.responseClass)
      && RENDERER_READINESS_COMPLETIONS.has(row.completion)
  ));
  if (!validateRows(value.assets, RENDERER_READINESS_ASSETS, "asset")
      || !validateRows(value.primaryApis,
        RENDERER_READINESS_PRIMARY_ENDPOINTS.map((endpoint) => endpoint.name), "endpoint")) {
    return null;
  }
  if (!value.primaryProbe.every((row, index) => (
    row && typeof row === "object" && !Array.isArray(row)
      && row.endpoint === RENDERER_READINESS_PRIMARY_ENDPOINTS[index].name
      && RENDERER_READINESS_RESPONSE_CLASSES.has(row.responseClass)
      && RENDERER_READINESS_PROBE_OUTCOMES.has(row.outcome)
  ))) return null;
  return Object.freeze({
    exception: Object.freeze({
      observed: exception.observed,
      classification: exception.classification,
      asset: exception.asset,
      line: exception.line,
    }),
    assets: Object.freeze(value.assets.map((row) => Object.freeze({
      asset: row.asset,
      responseClass: row.responseClass,
      completion: row.completion,
    }))),
    primaryApis: Object.freeze(value.primaryApis.map((row) => Object.freeze({
      endpoint: row.endpoint,
      responseClass: row.responseClass,
      completion: row.completion,
    }))),
    primaryProbe: Object.freeze(value.primaryProbe.map((row) => Object.freeze({
      endpoint: row.endpoint,
      responseClass: row.responseClass,
      outcome: row.outcome,
    }))),
    companionSnapshot,
  });
}

/** Probe only the fixed split dashboard reads after their original readiness failure. */
export async function probeRendererReadinessPrimaryApis(origin, {
  fetchImpl = globalThis.fetch,
  timeoutMs = RENDERER_READINESS_DIAGNOSTIC_PROBE_MS,
} = {}) {
  if (typeof origin !== "string" || typeof fetchImpl !== "function"
      || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return Object.freeze(RENDERER_READINESS_PRIMARY_ENDPOINTS.map(({ name: endpoint }) => Object.freeze({
      endpoint, responseClass: "unobserved", outcome: "unobserved",
    })));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await Promise.all(RENDERER_READINESS_PRIMARY_ENDPOINTS.map(async ({ name: endpoint, path }) => {
      try {
        const response = await fetchImpl(new URL(path, origin), {
          redirect: "manual",
          signal: controller.signal,
        });
        try { await response?.body?.cancel?.(); } catch { /* Response data is never read. */ }
        return Object.freeze({
          endpoint,
          responseClass: rendererResponseClass(response?.status),
          outcome: "response",
        });
      } catch {
        return Object.freeze({
          endpoint,
          responseClass: "unobserved",
          outcome: controller.signal.aborted ? "timeout" : "request_failed",
        });
      }
    }));
    return Object.freeze(results);
  } finally {
    clearTimeout(timeout);
  }
}

function unobservedRendererCompanionSnapshot() {
  return Object.freeze({ status: "unobserved", errorCode: null });
}

function validateRendererCompanionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !RENDERER_READINESS_COMPANION_SNAPSHOT_STATUSES.has(value.status)
      || !Object.hasOwn(value, "errorCode")) {
    return null;
  }
  if (value.status === "unobserved" || value.status === "building" || value.status === "ready") {
    return value.errorCode === null
      ? Object.freeze({ status: value.status, errorCode: null })
      : null;
  }
  return typeof value.errorCode === "string"
      && RENDERER_READINESS_COMPANION_SNAPSHOT_ERROR_CODE.test(value.errorCode)
    ? Object.freeze({ status: "failed", errorCode: value.errorCode })
    : null;
}

async function readRendererCompanionSnapshot(origin, {
  fetchImpl,
  timeoutMs,
  maximumBytes,
  setActive,
} = {}) {
  const controller = new AbortController();
  let body = null;
  let reader = null;
  let cancelled = false;
  let timer = null;
  const abortAndDrain = async () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    const operations = [];
    if (typeof reader?.cancel === "function") {
      try { operations.push(Promise.resolve(reader.cancel())); } catch { /* Best-effort cancellation. */ }
    }
    if (typeof body?.cancel === "function") {
      try { operations.push(Promise.resolve(body.cancel())); } catch { /* Best-effort cancellation. */ }
    }
    await withTimeout(
      Promise.allSettled(operations),
      timeoutMs,
      "companion health body cleanup",
    ).catch(() => {});
  };
  timer = setTimeout(() => { void abortAndDrain(); }, timeoutMs);
  timer.unref?.();
  setActive(abortAndDrain);
  try {
    const response = await fetchImpl(new URL("/api/local/health", origin), {
      redirect: "error",
      signal: controller.signal,
    });
    body = response?.body ?? null;
    if (response?.status !== 200 || response?.redirected === true) {
      await abortAndDrain();
      return null;
    }
    const contentLength = response.headers?.get?.("content-length") ?? null;
    if (contentLength !== null) {
      const parsedLength = typeof contentLength === "string" && /^\d+$/u.test(contentLength)
        ? Number(contentLength)
        : NaN;
      if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
        await abortAndDrain();
        return null;
      }
    }
    reader = body?.getReader?.() ?? null;
    if (reader === null) {
      await abortAndDrain();
      return null;
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await abortAndDrain();
        return null;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await abortAndDrain();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); } catch { return null; }
    return validateRendererCompanionSnapshot(payload?.snapshot);
  } catch {
    await abortAndDrain();
    return null;
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock?.(); } catch { /* Best-effort reader cleanup. */ }
    setActive(null);
  }
}

/**
 * Observe only the companion's existing content-free snapshot state while the
 * renderer waits for its first dashboard result. A successful `building`
 * sample remains useful if the child later closes before another poll; failed
 * requests themselves never replace that last safe state.
 */
export function createRendererReadinessCompanionSnapshotObserver(origin, {
  fetchImpl = globalThis.fetch,
  pollIntervalMs = RENDERER_READINESS_COMPANION_HEALTH_POLL_MS,
  requestTimeoutMs = RENDERER_READINESS_COMPANION_HEALTH_REQUEST_MS,
  maximumBytes = RENDERER_READINESS_COMPANION_HEALTH_MAX_BODY_BYTES,
} = {}) {
  const selectedOrigin = selectedRendererDashboardOrigin(origin);
  if (selectedOrigin === null || typeof fetchImpl !== "function"
      || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > MAX_STARTUP_MS
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_STARTUP_MS
      || !Number.isInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAX_JSON_RESPONSE_BYTES) {
    return Object.freeze({
      snapshot: unobservedRendererCompanionSnapshot,
      stop: async () => {},
    });
  }
  let last = unobservedRendererCompanionSnapshot();
  let stopped = false;
  let timer = null;
  let active = null;
  let cancelActive = null;
  const clearScheduledPoll = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const stopScheduling = () => {
    stopped = true;
    clearScheduledPoll();
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      observe();
    }, pollIntervalMs);
    timer.unref?.();
  };
  const observe = () => {
    if (stopped || active !== null) return;
    const task = readRendererCompanionSnapshot(selectedOrigin, {
      fetchImpl,
      timeoutMs: requestTimeoutMs,
      maximumBytes,
      setActive(cancel) {
        cancelActive = cancel;
      },
    }).then((observed) => {
      if (observed !== null) {
        last = observed;
        if (observed.status === "ready" || observed.status === "failed") {
          stopScheduling();
        }
      }
    }).finally(() => {
      if (active === task) active = null;
      if (!stopped) schedule();
    });
    active = task;
    void task.catch(() => {});
  };
  observe();
  return Object.freeze({
    snapshot: () => last,
    stop: async () => {
      stopScheduling();
      await withTimeout(Promise.allSettled([
        Promise.resolve(cancelActive?.()),
        active?.catch(() => {}),
      ]), requestTimeoutMs, "companion health observer cleanup").catch(() => {});
    },
  });
}

export function createRendererReadinessDiagnostics({ cdp }) {
  // A CDP page target can be observed as about:blank before the same target
  // navigates to the companion. Bind only once its exact loopback dashboard
  // URL has been selected, otherwise an early opaque origin hides every later
  // local API observation and makes the bounded diagnostic probe unusable.
  let origin = null;
  const assets = new Map(RENDERER_READINESS_ASSETS.map((asset) => [asset, {
    responseClass: "unobserved", completion: "unobserved", requestId: null,
  }]));
  const primaryApis = new Map(RENDERER_READINESS_PRIMARY_ENDPOINTS.map(({ name }) => [name, {
    responseClass: "unobserved", completion: "unobserved", requestId: null,
  }]));
  let primaryProbe = RENDERER_READINESS_PRIMARY_ENDPOINTS.map(({ name: endpoint }) => ({
    endpoint, responseClass: "unobserved", outcome: "unobserved",
  }));
  const requests = new Map();
  let exception = {
    observed: false, classification: "unobserved", asset: null, line: null,
  };
  const observeRequest = ({ request, requestId } = {}) => {
    if (typeof requestId !== "string" || requestId.length === 0) return;
    const target = rendererDiagnosticTarget(request?.url, origin);
    if (target === null) return;
    const rows = target.kind === "asset" ? assets : primaryApis;
    const row = rows.get(target.name);
    if (row === undefined || row.requestId !== null) return;
    row.requestId = requestId;
    requests.set(requestId, row);
  };
  const observeResponse = ({ requestId, response } = {}) => {
    let row = requests.get(requestId);
    // CDP can attach after requestWillBeSent but before responseReceived. Bind
    // only this first allowlisted response; never retain its URL.
    if (row === undefined && typeof requestId === "string" && requestId.length > 0) {
      const target = rendererDiagnosticTarget(response?.url, origin);
      const rows = target?.kind === "asset" ? assets
        : target?.kind === "endpoint" ? primaryApis : null;
      const candidate = rows?.get(target.name);
      if (candidate?.requestId === null) {
        candidate.requestId = requestId;
        requests.set(requestId, candidate);
        row = candidate;
      }
    }
    if (row === undefined) return;
    row.responseClass = rendererResponseClass(response?.status);
  };
  const observeCompletion = ({ requestId } = {}, completion) => {
    const row = requests.get(requestId);
    if (row === undefined) return;
    row.completion = completion;
  };
  const observeException = ({ exceptionDetails } = {}) => {
    if (exception.observed) return;
    const directTarget = rendererDiagnosticTarget(exceptionDetails?.url, origin);
    const frame = directTarget?.kind === "asset" ? null
      : Array.isArray(exceptionDetails?.stackTrace?.callFrames)
        ? exceptionDetails.stackTrace.callFrames.find((candidate) =>
          rendererDiagnosticTarget(candidate?.url, origin)?.kind === "asset") ?? null
        : null;
    const target = directTarget?.kind === "asset"
      ? directTarget
      : rendererDiagnosticTarget(frame?.url, origin);
    if (target?.kind !== "asset") return;
    exception = {
      observed: true,
      classification: rendererExceptionClass(exceptionDetails?.exception?.className),
      asset: target.name,
      line: rendererDiagnosticLine(
        directTarget?.kind === "asset" ? exceptionDetails?.lineNumber : frame?.lineNumber,
      ),
    };
  };
  const listeners = [
    cdp.on("Network.requestWillBeSent", observeRequest),
    cdp.on("Network.responseReceived", observeResponse),
    cdp.on("Network.loadingFinished", (event) => observeCompletion(event, "finished")),
    cdp.on("Network.loadingFailed", (event) => observeCompletion(event, "failed")),
    cdp.on("Runtime.exceptionThrown", observeException),
  ];
  return Object.freeze({
    bindSelectedDashboardUrl(dashboardUrl) {
      if (origin !== null) return null;
      const selectedOrigin = selectedRendererDashboardOrigin(dashboardUrl);
      if (selectedOrigin === null) return null;
      origin = selectedOrigin;
      return origin;
    },
    snapshot({ companionSnapshot = unobservedRendererCompanionSnapshot() } = {}) {
      return validateRendererReadinessDiagnostics({
        exception,
        assets: RENDERER_READINESS_ASSETS.map((asset) => ({ asset, ...assets.get(asset) })),
        primaryApis: RENDERER_READINESS_PRIMARY_ENDPOINTS.map(({ name }) => ({
          endpoint: name,
          ...primaryApis.get(name),
        })),
        primaryProbe,
        companionSnapshot,
      });
    },
    async snapshotWithTimingAndProbe({
      probe = probeRendererReadinessPrimaryApis,
      companionSnapshot = unobservedRendererCompanionSnapshot(),
    } = {}) {
      if (origin === null) return this.snapshot({ companionSnapshot });
      let timing = null;
      try {
        timing = await cdp.evaluate(`(() => {
          const origin = ${JSON.stringify(origin)};
          const assets = ${JSON.stringify(RENDERER_READINESS_ASSETS)};
          const endpoints = ${JSON.stringify(RENDERER_READINESS_PRIMARY_ENDPOINTS)};
          const classify = (status) => Number.isFinite(status) && status >= 100 && status < 600
            ? String(Math.floor(status / 100)) + "xx"
            : "unobserved";
          const choose = (rows, key, name, status) => {
            if (rows.some((row) => row[key] === name)) return;
            rows.push({ [key]: name, responseClass: classify(status), completion: "timing_recorded" });
          };
          const result = { assets: [], primaryApis: [] };
          for (const entry of performance.getEntriesByType("resource")) {
            let url;
            try { url = new URL(entry.name); } catch { continue; }
            if (url.origin !== origin || url.search !== "" || url.hash !== "") continue;
            const asset = url.pathname.startsWith("/") ? url.pathname.slice(1) : "";
            if (assets.includes(asset)) {
              choose(result.assets, "asset", asset, entry.responseStatus);
              continue;
            }
            const endpoint = endpoints.find((candidate) => candidate.path === url.pathname)?.name;
            if (endpoint !== undefined) choose(result.primaryApis, "endpoint", endpoint, entry.responseStatus);
          }
          return result;
        })()`);
      } catch {
        // The existing bounded CDP evaluator remains the only timing bound.
      }
      for (const row of Array.isArray(timing?.assets) ? timing.assets : []) {
        const target = assets.get(row?.asset);
        if (target === undefined || target.completion !== "unobserved") continue;
        target.responseClass = RENDERER_READINESS_RESPONSE_CLASSES.has(row.responseClass)
          ? row.responseClass
          : "unobserved";
        target.completion = "timing_recorded";
      }
      for (const row of Array.isArray(timing?.primaryApis) ? timing.primaryApis : []) {
        const target = primaryApis.get(row?.endpoint);
        if (target === undefined || target.completion !== "unobserved") continue;
        target.responseClass = RENDERER_READINESS_RESPONSE_CLASSES.has(row.responseClass)
          ? row.responseClass
          : "unobserved";
        target.completion = "timing_recorded";
      }
      if (typeof probe === "function") {
        try { primaryProbe = await probe(origin); } catch { /* Keep the prior unobserved probe. */ }
      }
      return this.snapshot({ companionSnapshot });
    },
    dispose() {
      for (const dispose of listeners) dispose();
    },
  });
}

/**
 * Classify one renderer startup-refresh observation without consulting the
 * companion or exposing any response data.  Keeping this decision pure lets
 * the contract lane exercise stale receipts, duplicate renderer requests,
 * and terminal receipt transitions independently of a Linux runtime.
 */
export function classifyAutomaticStartupRefreshReceipt({
  phase,
  requestCount,
  refresh,
  previousRefreshId = null,
  expectedRefreshId = null,
} = {}) {
  if (!Number.isInteger(requestCount) || requestCount < 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount > 1) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount === 0 && phase === "acceptance") {
    return Object.freeze({ status: "pending" });
  }
  if (requestCount === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (refresh?.status === "idle") {
    return Object.freeze({ status: "pending" });
  }
  if (typeof refresh?.refreshId !== "string" || refresh.refreshId.length === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.invalidReceipt,
    });
  }
  if (phase === "acceptance") {
    if (refresh.refreshId === previousRefreshId) {
      return Object.freeze({ status: "pending" });
    }
    return Object.freeze({ status: "accepted", refreshId: refresh.refreshId });
  }
  if (phase !== "completion" || refresh.refreshId !== expectedRefreshId) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.changedReceipt,
    });
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
        errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.degradedInvalid,
      });
  }
  if (refresh.status === "failed") {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.failed,
    });
  }
  if (refresh.status === "cancelled") {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.cancelled,
    });
  }
  return Object.freeze({ status: "pending", refreshId: refresh.refreshId });
}

/**
 * Retain only bounded, content-free state when a startup-refresh phase reaches
 * its existing deadline. A missing observation remains a timeout failure; it
 * is never interpreted as a successful zero-request pass.
 */
export function startupRefreshTimeoutDiagnostic({ phase, requestCount, refresh } = {}) {
  if (!STARTUP_REFRESH_TIMEOUT_PHASES.has(phase)) return null;
  const requestCountCategory = !Number.isInteger(requestCount) || requestCount < 0
    ? "invalid"
    : requestCount === 0 ? "zero" : requestCount === 1 ? "one" : "multiple";
  const status = requestCountCategory === "zero"
    ? "not_observed"
    : refresh === null || refresh === undefined
      ? "missing"
      : typeof refresh.status !== "string"
        ? "other"
        : STARTUP_REFRESH_TIMEOUT_STATUSES.has(refresh.status) ? refresh.status : "other";
  return Object.freeze({
    phase,
    requestCount: requestCountCategory,
    refreshStatus: status,
  });
}

export function validateStartupRefreshTimeoutDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !STARTUP_REFRESH_TIMEOUT_PHASES.has(value.phase)
      || !STARTUP_REFRESH_TIMEOUT_REQUEST_COUNTS.has(value.requestCount)
      || !STARTUP_REFRESH_TIMEOUT_STATUSES.has(value.refreshStatus)) return null;
  return Object.freeze({
    phase: value.phase,
    requestCount: value.requestCount,
    refreshStatus: value.refreshStatus,
  });
}

function fail(message) {
  throw new Error(`Electron Linux smoke failed: ${message}`);
}

function failFixed(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function childHasExited(child) {
  return child !== null && typeof child === "object"
    && ((child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined));
}

async function waitForSmokeChildExit(child, deadlineMs) {
  if (childHasExited(child)) return true;
  return new Promise((resolveWait) => {
    let timer = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("error", onError);
      resolveWait(value);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    child.once?.("exit", onExit);
    child.once?.("error", onError);
    if (childHasExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), deadlineMs);
  });
}

/**
 * Stop only the owned Electron parent after a failed smoke journey. A forced
 * stop never contributes the normal clean-quit proof; the caller decides
 * whether a verified exit permits fixture cleanup.
 */
export async function terminateLinuxSmokeChild(child, {
  graceMs = 2_000,
  waitForExit = waitForSmokeChildExit,
} = {}) {
  if (!child || typeof child.kill !== "function" || typeof waitForExit !== "function"
      || !Number.isSafeInteger(graceMs) || graceMs < 1) return false;
  if (childHasExited(child)) return true;
  try {
    if (child.kill("SIGTERM") !== true) return false;
  } catch {
    return false;
  }
  if (await waitForExit(child, graceMs)) return true;
  try {
    if (child.kill("SIGKILL") !== true) return false;
  } catch {
    return false;
  }
  return waitForExit(child, graceMs);
}

function isLoopbackAddress(value) {
  const address = String(value ?? "").toLowerCase();
  const family = isIP(address);
  return (family === 4 && address.startsWith("127."))
    || (family === 6 && address === "::1");
}

/**
 * Validate the runtime boundary independently of Docker's command line.
 * `networkInterfacesImpl` is injectable so the contract can prove both the
 * loopback-only and external-interface cases without depending on the host.
 */
export function assertContainerContract({
  platform = process.platform,
  architecture = process.arch,
  imagePlatform = process.env.USAGE_MONITOR_LINUX_IMAGE_PLATFORM,
  sourceRevision = process.env.TIBOTATTLE_IMAGE_SOURCE_REVISION,
  networkBoundary = process.env.USAGE_MONITOR_LINUX_NETWORK_BOUNDARY,
  networkInterfacesImpl = networkInterfaces,
} = {}) {
  if (platform !== "linux") {
    fail("Linux smoke must run in a Linux container");
  }
  if (!Object.hasOwn(PLATFORM_ARCHITECTURES, imagePlatform)
      || PLATFORM_ARCHITECTURES[imagePlatform] !== architecture) {
    fail("Linux image platform is missing or does not match the running architecture");
  }
  if (networkBoundary !== NETWORK_BOUNDARY) {
    fail("Linux smoke requires the caller-enforced network-none runtime boundary");
  }
  if (typeof sourceRevision !== "string"
      || !/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    fail("Linux smoke requires an exact image source revision");
  }
  let interfaces;
  try {
    interfaces = networkInterfacesImpl();
  } catch {
    fail("Linux smoke could not inspect network interfaces");
  }
  if (interfaces === null || typeof interfaces !== "object" || Array.isArray(interfaces)) {
    fail("Linux smoke could not inspect network interfaces");
  }
  let loopbackAddressCount = 0;
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) fail("Linux smoke network interface data is invalid");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !isLoopbackAddress(entry.address)) {
        fail("Linux smoke requires loopback-only network interfaces");
      }
      loopbackAddressCount += 1;
    }
  }
  if (loopbackAddressCount === 0) {
    fail("Linux smoke could not prove a loopback-only network boundary");
  }
  return Object.freeze({
    imagePlatform,
    architecture,
    sourceRevision,
    networkBoundary,
    networkBoundaryEvidence: "loopback-only",
  });
}

export function fixedRuntimeFailureDiagnostics({
  stdoutProduced = false,
  stderrProduced = false,
} = {}) {
  const diagnostics = [];
  if (stdoutProduced === true) diagnostics.push("Electron runtime stdout was produced.\n");
  if (stderrProduced === true) diagnostics.push("Electron runtime stderr was produced.\n");
  return Object.freeze(diagnostics);
}

export function isAllowedRendererNetworkURL(value, allowedOrigin) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
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
  if (!Number.isInteger(port) || port < 1) fail("could not reserve a debugging port");
  return port;
}

export async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      const value = await withTimeout(
        Promise.resolve().then(predicate),
        remaining,
        label,
      );
      if (value) return value;
    } catch (error) {
      if (typeof error?.code === "string"
          && error.code.startsWith("ELECTRON_LINUX_SMOKE_")) {
        throw error;
      }
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`${label} timed out${lastError ? ` (${lastError.message})` : ""}`);
}

export async function createSyntheticHome() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-linux-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeHome = join(home, ".claude");
  const stateRoot = join(root, "state");
  const userData = join(root, "user-data");
  const settingsRoot = join(userData, "desktop-settings");
  const runtimeDirectory = join(root, "runtime");
  const configHome = join(home, ".config");
  const cacheHome = join(home, ".cache");
  const dataHome = join(home, ".local", "share");
  const sessions = join(codexHome, "sessions");
  const archivedSessions = join(codexHome, "archived_sessions");
  const directories = [
    home,
    codexHome,
    sessions,
    archivedSessions,
    claudeHome,
    stateRoot,
    userData,
    settingsRoot,
    runtimeDirectory,
    configHome,
    cacheHome,
    dataHome,
  ];
  try {
    await Promise.all(directories.map((directory) => mkdir(directory, {
      recursive: true,
      mode: 0o700,
    })));
    await Promise.all(directories.map((directory) => chmod(directory, 0o700)));

    // The companion only needs a readable synthetic source to render its local
    // evidence view. Keep the fixture content intentionally non-user-like.
    await writeFile(
      join(sessions, "rollout-linux-smoke.jsonl"),
      `${JSON.stringify({ type: "session_meta", id: "linux-smoke" })}\n`,
      { mode: 0o600 },
    );

    // Exercise the normal returning-user path through the production POSIX
    // first-run backend. The fixture is validated before it is serialized and
    // the backend validates it again at launch; no runtime bypass is installed.
    const firstRunReceipt = validateDesktopFirstRunReceipt({
      schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
      acknowledged: true,
    });
    const firstRunReceiptFile = join(
      settingsRoot,
      DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
    );
    await writeFile(
      firstRunReceiptFile,
      `${JSON.stringify(firstRunReceipt)}\n`,
      { mode: 0o600 },
    );
    await chmod(firstRunReceiptFile, 0o600);

    return Object.freeze({
      root,
      home,
      codexHome,
      claudeHome,
      stateRoot,
      userData,
      settingsRoot,
      firstRunReceiptFile,
      runtimeDirectory,
      configHome,
      cacheHome,
      dataHome,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function electronBinary() {
  const selected = process.env.ELECTRON_BINARY ?? require("electron");
  if (typeof selected !== "string" || selected.length === 0) {
    fail("Electron binary path is unavailable");
  }
  return selected;
}

function descendantsOf(parentPid) {
  const result = [];
  const rows = String(require("node:child_process").execFileSync(
    "ps",
    ["-eo", "pid=,ppid="],
    { encoding: "utf8" },
  ));
  const children = new Map();
  for (const line of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const pending = [...(children.get(parentPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    result.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

function linuxProcessStartTime(pid) {
  try {
    const value = String(require("node:fs").readFileSync(
      `/proc/${pid}/stat`,
      "utf8",
    ));
    const commandEnd = value.lastIndexOf(")");
    if (commandEnd < 0) fail("Linux process identity was unavailable");
    // The fields after the command begin at proc(5) field 3; starttime is
    // field 22 and therefore index 19 in this suffix.
    const suffix = value.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = suffix[19];
    if (!/^\d+$/u.test(startTime ?? "")) {
      fail("Linux process identity was unavailable");
    }
    return startTime;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    if (String(error?.message ?? "").startsWith("Electron Linux smoke failed:")) {
      throw error;
    }
    fail("Linux process identity was unavailable");
  }
}

function captureLinuxProcessIdentity(pid) {
  const startTime = linuxProcessStartTime(pid);
  return startTime === null ? null : Object.freeze({ pid, startTime });
}

function linuxProcessIdentityIsAlive(identity) {
  const observed = linuxProcessStartTime(identity.pid);
  return observed !== null && observed === identity.startTime;
}

async function jsonFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_OPERATION_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
      throw new Error("JSON response exceeded the smoke boundary");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("JSON response body was unavailable");
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new Error("JSON response body was invalid");
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new Error("JSON response exceeded the smoke boundary");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks, totalBytes).toString("utf8");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket error")), { once: true });
    }), MAX_OPERATION_MS, "CDP connection");
  } catch (error) {
    try {
      socket.close();
    } catch {
      // The fixed connection failure remains authoritative.
    }
    throw error;
  }

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
      const handlers = eventHandlers.get(message.method);
      if (!handlers) return;
      for (const handler of handlers) {
        handler(message.params ?? {}, message.sessionId ?? null);
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
  const request = (method, params = {}, sessionId = null) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    socket.send(JSON.stringify(sessionId === null
      ? { id, method, params }
      : { id, method, params, sessionId }));
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
      socket.close();
      for (const { reject } of pending.values()) reject(new Error("CDP connection closed"));
      pending.clear();
      eventHandlers.clear();
    },
  });
}

/**
 * Select only the main dashboard page for this smoke's ephemeral companion.
 * Electron may expose first-run, recovery, or other page targets through the
 * same debugging endpoint. Binding both URLs prevents one of those pages (or
 * a target from another debugger) from satisfying dashboard evidence.
 */
export function isLinuxInspectablePageTarget(target, debugPort) {
  if (target === null
      || typeof target !== "object"
      || Array.isArray(target)
      || target.type !== "page"
      || typeof target.id !== "string"
      || target.id.length === 0
      || typeof target.webSocketDebuggerUrl !== "string"
      || target.webSocketDebuggerUrl.length === 0
      || !Number.isInteger(debugPort)
      || debugPort < 1
      || debugPort > 65_535) {
    return false;
  }
  let websocket;
  try {
    websocket = new URL(target.webSocketDebuggerUrl);
  } catch {
    return false;
  }
  return websocket.protocol === "ws:"
    && websocket.hostname === "127.0.0.1"
    && websocket.port === String(debugPort)
    && /^\/devtools\/page\//u.test(websocket.pathname)
    && websocket.search === ""
    && websocket.hash === ""
    && websocket.username === ""
    && websocket.password === "";
}

export function isLinuxDashboardTarget(target, debugPort) {
  if (!isLinuxInspectablePageTarget(target, debugPort)
      || typeof target.url !== "string") {
    return false;
  }
  let dashboard;
  try {
    dashboard = new URL(target.url);
  } catch {
    return false;
  }
  const dashboardPort = Number(dashboard.port);
  return dashboard.protocol === "http:"
    && dashboard.hostname === "127.0.0.1"
    && Number.isInteger(dashboardPort)
    && dashboardPort >= 1
    && dashboardPort <= 65_535
    && dashboard.pathname === "/"
    && dashboard.search === ""
    && dashboard.hash === ""
    && dashboard.username === ""
    && dashboard.password === "";
}

export function selectLinuxDashboardTarget(targets, debugPort, targetId = undefined) {
  if (!Array.isArray(targets)) return undefined;
  if (targetId !== undefined
      && (typeof targetId !== "string" || targetId.length === 0)) {
    return undefined;
  }
  return targets.find((target) => (targetId === undefined || target?.id === targetId)
    && isLinuxDashboardTarget(target, debugPort));
}

export function reserveLinuxInspectablePageTargets(
  targets,
  debugPort,
  attemptedTargetIds,
  maximumTargets = MAX_CDP_PAGE_TARGETS,
) {
  if (!Array.isArray(targets)
      || !(attemptedTargetIds instanceof Set)
      || !Number.isInteger(maximumTargets)
      || maximumTargets < 1
      || attemptedTargetIds.size > maximumTargets) {
    fail("Electron inspectable page target boundary is invalid");
  }
  const candidates = new Map();
  for (const target of targets) {
    if (!isLinuxInspectablePageTarget(target, debugPort)
        || attemptedTargetIds.has(target.id)
        || candidates.has(target.id)) {
      continue;
    }
    candidates.set(target.id, target);
  }
  if (attemptedTargetIds.size + candidates.size > maximumTargets) {
    fail("Electron exposed too many inspectable page targets");
  }
  for (const targetId of candidates.keys()) attemptedTargetIds.add(targetId);
  return [...candidates.values()];
}

function assertRendererShellSnapshot(snapshot) {
  if (snapshot?.topbar !== true) fail("Electron Linux top bar is not visible");
  if (snapshot?.sidebar !== true) fail("Electron Linux sidebar is not visible");
  if (snapshot?.navCount !== 5) fail("Electron Linux navigation count is invalid");
  if (snapshot?.activeLinkCount !== 1) fail("Electron Linux active navigation is invalid");
  if (snapshot?.activePageCount !== 1) fail("Electron Linux active page is invalid");
  if (snapshot?.refresh !== true) fail("Electron Linux refresh control is missing");
  if (snapshot?.language !== true) fail("Electron Linux language control is missing");
}

function rendererReadinessFailureStage(snapshot) {
  const marker = snapshot?.readyMarker === true;
  const title = snapshot?.titleMatches === true;
  const heading = snapshot?.overviewHeadingPresent === true;
  if (marker && title && heading) return null;
  return `renderer_readiness_marker_${marker}_title_${title}_heading_${heading}`;
}

async function assertRendererShell(cdp) {
  const snapshot = await cdp.evaluate(`(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const navLinks = [...document.querySelectorAll("[data-nav]")];
    return {
      topbar: visible(document.querySelector(".topbar")),
      sidebar: visible(document.querySelector(".dashboard-sidebar")),
      navCount: navLinks.length,
      activeLinkCount: navLinks.filter((link) =>
        link.classList.contains("active")
        && link.getAttribute("aria-current") === "page",
      ).length,
      activePageCount: document.querySelectorAll(
        ".dashboard-section[data-dashboard-page]:not(.dashboard-page-inactive)",
      ).length,
      refresh: Boolean(document.querySelector("#refresh-button")),
      language: Boolean(document.querySelector("[data-language-picker]")),
    };
  })()`);
  assertRendererShellSnapshot(snapshot);

  const trends = await cdp.evaluate(`(() => {
    const trendsLink = document.querySelector('[data-nav="trends"]');
    const trendsPage = document.querySelector(
      '[data-dashboard-page="trends"].dashboard-section',
    );
    const overviewPage = document.querySelector(
      '[data-dashboard-page="overview"].dashboard-section',
    );
    trendsLink?.click();
    return {
      activeLink: trendsLink?.classList.contains("active") === true
        && trendsLink?.getAttribute("aria-current") === "page",
      activePage: trendsPage?.classList.contains("dashboard-page-inactive") === false
        && trendsPage?.inert === false
        && trendsPage?.hasAttribute("aria-hidden") === false,
      previousPageInactive: overviewPage?.classList.contains("dashboard-page-inactive") === true
        && overviewPage?.inert === true
        && overviewPage?.getAttribute("aria-hidden") === "true",
      activePageCount: document.querySelectorAll(
        ".dashboard-section[data-dashboard-page]:not(.dashboard-page-inactive)",
      ).length,
    };
  })()`);
  if (trends?.activeLink !== true) fail("Electron Linux Trends navigation is inactive");
  if (trends?.activePage !== true) fail("Electron Linux Trends page is inactive");
  if (trends?.previousPageInactive !== true) fail("Electron Linux previous page remains active");
  if (trends?.activePageCount !== 1) fail("Electron Linux Trends page count is invalid");
  await cdp.evaluate(`document.querySelector('[data-nav="overview"]')?.click()`);
}

async function mainFrameLoaderId(cdp) {
  const tree = await cdp.request("Page.getFrameTree");
  const loaderId = tree?.frameTree?.frame?.loaderId;
  return typeof loaderId === "string" && loaderId.length > 0 ? loaderId : null;
}

function selectRequiredRefreshLoader(refreshObserver, loaderId) {
  if (typeof loaderId !== "string" || loaderId.length === 0
      || refreshObserver.selectLoader(loaderId) !== loaderId) {
    failFixed(ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.boundaryInvalid);
  }
}

/**
 * Observe first-party refresh mutations at the renderer boundary. This gives
 * the Linux lane evidence of the Electron-only startup pass without adding a
 * qualification route or changing the companion's production API. Requests
 * are retained until the dashboard location is validated, then scoped to its
 * exact loopback origin and active main-frame loader so another local port or
 * prior page cannot satisfy a reload assertion.
 */
export function observeLocalRefreshRequests(cdp) {
  const requests = [];
  let activeLoaderId = null;
  let activeOrigin = null;
  let sealed = false;
  const unsubscribe = cdp.on(
    "Network.requestWillBeSent",
    ({ request, requestId, loaderId } = {}) => {
      if (sealed) return;
      if (request?.method !== "POST" || typeof request.url !== "string") return;
      let parsed;
      try {
        parsed = new URL(request.url);
      } catch {
        return;
      }
      // A startup pass is detailed before a verified projection exists, then
      // quick after that projection survives a fresh document. Both routes
      // mutate the same guarded local controller; keeping the route set
      // closed prevents another loopback POST from becoming smoke evidence.
      if (parsed.protocol !== "http:"
          || parsed.hostname !== "127.0.0.1"
          || !["/api/local/refresh", "/api/local/refresh/quick"].includes(parsed.pathname)) return;
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
      if (activeOrigin !== null) {
        const retained = requests.filter((entry) => entry.origin === activeOrigin);
        requests.length = 0;
        requests.push(...retained);
      } else {
        requests.length = 0;
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

/**
 * Require one completed automatic startup pass for the current dashboard
 * document. Linux has no separate synthetic-data lane today; this assertion
 * only proves the real renderer startup request and its terminal receipt.
 */
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
  let acceptanceTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
    phase: "acceptance", requestCount: -1, refresh: null,
  });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail("Electron exited before automatic startup refresh");
      }
      const requests = refreshObserver.snapshot();
      if (requests.length === 0) {
        acceptanceTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
          phase: "acceptance", requestCount: requests.length, refresh: null,
        });
        return null;
      }
      const noReceiptDecision = classifyAutomaticStartupRefreshReceipt({
        phase: "acceptance",
        requestCount: requests.length,
        refresh: { status: "idle" },
        previousRefreshId,
      });
      if (noReceiptDecision.status === "failed") failFixed(noReceiptDecision.errorCode);
      let status;
      try {
        status = await jsonFetch(refreshUrl);
      } catch (error) {
        acceptanceTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
          phase: "acceptance", requestCount: requests.length, refresh: { status: "unavailable" },
        });
        throw error;
      }
      const refresh = status?.refresh;
      acceptanceTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
        phase: "acceptance", requestCount: requests.length, refresh,
      });
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "acceptance",
        requestCount: requests.length,
        refresh,
        previousRefreshId,
      });
      if (decision.status === "pending") return null;
      if (decision.status === "failed") failFixed(decision.errorCode);
      refreshId = decision.refreshId;
      return true;
    }, MAX_REFRESH_MS, "automatic startup refresh acceptance");
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("ELECTRON_LINUX_SMOKE_")) throw error;
    const timeout = new Error(ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.acceptanceTimeout);
    timeout.code = ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.acceptanceTimeout;
    timeout.startupRefreshTimeoutDiagnostic = acceptanceTimeoutDiagnostic;
    throw timeout;
  }

  let completionTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
    phase: "completion", requestCount: -1, refresh: null,
  });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail("Electron exited before automatic startup refresh completed");
      }
      const requests = refreshObserver.snapshot();
      if (requests.length !== 1) {
        completionTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
          phase: "completion", requestCount: requests.length, refresh: null,
        });
        const requestDecision = classifyAutomaticStartupRefreshReceipt({
          phase: "completion",
          requestCount: requests.length,
          expectedRefreshId: refreshId,
        });
        if (requestDecision.status === "failed") failFixed(requestDecision.errorCode);
        return false;
      }
      let status;
      try {
        status = await jsonFetch(refreshUrl);
      } catch (error) {
        completionTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
          phase: "completion", requestCount: requests.length, refresh: { status: "unavailable" },
        });
        throw error;
      }
      const refresh = status?.refresh;
      completionTimeoutDiagnostic = startupRefreshTimeoutDiagnostic({
        phase: "completion", requestCount: requests.length, refresh,
      });
      const decision = classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: requests.length,
        refresh,
        expectedRefreshId: refreshId,
      });
      if (decision.status === "pending") return false;
      if (decision.status === "failed") failFixed(decision.errorCode);
      terminalStatus = decision.terminalStatus;
      degradedFailureCode = decision.degradedFailureCode ?? null;
      return true;
    }, MAX_REFRESH_MS, "automatic startup refresh completion");
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("ELECTRON_LINUX_SMOKE_")) throw error;
    const timeout = new Error(ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.completionTimeout);
    timeout.code = ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.completionTimeout;
    timeout.startupRefreshTimeoutDiagnostic = completionTimeoutDiagnostic;
    throw timeout;
  }
  // A completed pass may schedule an intentional bounded reindex continuation.
  // It is a separate operation, not a second startup trigger; stop counting
  // this document once the startup receipt has reached its terminal outcome.
  refreshObserver.seal();
  return Object.freeze({ terminalStatus, degradedFailureCode });
}

export function combineStartupRefreshEvidence(first, second) {
  const receipts = [first, second];
  const valid = receipts.every((receipt) => (
    receipt?.terminalStatus === "succeeded"
      && receipt.degradedFailureCode === null
  ) || (
    receipt?.terminalStatus === "degraded"
      && DEGRADED_FAILURE_CODE_SET.has(receipt.degradedFailureCode)
  ));
  if (!valid) {
    failFixed(ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.degradedInvalid);
  }
  if (receipts.every((receipt) => receipt.terminalStatus === "succeeded")) {
    return Object.freeze({ terminalStatus: "succeeded", degradedFailureCode: null });
  }
  const degraded = receipts.filter((receipt) => receipt?.terminalStatus === "degraded"
    && DEGRADED_FAILURE_CODE_SET.has(receipt.degradedFailureCode));
  const codes = new Set(degraded.map((receipt) => receipt.degradedFailureCode));
  if (codes.size !== 1) {
    failFixed(ELECTRON_LINUX_SMOKE_STARTUP_REFRESH_ERROR_CODES.degradedInvalid);
  }
  return Object.freeze({
    terminalStatus: "degraded",
    degradedFailureCode: [...codes][0],
  });
}

function defaultSmokeEnvironment({ fixture }) {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: fixture.home,
    TMPDIR: fixture.root,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_CACHE_HOME: fixture.cacheHome,
    XDG_DATA_HOME: fixture.dataHome,
    XDG_RUNTIME_DIR: fixture.runtimeDirectory,
    USAGE_MONITOR_RESOURCE_ROOT: REPOSITORY_ROOT,
    USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
    CODEX_HOME: fixture.codexHome,
    CLAUDE_CONFIG_DIR: fixture.claudeHome,
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    // This opt-in main-process control invokes desktop-lifecycle.requestQuit()
    // without adding a renderer or preload privilege.
    USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1",
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
  };
}

function defaultSmokeLaunchArguments({ fixture, port }) {
  return [
    `--user-data-dir=${fixture.userData}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    ELECTRON_MAIN,
  ];
}

async function defaultSmokeResultWriter(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run the established renderer/refresh/clean-quit proof with an injected
 * fixture and ordinary Electron launch shape. The default remains the source
 * checkout lane above; the narrow packaged candidate wrapper reuses this
 * runner rather than duplicating its CDP and lifecycle assertions.
 */
export async function runSmoke({
  afterRefresh = null,
  binary = null,
  binaryResolver = electronBinary,
  readContainerContract = assertContainerContract,
  environmentFactory = defaultSmokeEnvironment,
  fixtureFactory = createSyntheticHome,
  launchArguments = defaultSmokeLaunchArguments,
  onFailureStage = null,
  onRendererReadinessDiagnostics = null,
  onCompanionProcessDiagnostics = null,
  onDashboardFailureDiagnostic = null,
  qualification = "development-only",
  sourceRevision = null,
  writeResult = defaultSmokeResultWriter,
} = {}) {
  if (afterRefresh !== null && typeof afterRefresh !== "function"
      || binary !== null && (typeof binary !== "string" || binary.length === 0)
      || typeof binaryResolver !== "function" || typeof readContainerContract !== "function"
      || typeof environmentFactory !== "function" || typeof fixtureFactory !== "function"
      || typeof launchArguments !== "function"
      || onFailureStage !== null && typeof onFailureStage !== "function"
      || onRendererReadinessDiagnostics !== null && typeof onRendererReadinessDiagnostics !== "function"
      || onCompanionProcessDiagnostics !== null && typeof onCompanionProcessDiagnostics !== "function"
      || onDashboardFailureDiagnostic !== null && typeof onDashboardFailureDiagnostic !== "function"
      || typeof writeResult !== "function"
      || typeof qualification !== "string" || qualification.length === 0
      || (sourceRevision !== null && !/^[0-9a-f]{40}$/u.test(sourceRevision))) {
    fail("Electron Linux smoke runner options are invalid");
  }
  const containerContract = readContainerContract();
  if (sourceRevision !== null && sourceRevision !== containerContract.sourceRevision) {
    fail("Electron Linux source revision does not match the container");
  }
  const selectedBinary = binary ?? binaryResolver();
  if (typeof selectedBinary !== "string" || selectedBinary.length === 0) {
    fail("Electron binary path is unavailable");
  }
  const selectedSourceRevision = sourceRevision ?? containerContract.sourceRevision;
  const fixture = await fixtureFactory();
  const port = await freeTcpPort();
  let environment;
  let argumentsForLaunch;
  try {
    environment = environmentFactory({ fixture, port });
    argumentsForLaunch = launchArguments({ fixture, port });
  } catch {
    await rm(fixture.root, { recursive: true, force: true }).catch(() => {});
    fail("Electron Linux smoke launch configuration is invalid");
  }
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
      || !Array.isArray(argumentsForLaunch)
      || argumentsForLaunch.some((value) => typeof value !== "string" || value.length === 0)) {
    await rm(fixture.root, { recursive: true, force: true }).catch(() => {});
    fail("Electron Linux smoke launch configuration is invalid");
  }
  const child = spawn(selectedBinary, [
    ...argumentsForLaunch,
  ], {
    cwd: REPOSITORY_ROOT,
    env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Register before the first await so a failed spawn cannot become an
  // unhandled EventEmitter error while all emitted bytes are discarded.
  child.once?.("error", () => {});
  let stdoutProduced = false;
  let stderrProduced = false;
  const companionProcessDiagnostics = onCompanionProcessDiagnostics === null
    ? null : createLinuxCompanionProcessDiagnostics();
  const dashboardFailureDiagnostics = onDashboardFailureDiagnostic === null
    ? null : createLinuxDashboardFailureDiagnostics();
  child.stdout?.on("data", () => { stdoutProduced = true; });
  child.stderr?.on("data", (chunk) => {
    stderrProduced = true;
    companionProcessDiagnostics?.feed(chunk);
    dashboardFailureDiagnostics?.feed(chunk);
  });
  const attachedPages = new Map();
  const attemptedPageTargetIds = new Set();
  let cdp = null;
  let refreshObserver = null;
  let forcedShutdown = false;
  let cleanupConfirmed = false;
  let failureStage = null;
  let rendererReadinessDiagnostics = null;
  let companionSnapshotObserver = null;
  try {
    failureStage = "startup";
    if (!child.pid) fail("Electron did not provide a process id");
    const version = await waitFor(
      () => jsonFetch(`http://127.0.0.1:${port}/json/version`),
      MAX_STARTUP_MS,
      "Electron remote debugging endpoint",
    ).catch((error) => {
      // Electron's own stderr contains only bounded runtime diagnostics here;
      // the companion's output is intentionally discarded by its supervisor.
      // Never print Electron or companion output: a future renderer/runtime
      // failure must remain content-free even if it includes a local path or
      // a provider-derived value. The thrown error remains bounded and
      // carries only this fixed smoke-stage label.
      process.stderr.write("Electron Linux endpoint unavailable.\n");
      throw error;
    });
    // Poll from the moment the debugging endpoint appears and attach to each
    // debugger-owned page before deciding what it is. Electron can expose an
    // auxiliary or recovery page first; only an exact target-id match to the
    // loopback dashboard below may contribute evidence.
    failureStage = "target";
    const dashboardSelection = await waitFor(async () => {
      const targets = await jsonFetch(`http://127.0.0.1:${port}/json`);
      const inspectablePages = reserveLinuxInspectablePageTargets(
        targets,
        port,
        attemptedPageTargetIds,
      );
      await Promise.all(inspectablePages.map(async (target) => {
        let pageCdp;
        let pageRefreshObserver;
        let pageRendererReadinessDiagnostics;
        try {
          pageCdp = await connectCdp(target);
          pageRefreshObserver = observeLocalRefreshRequests(pageCdp);
          pageRendererReadinessDiagnostics = createRendererReadinessDiagnostics({ cdp: pageCdp });
          const observedNetworkUrls = [];
          let networkEvidenceInvalid = false;
          const observeNetworkURL = (url) => {
            if (typeof url !== "string"
                || url.length === 0
                || url.length > MAX_NETWORK_EVIDENCE_URL_LENGTH
                || observedNetworkUrls.length >= MAX_NETWORK_EVIDENCE_URLS) {
              networkEvidenceInvalid = true;
              return;
            }
            observedNetworkUrls.push(url);
          };
          pageCdp.on("Network.requestWillBeSent", ({ request } = {}) => {
            observeNetworkURL(request?.url);
          });
          pageCdp.on("Network.webSocketCreated", ({ url } = {}) => {
            observeNetworkURL(url);
          });
          // Page and network observers exist before their domains are enabled.
          // The selected page must later contain its own POST; no other page's
          // traffic is merged into the dashboard receipt. Runtime is enabled
          // only after this target has been bound to its selected loopback
          // origin, so an early exception cannot be classified against an
          // opaque about:blank origin.
          await pageCdp.request("Page.enable");
          await pageCdp.request("Network.enable");
          attachedPages.set(target.id, Object.freeze({
            targetId: target.id,
            cdp: pageCdp,
            refreshObserver: pageRefreshObserver,
            rendererReadinessDiagnostics: pageRendererReadinessDiagnostics,
            observedNetworkUrls,
            networkEvidenceInvalid: () => networkEvidenceInvalid,
          }));
        } catch {
          pageRendererReadinessDiagnostics?.dispose?.();
          pageRefreshObserver?.dispose?.();
          pageCdp?.close?.();
        }
      }));
      const target = selectLinuxDashboardTarget(targets, port);
      if (!target) return null;
      const page = attachedPages.get(target.id);
      if (!page) return null;
      return { target, page };
    }, MAX_STARTUP_MS, "Electron dashboard target");
    const { target, page: selectedPage } = dashboardSelection;
    cdp = selectedPage.cdp;
    refreshObserver = selectedPage.refreshObserver;
    rendererReadinessDiagnostics = selectedPage.rendererReadinessDiagnostics;
    const observedNetworkUrls = selectedPage.observedNetworkUrls;
    const selectedDashboardUrl = new URL(target.url);
    if (rendererReadinessDiagnostics.bindSelectedDashboardUrl(selectedDashboardUrl.href)
        !== selectedDashboardUrl.origin) {
      fail("dashboard diagnostics did not bind the selected loopback origin");
    }
    companionSnapshotObserver = createRendererReadinessCompanionSnapshotObserver(
      selectedDashboardUrl.origin,
    );
    await cdp.request("Runtime.enable");
    selectRequiredRefreshLoader(refreshObserver, await waitFor(
      () => mainFrameLoaderId(cdp),
      MAX_STARTUP_MS,
      "Electron dashboard frame",
    ));
    // A readiness timeout retains only the last observed boolean state as a
    // closed stage. Location and resource URLs remain local inputs to the
    // origin checks; no title, heading, URL, or page content enters diagnostics.
    failureStage = "renderer_readiness_unobserved";
    const ready = await waitFor(
      async () => {
        const snapshot = await cdp.evaluate(`(() => ({
          readyMarker: document.documentElement?.dataset?.localDashboardReady === "true",
          titleMatches: document.title === "TiboTattle",
          overviewHeadingPresent: Boolean(document.querySelector("#overview-title")?.textContent?.trim()),
          location: location.href,
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
        }))()`);
        failureStage = rendererReadinessFailureStage(snapshot);
        return failureStage === null ? snapshot : null;
      },
      MAX_STARTUP_MS,
      "dashboard renderer readiness",
    );
    await companionSnapshotObserver.stop();
    failureStage = "renderer_origin";
    selectRequiredRefreshLoader(refreshObserver, await mainFrameLoaderId(cdp));
    const dashboardUrl = new URL(ready.location);
    if (dashboardUrl.origin !== selectedDashboardUrl.origin
        || dashboardUrl.pathname !== "/"
        || dashboardUrl.search !== ""
        || dashboardUrl.hash !== "") {
      fail("dashboard did not load from the companion loopback origin");
    }
    if (refreshObserver.selectOrigin(dashboardUrl.origin) !== dashboardUrl.origin) {
      fail("dashboard origin was not accepted as the validated loopback origin");
    }
    failureStage = "renderer_health";
    const health = await jsonFetch(new URL("/api/local/health", dashboardUrl));
    if (health.status !== "ready") fail("companion health was not ready");
    failureStage = "renderer_resource";
    const remoteResources = ready.resources.filter((resource) => {
      try {
        const parsed = new URL(resource);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    });
    if (remoteResources.some((resource) => new URL(resource).origin !== dashboardUrl.origin)) {
      fail("renderer requested a non-loopback resource");
    }
    failureStage = "renderer_navigation";
    await assertRendererShell(cdp);
    failureStage = "initial_refresh";
    const initialStartupRefresh = await assertAutomaticStartupRefresh({
      child,
      dashboardUrl,
      refreshObserver,
    });

    const descendantsAtReady = descendantsOf(child.pid);
    const descendantIdentitiesAtReady = descendantsAtReady
      .map((pid) => captureLinuxProcessIdentity(pid))
      .filter((identity) => identity !== null);
    if (descendantIdentitiesAtReady.length < 1) {
      fail("Electron had no companion descendant after readiness");
    }

    failureStage = "reload_refresh";
    const previousStatus = await jsonFetch(new URL("/api/local/refresh", dashboardUrl));
    const previousRefreshId = typeof previousStatus?.refresh?.refreshId === "string"
      ? previousStatus.refresh.refreshId
      : null;
    const before = await cdp.evaluate(
      "({ timeOrigin: performance.timeOrigin, url: location.href })",
    );
    const beforeLoaderId = await mainFrameLoaderId(cdp);
    refreshObserver.reset();
    await cdp.request("Page.reload", { ignoreCache: false });
    const fresh = await waitFor(
      async () => {
        const snapshot = await cdp.evaluate(`(() => ({
          ready: document.documentElement?.dataset?.localDashboardReady === "true",
          timeOrigin: performance.timeOrigin,
          url: location.href,
        }))()`);
        const loaderId = await mainFrameLoaderId(cdp);
        const loaderChanged = beforeLoaderId === null
          || (loaderId !== null && loaderId !== beforeLoaderId);
        return snapshot.ready
          && Number.isFinite(snapshot.timeOrigin)
          && snapshot.timeOrigin !== before.timeOrigin
          && snapshot.url === before.url
          && loaderChanged
          ? { snapshot, loaderId }
          : null;
      },
      MAX_STARTUP_MS,
      "dashboard fresh-document render",
    );
    selectRequiredRefreshLoader(refreshObserver, fresh.loaderId);
    await assertRendererShell(cdp);
    const reloadStartupRefresh = await assertAutomaticStartupRefresh({
      child,
      dashboardUrl,
      refreshObserver,
      previousRefreshId,
    });
    const startupRefresh = combineStartupRefreshEvidence(
      initialStartupRefresh,
      reloadStartupRefresh,
    );
    failureStage = "observation";
    await afterRefresh?.({
      dashboardOrigin: dashboardUrl.origin,
      fixture,
      startupRefresh,
    });
    failureStage = "renderer_late_network";
    if (selectedPage.networkEvidenceInvalid()
        || observedNetworkUrls.some((url) => !isAllowedRendererNetworkURL(url, dashboardUrl.origin))) {
      fail("renderer attempted a non-loopback network request");
    }

    // CDP window bounds are the most deterministic lifecycle control available
    // in a headless desktop lane. A real desktop can additionally exercise the
    // tray's hide/show actions; this lane proves that minimizing/restoring does
    // not lose the renderer or companion.
    failureStage = "quit_cleanup";
    let windowMinimizedAndRestored = false;
    try {
      const windowInfo = await cdp.request("Browser.getWindowForTarget");
      if (Number.isInteger(windowInfo.windowId)) {
        await cdp.request("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "minimized" },
        });
        await wait(150);
        await cdp.request("Browser.setWindowBounds", {
          windowId: windowInfo.windowId,
          bounds: { windowState: "normal" },
        });
        await waitFor(
          () => cdp.evaluate("document.documentElement?.dataset?.localDashboardReady === 'true'"),
          MAX_OPERATION_MS,
          "dashboard restore readiness",
        );
        windowMinimizedAndRestored = true;
      }
    } catch (error) {
      // Electron 43's page-scoped CDP endpoint does not expose the browser
      // window-bounds methods. Renderer reload and process/companion cleanup
      // remain mandatory; a desktop runner can add tray/window controls later.
      if (!/wasn't found|method not found/iu.test(error?.message ?? "")) throw error;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      fail("Electron exited before the clean-quit control was sent");
    }
    if (!child.kill("SIGUSR2")) {
      fail("Electron clean-quit control could not be sent");
    }
    await withTimeout(once(child, "exit"), MAX_SHUTDOWN_MS, "Electron clean quit");
    // Surviving children are reparented as soon as Electron exits, so walking
    // the now-dead parent would false-pass. Bind every ready-time descendant
    // to its Linux /proc start identity and prove those exact processes are
    // gone even if their PPID changes during shutdown.
    await waitFor(
      () => descendantIdentitiesAtReady.every(
        (identity) => !linuxProcessIdentityIsAlive(identity),
      ),
      MAX_SHUTDOWN_MS,
      "companion cleanup",
    );
    cleanupConfirmed = true;
    if (child.signalCode !== null || child.exitCode !== 0) {
      fail(child.signalCode === null
        ? `Electron exited with code ${child.exitCode}`
        : `Electron exited via ${child.signalCode}`);
    }
    const result = Object.freeze({
      status: "passed",
      electron: version.Browser,
      dashboardOrigin: dashboardUrl.origin,
      descendantCountAtReady: descendantsAtReady.length,
      rendererReloaded: true,
      windowMinimizedAndRestored,
      cleanQuit: true,
      networkBoundary: NETWORK_BOUNDARY,
      networkBoundaryEvidence: containerContract.networkBoundaryEvidence,
      imagePlatform: process.env.USAGE_MONITOR_LINUX_IMAGE_PLATFORM,
      runtimeArchitecture: process.arch,
      sourceRevision: selectedSourceRevision,
      qualification,
      startupRefresh,
    });
    await writeResult(result);
    return result;
  } catch (error) {
    forcedShutdown = true;
    if (isRendererReadinessFailureStage(failureStage)
        && onRendererReadinessDiagnostics !== null) {
      try {
        await companionSnapshotObserver?.stop?.();
        const companionSnapshot = companionSnapshotObserver?.snapshot?.()
          ?? unobservedRendererCompanionSnapshot();
        const diagnostic = await rendererReadinessDiagnostics?.snapshotWithTimingAndProbe?.({
          companionSnapshot,
        })
          ?? rendererReadinessDiagnostics?.snapshot?.({ companionSnapshot })
          ?? null;
        onRendererReadinessDiagnostics(diagnostic);
      } catch {
        // A diagnostic listener must not alter the underlying smoke failure.
      }
    }
    if (onCompanionProcessDiagnostics !== null) {
      try { onCompanionProcessDiagnostics(companionProcessDiagnostics.snapshot()); }
      catch { /* Never replace the smoke failure. Captured before forced cleanup. */ }
    }
    if (onDashboardFailureDiagnostic !== null) {
      try { onDashboardFailureDiagnostic(dashboardFailureDiagnostics.snapshot()); }
      catch { /* Never replace the smoke failure. */ }
    }
    if (failureStage !== null && ELECTRON_LINUX_SMOKE_FAILURE_STAGE_SET.has(failureStage)
        && onFailureStage !== null) {
      try {
        onFailureStage(failureStage);
      } catch {
        // A diagnostic listener must not alter the underlying smoke failure.
      }
    }
    throw error;
  } finally {
    await companionSnapshotObserver?.stop?.();
    for (const page of attachedPages.values()) {
      page.rendererReadinessDiagnostics?.dispose?.();
      page.refreshObserver?.dispose?.();
      page.cdp?.close?.();
    }
    if (!childHasExited(child)) await terminateLinuxSmokeChild(child);
    if (cleanupConfirmed) {
      await rm(fixture.root, { recursive: true, force: true });
    }
    if (forcedShutdown) {
      // Keep diagnostics content-free. The fixture is retained after a failed
      // journey, and neither Electron nor companion output is forwarded.
      for (const diagnostic of fixedRuntimeFailureDiagnostics({
        stdoutProduced,
        stderrProduced,
      })) {
        process.stderr.write(diagnostic);
      }
    }
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await runSmoke();
  } catch {
    process.stderr.write(`${CLI_FAILURE_STATUS}\n`);
    process.exitCode = 1;
  }
}
