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
import { dirname, join, resolve, win32 } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  loadAuditedWindowsCredentialBinding,
} from "../src/platform/windows-credential-manager-probe.js";
import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  validateDesktopShellStatus,
} from "../src/desktop-shell-status.js";
import {
  createDesktopFirstRunReceiptBackend,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "../apps/electron/desktop-first-run.js";
import {
  createWindowsProtectedStateStore,
} from "../src/platform/windows-protected-state-store.js";

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
// The first primary dashboard startup is the one foreground pass where the
// qualification fixture may need a bounded diagnostic extension. This is a
// one-run ceiling for that initial observation, not a claim about normal
// indexing latency; it remains below the companion's own five-minute abort.
// Reloads and relaunches deliberately use MAX_REFRESH_MS instead.
const MAX_STARTUP_REFRESH_COMPLETION_MS = 120_000;
const MAX_SHUTDOWN_MS = 15_000;
const WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE = "windows-electron-smoke-v1";
const WINDOWS_ELECTRON_SMOKE_OUTPUT_PATH_ENV =
  "TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_OUTPUT_PATH";
const WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_PATH_ENV =
  "TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_DIAGNOSTIC_PATH";
const WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_SCHEMA =
  "tibotattle-windows-electron-runtime-diagnostic-v1";
const WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE = "command-v1";
const WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE = "state-v1";
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE = "credential-v1";
const WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE = "quit-v1";
const WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS = "accepted-v1";
const WINDOWS_ELECTRON_SMOKE_PASSED_STATUS = "passed-v1";
const WINDOWS_ELECTRON_SMOKE_FAILED_STATUS = "failed-v1";
const WINDOWS_ELECTRON_SMOKE_COMMANDS = new Set([
  "status-v1",
  "tray-show-v1",
  "tray-hide-v1",
  "tray-toggle-v1",
  "credential-probe-v1",
  "credential-create-v1",
  "credential-read-v1",
  "credential-delete-v1",
  "quit-v1",
]);
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS = Object.freeze({
  "credential-probe-v1": "probe-v1",
  "credential-create-v1": "create-v1",
  "credential-read-v1": "read-v1",
  "credential-delete-v1": "delete-v1",
});
const WINDOWS_PROCESS_TABLE_QUERY = [
  "$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId)",
  "foreach ($row in $all) { Write-Output (([int]$row.ProcessId).ToString() + ':' + ([int]$row.ParentProcessId).ToString())",
  "}",
].join(";");

const WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_PHASES = new Set([
  "module_loaded",
  "entry_started",
  "run_smoke_started",
  "terminate_process_tree_started",
  "terminate_process_tree_finished",
  "cleanup_started",
  "post_terminate_cleanup_started",
  "cleanup_finished",
  "caught_failure",
  "completed",
]);
const WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_EXIT_CLASSES = new Set([
  "running",
  "caught_failure",
  "completed",
]);
let smokeDiagnosticWrite = Promise.resolve();

/**
 * Write one small, content-free checkpoint for the outer workflow boundary.
 * Marker delivery does not alter the product smoke result, but the workflow
 * requires a valid checkpoint and fails closed when it is missing or invalid.
 * The workflow deletes this file before retaining any evidence.
 */
async function writeSmokeDiagnostic(
  phase,
  status = "running",
  exitClass = "running",
) {
  const outputPath = process.env[WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_PATH_ENV];
  if (typeof outputPath !== "string" || outputPath.length === 0
      || !WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_PHASES.has(phase)
      || !["running", "sealed"].includes(status)
      || !WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_EXIT_CLASSES.has(exitClass)) {
    return;
  }
  const marker = JSON.stringify({
    schemaVersion: WINDOWS_ELECTRON_SMOKE_DIAGNOSTIC_SCHEMA,
    status,
    phase,
    exitClass,
    contentFree: true,
  });
  smokeDiagnosticWrite = smokeDiagnosticWrite
    .catch(() => {})
    .then(async () => {
      try {
        await writeFile(outputPath, `${marker}\n`, "utf8");
      } catch {
        // The workflow treats a missing marker as a bounded diagnostic failure.
      }
    });
  await smokeDiagnosticWrite;
}

/**
 * Match the CLI entry path using the filesystem's path identity rules.
 * Windows paths are case-insensitive, while the POSIX comparison remains
 * case-sensitive.  This is defensive entry-point hygiene; the diagnostic
 * checkpoint below remains the source of truth when entry is not reached.
 */
export function isWindowsSmokeDirectEntry({
  argvPath = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  platform = process.platform,
} = {}) {
  if (typeof argvPath !== "string" || argvPath.length === 0
      || typeof modulePath !== "string" || modulePath.length === 0) {
    return false;
  }
  const pathResolve = platform === "win32" ? win32.resolve : resolve;
  const selectedArgvPath = pathResolve(argvPath);
  const selectedModulePath = pathResolve(modulePath);
  return platform === "win32"
    ? selectedArgvPath.toLowerCase() === selectedModulePath.toLowerCase()
    : selectedArgvPath === selectedModulePath;
}

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
  "status",
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
  "refresh_not_accepted",
  "refresh_terminal_failed",
  "status_schema",
  "status_state",
  "status_query_accepted",
  "status_method_accepted",
  "dash_loopback",
  "dash_origin",
  "dash_health",
  "dash_topbar",
  "dash_sidebar",
  "dash_nav",
  "dash_active_nav",
  "dash_active_page",
  "dash_refresh",
  "dash_language",
  "dash_trends_nav",
  "dash_trends_page",
  "dash_previous_page",
  "dash_trends_count",
  "dash_refresh_boundary",
  "dash_startup_duplicate",
  "dash_startup_receipt",
  "dash_startup_changed",
  "dash_startup_failed",
  "dash_startup_cancelled",
  "dash_startup_degraded",
  "unknown",
]);

const FAILURE_STAGE_SET = new Set(WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST);
const FAILURE_REASON_SET = new Set(WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST);
// These fixed codes are the only status/refresh details that cross the
// diagnostic boundary.  In particular, the status state is never serialized
// with allowance, evidence, or any other response payload.
const FIXED_FAILURE_REASON_BY_CODE = Object.freeze({
  WINDOWS_ELECTRON_SMOKE_REFRESH_NOT_ACCEPTED: "refresh_not_accepted",
  WINDOWS_ELECTRON_SMOKE_REFRESH_FAILED: "refresh_terminal_failed",
  WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_SCHEMA_INVALID: "status_schema",
  WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_FAIL_CLOSED_INVALID: "status_state",
  WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_QUERY_ACCEPTED: "status_query_accepted",
  WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_METHOD_ACCEPTED: "status_method_accepted",
});
const DASHBOARD_FAILURE_REASON_BY_CODE = Object.freeze({
  WINDOWS_ELECTRON_SMOKE_LOOPBACK_REQUIRED: "dash_loopback",
  WINDOWS_ELECTRON_SMOKE_LOOPBACK_ORIGIN_INVALID: "dash_origin",
  WINDOWS_ELECTRON_SMOKE_COMPANION_NOT_READY: "dash_health",
  WINDOWS_ELECTRON_SMOKE_SHELL_TOPBAR_MISSING: "dash_topbar",
  WINDOWS_ELECTRON_SMOKE_SHELL_SIDEBAR_MISSING: "dash_sidebar",
  WINDOWS_ELECTRON_SMOKE_SHELL_NAVIGATION_INVALID: "dash_nav",
  WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_NAV_INVALID: "dash_active_nav",
  WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_PAGE_INVALID: "dash_active_page",
  WINDOWS_ELECTRON_SMOKE_SHELL_REFRESH_MISSING: "dash_refresh",
  WINDOWS_ELECTRON_SMOKE_SHELL_LANGUAGE_MISSING: "dash_language",
  WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_INACTIVE: "dash_trends_nav",
  WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_PAGE_INACTIVE: "dash_trends_page",
  WINDOWS_ELECTRON_SMOKE_SHELL_PREVIOUS_PAGE_ACTIVE: "dash_previous_page",
  WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_COUNT_INVALID: "dash_trends_count",
  WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID: "dash_refresh_boundary",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_DUPLICATED: "dash_startup_duplicate",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID: "dash_startup_receipt",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED: "dash_startup_changed",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_FAILED: "dash_startup_failed",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_CANCELLED: "dash_startup_cancelled",
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_DEGRADED: "dash_startup_degraded",
});
const DASHBOARD_FAILURE_PHASES = new Set(["dashboard", "refresh"]);
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
  "WINDOWS_ELECTRON_SMOKE_CDP_ATTACH_FAILED",
]);
const SMOKE_PHASE_STAGE = Object.freeze({
  artifact: "artifact",
  launch: "launch",
  control: "control",
  dashboard: "dashboard",
  credential: "credential",
  lifecycle: "lifecycle",
  refresh: "refresh",
  status: "status",
  persistence: "persistence",
  instance: "instance",
  shutdown: "shutdown",
  relaunch: "relaunch",
});

export const WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES = Object.freeze({
  duplicate: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_DUPLICATED",
  invalidReceipt: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID",
  changedReceipt: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED",
  failed: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_FAILED",
  cancelled: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_CANCELLED",
  degraded: "WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_DEGRADED",
});

// The Windows preload gate is a qualification-only observation seam.  Its
// failure crosses the same fixed, content-free boundary as the existing
// loader/origin checks; no renderer object, URL, or exception text is ever
// retained in the runtime aggregate.
export const WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES = Object.freeze({
  boundaryInvalid: "WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID",
});

const WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_BRIDGE_NAME =
  "__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__";
const WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_BRIDGE_VERSION = "v1";

/**
 * Classify the fixed result returned by the renderer-side startup gate.  The
 * CDP expression returns only these short vocabulary values, so malformed,
 * missing, and already-released bridges cannot leak renderer details across
 * the runtime evidence boundary.
 */
export function classifyWindowsSmokeStartupGateResult(value) {
  if (value === "released") {
    return Object.freeze({ status: "released" });
  }
  if (value === "missing") {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid,
      reason: "missing",
    });
  }
  if (value === "malformed") {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid,
      reason: "malformed",
    });
  }
  if (value === "duplicate") {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid,
      reason: "duplicate",
    });
  }
  return Object.freeze({
    status: "failed",
    errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid,
    reason: "malformed",
  });
}

// Dashboard connection progress is deliberately a closed vocabulary.  It is
// retained in the failed aggregate so a blocked runtime can distinguish the
// recovery page from a dashboard target without exposing a URL, port, title,
// path, log, or renderer content.  `not_started` covers artifact/launch and
// unsupported boundaries where no dashboard probe was attempted.
export const WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST = Object.freeze([
  "not_started",
  "debug_endpoint_ready",
  "target_poll_no_page",
  "target_poll_recovery_only",
  "target_poll_dashboard_candidate",
  "cdp_attach_failed",
  "frame_unavailable",
  "renderer_not_ready",
  "dashboard_ready",
  "startup_gate_released",
  "startup_refresh_request_observed",
  "startup_refresh_receipt_accepted",
  "startup_refresh_terminal_succeeded",
]);

// Refresh progress is projected into four fixed pairs.  The smoke never
// serializes the companion's counters, timestamps, result, error code, or
// indexing payload; these pairs only answer which bounded phase was visible
// when the startup completion window expired.
export const WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST = Object.freeze([
  Object.freeze({ stage: "none", detail: "none" }),
  Object.freeze({ stage: "collector", detail: "in_progress" }),
  Object.freeze({ stage: "collector", detail: "quick_result" }),
  Object.freeze({ stage: "indexing", detail: "archive_index" }),
]);

// Copied from the companion's reviewed public unified-index error vocabulary.
// Pattern-valid strings are not accepted: an unknown/missing degraded reason
// collapses to the fixed `{ unified_index, unknown }` pair.
export const WINDOWS_ELECTRON_SMOKE_UNIFIED_INDEX_FAILURE_CODE_ALLOWLIST = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
  "local_unified_index_aborted",
  "local_unified_index_directory_sync_failed",
  "local_unified_index_file_changed",
  "local_unified_index_file_invalid",
  "local_unified_index_generation_invalid",
  "local_unified_index_generation_mismatch",
  "local_unified_index_integrity_failed",
  "local_unified_index_journal_mode_refused",
  "local_unified_index_meta_invalid",
  "local_unified_index_missing",
  "local_unified_index_publication_durability_uncertain",
  "local_unified_index_schema_invalid",
  "local_unified_index_secondary_indexes_failed",
  "local_unified_index_secondary_indexes_missing",
  "local_unified_index_secret_invalid",
  "local_unified_index_secret_unavailable",
  "local_unified_index_unavailable",
  "local_unified_index_worker_failed",
  "local_unified_index_refresh_failed",
]);

const DASHBOARD_REFRESH_PROGRESS_KEY = (value) =>
  `${value?.stage ?? ""}\0${value?.detail ?? ""}`;
const DASHBOARD_REFRESH_PROGRESS_SET = new Set(
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST
    .map(DASHBOARD_REFRESH_PROGRESS_KEY),
);
const DASHBOARD_REFRESH_PROGRESS_RANK = new Map(
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST
    .map((value, index) => [DASHBOARD_REFRESH_PROGRESS_KEY(value), index]),
);
const DEFAULT_DASHBOARD_REFRESH_PROGRESS =
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST[0];
const UNIFIED_INDEX_FAILURE_CODE_SET = new Set(
  WINDOWS_ELECTRON_SMOKE_UNIFIED_INDEX_FAILURE_CODE_ALLOWLIST,
);
const DEFAULT_DASHBOARD_REFRESH_FAILURE = Object.freeze({
  failedStep: "none",
  failureCode: "none",
});
const UNKNOWN_DASHBOARD_REFRESH_FAILURE = Object.freeze({
  failedStep: "unified_index",
  failureCode: "unknown",
});

const DASHBOARD_CHECKPOINT_SET = new Set(
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST,
);
const DASHBOARD_CHECKPOINT_RANK = new Map(
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST
    .map((checkpoint, index) => [checkpoint, index]),
);

export function normalizeWindowsDashboardCheckpoint(value) {
  return typeof value === "string" && DASHBOARD_CHECKPOINT_SET.has(value)
    ? value
    : "not_started";
}

export function normalizeWindowsDashboardRefreshProgress(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_REFRESH_PROGRESS;
  }
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== "detail\0stage"
      || !DASHBOARD_REFRESH_PROGRESS_SET.has(DASHBOARD_REFRESH_PROGRESS_KEY(value))) {
    return DEFAULT_DASHBOARD_REFRESH_PROGRESS;
  }
  return WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST.find(
    (candidate) => DASHBOARD_REFRESH_PROGRESS_KEY(candidate)
      === DASHBOARD_REFRESH_PROGRESS_KEY(value),
  ) ?? DEFAULT_DASHBOARD_REFRESH_PROGRESS;
}

export function advanceWindowsDashboardRefreshProgress(current, next) {
  const currentProgress = normalizeWindowsDashboardRefreshProgress(current);
  const nextProgress = normalizeWindowsDashboardRefreshProgress(next);
  return (DASHBOARD_REFRESH_PROGRESS_RANK.get(DASHBOARD_REFRESH_PROGRESS_KEY(nextProgress)) ?? 0)
      > (DASHBOARD_REFRESH_PROGRESS_RANK.get(DASHBOARD_REFRESH_PROGRESS_KEY(currentProgress)) ?? 0)
    ? nextProgress
    : currentProgress;
}

export function normalizeWindowsDashboardRefreshFailure(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_REFRESH_FAILURE;
  }
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== "failedStep\0failureCode") {
    return DEFAULT_DASHBOARD_REFRESH_FAILURE;
  }
  if (value.failedStep === "none" && value.failureCode === "none") {
    return DEFAULT_DASHBOARD_REFRESH_FAILURE;
  }
  if (value.failedStep !== "unified_index"
      || (value.failureCode !== "unknown"
        && !UNIFIED_INDEX_FAILURE_CODE_SET.has(value.failureCode))) {
    return DEFAULT_DASHBOARD_REFRESH_FAILURE;
  }
  return Object.freeze({
    failedStep: "unified_index",
    failureCode: value.failureCode,
  });
}

export function classifyWindowsDashboardRefreshFailure(refresh) {
  if (refresh?.status !== "degraded") return DEFAULT_DASHBOARD_REFRESH_FAILURE;
  return Object.freeze({
    failedStep: "unified_index",
    failureCode: UNIFIED_INDEX_FAILURE_CODE_SET.has(refresh.failureCode)
      ? refresh.failureCode
      : UNKNOWN_DASHBOARD_REFRESH_FAILURE.failureCode,
  });
}

/**
 * Project the companion's public refresh status into a content-free phase.
 * `in_progress` identifies a validated collector descriptor before the early
 * headline; `quick_result` identifies that headline; the separate
 * archive-index marker identifies later indexing. Any missing or unrecognized
 * status remains `none` rather than allowing arbitrary response fields out.
 */
export function classifyWindowsDashboardRefreshProgress(refresh) {
  const value = refresh?.progress;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_REFRESH_PROGRESS;
  }
  if (value.kind === "archive_index" && value.status === "scanning") {
    return WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST[3];
  }
  if (value.phase === "quick_result") {
    return WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST[2];
  }
  if (value.boundedBy === "modified_at_and_collection_start"
      && ["recent_7d", "prospective"].includes(value.mode)
      && [
        "recent_7d_indexing",
        "recent_7d_complete",
        "recent_7d_partial",
        "prospective_only",
        "bounded_pause",
      ].includes(value.status)
      && [
        "discovering",
        "rollout_index",
        "quota_refresh",
        "complete",
        "paused",
        "prospective",
      ].includes(value.phase)) {
    return WINDOWS_ELECTRON_SMOKE_DASHBOARD_REFRESH_PROGRESS_ALLOWLIST[1];
  }
  return DEFAULT_DASHBOARD_REFRESH_PROGRESS;
}

/**
 * Advance one content-free dashboard checkpoint without ever moving the
 * aggregate backwards.  The same progress object is used for the initial
 * launch and relaunch, so an otherwise healthy relaunch must not replace a
 * completed startup receipt with an earlier readiness observation.
 */
export function advanceWindowsDashboardCheckpoint(current, next) {
  const currentCheckpoint = normalizeWindowsDashboardCheckpoint(current);
  const nextCheckpoint = normalizeWindowsDashboardCheckpoint(next);
  return (DASHBOARD_CHECKPOINT_RANK.get(nextCheckpoint) ?? 0)
    > (DASHBOARD_CHECKPOINT_RANK.get(currentCheckpoint) ?? 0)
    ? nextCheckpoint
    : currentCheckpoint;
}

/**
 * Classify one renderer startup-refresh observation without consulting the
 * companion or exposing any response data.  Keeping this decision pure lets
 * the contract lane exercise stale receipts, duplicate renderer requests,
 * and terminal receipt transitions independently of a Windows runtime.
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
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount > 1) {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount === 0 && phase === "acceptance") {
    return Object.freeze({ status: "pending" });
  }
  if (requestCount === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (refresh?.status === "idle") {
    return Object.freeze({ status: "pending" });
  }
  if (typeof refresh?.refreshId !== "string" || refresh.refreshId.length === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.invalidReceipt,
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
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.changedReceipt,
    });
  }
  if (refresh.status === "succeeded") {
    return Object.freeze({ status: "completed", refreshId: refresh.refreshId });
  }
  if (refresh.status === "failed") {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.failed,
    });
  }
  if (refresh.status === "cancelled") {
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.cancelled,
    });
  }
  if (refresh.status === "degraded") {
    const failure = classifyWindowsDashboardRefreshFailure(refresh);
    return Object.freeze({
      status: "failed",
      errorCode: WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.degraded,
      ...failure,
    });
  }
  return Object.freeze({ status: "pending", refreshId: refresh.refreshId });
}

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
    dashboardCheckpoint: normalizeWindowsDashboardCheckpoint(values.dashboardCheckpoint),
    dashboardRefreshProgress: normalizeWindowsDashboardRefreshProgress(
      values.dashboardRefreshProgress,
    ),
    dashboardRefreshFailure: normalizeWindowsDashboardRefreshFailure(
      values.dashboardRefreshFailure,
    ),
  });
}

function printAggregate(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * A failed Windows CreateProcess emits ChildProcess "error". That event is
 * fatal when it has no listener, so it can terminate this smoke runner before
 * the outer runSmoke() catch has a chance to print its closed aggregate. The
 * event intentionally carries no diagnostics across the boundary; the
 * bounded control/exit checks below classify the failure with fixed codes.
 */
export function attachSmokeChildErrorBoundary(child) {
  if (child === null
      || typeof child !== "object"
      || typeof child.on !== "function") {
    throw new TypeError("Windows Electron smoke child is invalid");
  }
  child.on("error", () => {});
  return child;
}

/**
 * A concurrently-started smoke monitor can reject before its later cleanup
 * await is reached. Attach a rejection handler at construction time so Node
 * does not terminate the runner for an early unhandled rejection, while
 * returning the original promise so that the later await still propagates
 * the fixed monitor failure through the smoke boundary.
 */
export function attachSmokeMonitorRejectionBoundary(promise) {
  if (promise === null
      || (typeof promise !== "object" && typeof promise !== "function")
      || typeof promise.catch !== "function") {
    throw new TypeError("Windows Electron smoke monitor promise is invalid");
  }
  void promise.catch(() => {});
  return promise;
}

function fail(code) {
  throw fixedError(code);
}

function failStartupRefreshDecision(decision) {
  const error = fixedError(decision.errorCode);
  const failure = normalizeWindowsDashboardRefreshFailure({
    failedStep: decision.failedStep,
    failureCode: decision.failureCode,
  });
  if (failure.failedStep !== "none") {
    error.dashboardRefreshFailure = failure;
  }
  throw error;
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
  const fixedFailureReason = FIXED_FAILURE_REASON_BY_CODE[code];
  const dashboardFailureReason = DASHBOARD_FAILURE_PHASES.has(phase)
    ? DASHBOARD_FAILURE_REASON_BY_CODE[code]
    : undefined;
  if (fixedFailureReason !== undefined) {
    failureReason = fixedFailureReason;
  } else if (dashboardFailureReason !== undefined) {
    failureReason = dashboardFailureReason;
  } else if (SMOKE_CHILD_EXIT_CODES.has(code)) {
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

/**
 * Build the disposable fixture used by the native smoke lane.
 *
 * The state root is deliberately not created through Node's ordinary mkdir
 * path.  The reviewed Windows adapter owns creation of that leaf so the
 * native owner-only ACL is applied at the point of creation.  The injectable
 * dependencies are a test seam only; production calls use the repository
 * adapter and fs/promises mkdir above.  The fixed receipt seeds a returning-
 * user qualification profile; it does not bypass the production first-run
 * acknowledgement path.
 */
async function populateSyntheticFixture({
  root,
  windowsFilesystemAdapterFactory,
  makeDirectory,
  windowsProtectedStateStoreFactory,
  firstRunReceiptBackendFactory,
}) {
  const home = join(root, "profile");
  const codexHome = join(home, ".codex");
  const claudeHome = join(home, ".claude");
  const stateRoot = join(root, "state");
  const userData = join(root, "electron-user-data");
  const runtimeDirectory = join(root, "runtime");
  const sessions = join(codexHome, "sessions");
  const windowsFilesystemAdapter = windowsFilesystemAdapterFactory({
    platform: "win32",
    architecture: "x64",
  });
  if (!windowsFilesystemAdapter
      || typeof windowsFilesystemAdapter.ensureDirectory !== "function") {
    throw fixedError("WINDOWS_ELECTRON_SMOKE_FILESYSTEM_ADAPTER_UNAVAILABLE");
  }
  await windowsFilesystemAdapter.ensureDirectory(stateRoot);
  await Promise.all([
    makeDirectory(sessions, { recursive: true }),
    makeDirectory(join(codexHome, "archived_sessions"), { recursive: true }),
    makeDirectory(claudeHome, { recursive: true }),
    makeDirectory(userData, { recursive: true }),
    makeDirectory(runtimeDirectory, { recursive: true }),
    makeDirectory(join(home, "AppData", "Roaming"), { recursive: true }),
    makeDirectory(join(home, "AppData", "Local"), { recursive: true }),
  ]);
  if (typeof windowsProtectedStateStoreFactory !== "function") {
    throw fixedError("WINDOWS_ELECTRON_SMOKE_PROTECTED_STATE_STORE_FACTORY_UNAVAILABLE");
  }
  if (typeof firstRunReceiptBackendFactory !== "function") {
    throw fixedError("WINDOWS_ELECTRON_SMOKE_FIRST_RUN_RECEIPT_BACKEND_FACTORY_UNAVAILABLE");
  }
  const settingsRoot = join(userData, "desktop-settings");
  const protectedStateStore = windowsProtectedStateStoreFactory({
    adapter: windowsFilesystemAdapter,
    rootPath: settingsRoot,
  });
  if (protectedStateStore === null
      || typeof protectedStateStore !== "object"
      || Array.isArray(protectedStateStore)) {
    throw fixedError("WINDOWS_ELECTRON_SMOKE_PROTECTED_STATE_STORE_UNAVAILABLE");
  }
  const receiptBackend = firstRunReceiptBackendFactory({
    platform: "win32",
    rootPath: settingsRoot,
    windowsProtectedStateStore: protectedStateStore,
  });
  if (receiptBackend === null
      || typeof receiptBackend !== "object"
      || Array.isArray(receiptBackend)
      || typeof receiptBackend.save !== "function") {
    throw fixedError("WINDOWS_ELECTRON_SMOKE_FIRST_RUN_RECEIPT_BACKEND_UNAVAILABLE");
  }
  await receiptBackend.save({
    schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
    acknowledged: true,
  });
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

export async function createSyntheticFixture({
  windowsFilesystemAdapterFactory = createWindowsFilesystemAdapter,
  windowsProtectedStateStoreFactory = createWindowsProtectedStateStore,
  firstRunReceiptBackendFactory = createDesktopFirstRunReceiptBackend,
  makeDirectory = mkdir,
  removeDirectory = rm,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-windows-"));
  try {
    return await populateSyntheticFixture({
      root,
      windowsFilesystemAdapterFactory,
      windowsProtectedStateStoreFactory,
      firstRunReceiptBackendFactory,
      makeDirectory,
    });
  } catch (error) {
    // The outer smoke cleanup begins only after fixture construction returns.
    // Make one bounded best-effort removal here so an adapter or mkdir failure
    // cannot strand synthetic profiles or logs in runner temporary storage.
    try {
      await removeDirectory(root, { recursive: true, force: true });
    } catch {
      // Preserve the original fixed initialization failure.
    }
    throw error;
  }
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
  const eventHandlers = new Map();
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
    const handlers = eventHandlers.get(message.method);
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(message.params ?? {});
        } catch {
          // An observation hook must never break the CDP dispatch loop. The
          // qualification reads its bounded evidence after the event arrives.
        }
      }
    }
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
  const on = (method, handler) => {
    if (typeof method !== "string" || typeof handler !== "function") {
      throw new TypeError("CDP event handler is invalid");
    }
    const handlers = eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) eventHandlers.delete(method);
    };
  };
  return Object.freeze({
    request,
    evaluate,
    waitForEvent,
    on,
    close() {
      socket.close();
      for (const { reject } of pending.values()) reject(new Error("CDP closed"));
      pending.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) waiter.reject(new Error("CDP closed"));
      }
      eventWaiters.clear();
      eventHandlers.clear();
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
  await writeSmokeDiagnostic("terminate_process_tree_started");
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
  await writeSmokeDiagnostic("terminate_process_tree_finished");
}

async function queryWindowsProcessTableWithSpawner(spawnProbe = spawn) {
  const query = WINDOWS_PROCESS_TABLE_QUERY;
  const probe = spawnProbe("powershell.exe", [
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
    // `exit` only means the process ended; piped stdout may still contain
    // buffered bytes. Parse only after `close`, when stdio has drained.
    probe.once("close", (code, signal) => {
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
    // Win32_Process includes the System Idle Process as the legitimate
    // root tuple 0:0. It is not a descendant of any Electron root, so accept
    // and discard that one tuple while keeping every other PID malformedness
    // check fail-closed (including pid 0 with a nonzero parent).
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)
        || parentPid < 0
        || (pid < 1 && !(pid === 0 && parentPid === 0))) {
      fail("WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID");
    }
    if (pid === 0) continue;
    table.set(pid, parentPid);
  }
  return table;
}

async function queryWindowsProcessTable() {
  return queryWindowsProcessTableWithSpawner(spawn);
}

/** Dependency-injected probe seam for plain-Node contract tests only. */
export async function queryWindowsProcessTableForTest({ spawnProbe } = {}) {
  if (typeof spawnProbe !== "function") {
    throw new TypeError("Windows process-table test probe is required");
  }
  return queryWindowsProcessTableWithSpawner(spawnProbe);
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

export function buildPackagedElectronArgs({
  userDataDir,
  remoteDebuggingPort,
  remoteDebugging = true,
} = {}) {
  if (typeof userDataDir !== "string" || userDataDir.length === 0
      || typeof remoteDebugging !== "boolean") {
    throw new TypeError("Packaged Electron launch arguments are invalid");
  }
  const args = [`--user-data-dir=${userDataDir}`];
  if (remoteDebugging) {
    if (!Number.isSafeInteger(remoteDebuggingPort) || remoteDebuggingPort < 1) {
      throw new TypeError("Packaged Electron debugging port is invalid");
    }
    args.push(
      `--remote-debugging-port=${remoteDebuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
    );
  }
  args.push("--disable-gpu", "--no-first-run");
  return args;
}

function spawnPackagedElectron(
  executable,
  fixture,
  port,
  cwd,
  { remoteDebugging = true } = {},
) {
  const child = spawn(executable, buildPackagedElectronArgs({
    userDataDir: fixture.userData,
    remoteDebuggingPort: port,
    remoteDebugging,
  }), {
    cwd,
    env: safeChildEnvironment(fixture),
    shell: false,
    windowsHide: true,
    // Electron's Windows GUI executable has no usable stdin/stdout. Use the
    // Node child-process IPC channel instead; it is not renderer IPC and is
    // available only to this explicitly spawned qualification process.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return attachSmokeChildErrorBoundary(child);
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeControlMessage(value) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || value.type !== WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE) {
    return null;
  }
  if (value.message === WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE
      && exactKeys(value, [
        "type",
        "message",
        "started",
        "primary",
        "window",
        "visible",
        "tray",
      ])
      && ["started", "primary", "window", "visible", "tray"]
        .every((key) => typeof value[key] === "boolean")) {
    return Object.freeze({
      type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
      message: WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE,
      started: value.started,
      primary: value.primary,
      window: value.window,
      visible: value.visible,
      tray: value.tray,
    });
  }
  if (value.message === WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE
      && exactKeys(value, ["type", "message", "operation", "status"])
      && Object.values(WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS)
        .includes(value.operation)
      && [
        WINDOWS_ELECTRON_SMOKE_PASSED_STATUS,
        WINDOWS_ELECTRON_SMOKE_FAILED_STATUS,
      ].includes(value.status)) {
    return Object.freeze({
      type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
      message: WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE,
      operation: value.operation,
      status: value.status,
    });
  }
  if (value.message === WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE
      && exactKeys(value, ["type", "message", "status"])
      && value.status === WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS) {
    return Object.freeze({
      type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
      message: WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE,
      status: WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS,
    });
  }
  return null;
}

function controlReader(child, observeMessage = null, retainMessages = true) {
  const messages = [];
  let active = true;
  const onMessage = (value) => {
    if (!active) return;
    const message = normalizeControlMessage(value);
    if (message === null) return;
    if (retainMessages) messages.push(message);
    if (typeof observeMessage === "function") observeMessage(message);
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    child.off?.("message", onMessage);
    child.off?.("disconnect", onDisconnect);
  };
  const onDisconnect = () => cleanup();
  child.on?.("message", onMessage);
  child.on?.("disconnect", onDisconnect);
  const nextMessage = async function nextMessage(
    predicate,
    label,
    timeoutCode = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
  ) {
    return waitFor(() => {
      const index = messages.findIndex(predicate);
      if (index < 0) return null;
      return messages.splice(index, 1)[0];
    }, MAX_OPERATION_MS, label, timeoutCode);
  };
  nextMessage.close = cleanup;
  return nextMessage;
}

function parseState(message) {
  if (message?.type !== WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE
      || message.message !== WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE) {
    fail("WINDOWS_ELECTRON_SMOKE_CONTROL_INVALID");
  }
  return Object.freeze({
    started: message.started,
    primary: message.primary,
    window: message.window,
    visible: message.visible,
    tray: message.tray,
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
  nextMessage,
  value,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
) {
  if (!WINDOWS_ELECTRON_SMOKE_COMMANDS.has(value)) {
    fail("WINDOWS_ELECTRON_SMOKE_CONTROL_INVALID");
  }
  await sendCommand(child, value, timeoutCode);
  const message = await nextMessage(
    (candidate) => candidate.message === WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE,
    `control ${value}`,
    timeoutCode,
  );
  return parseState(message);
}

async function sendCommand(
  child,
  value,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
) {
  if (typeof child.send !== "function" || child.connected === false) {
    fail("WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE");
  }
  await withTimeout(
    new Promise((resolveSend, rejectSend) => {
      try {
        child.send(Object.freeze({
          type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
          message: WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE,
          command: value,
        }), (error) => {
          if (error) rejectSend(fixedError("WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE"));
          else resolveSend();
        });
      } catch {
        rejectSend(fixedError("WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE"));
      }
    }),
    MAX_OPERATION_MS,
    "IPC command",
    timeoutCode,
  );
}

/**
 * Send one fixed credential control command and wait for its fixed result.
 * Credential values, service names, and native diagnostics never cross this
 * boundary; a failed response is converted to a stable smoke error.
 */
async function credentialCommand(
  child,
  nextMessage,
  value,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_CREDENTIAL_TIMEOUT",
) {
  const operation = WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[value];
  if (!operation) {
    fail("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_COMMAND_INVALID");
  }
  await sendCommand(child, value, timeoutCode).catch((error) => {
    if (error?.code === "WINDOWS_ELECTRON_SMOKE_CONTROL_UNAVAILABLE") {
      throw fixedError("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_CONTROL_UNAVAILABLE");
    }
    throw error;
  });
  const message = await nextMessage(
    (candidate) => candidate.message === WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE
      && candidate.operation === operation,
    `credential ${value}`,
    timeoutCode,
  );
  if (message.status !== WINDOWS_ELECTRON_SMOKE_PASSED_STATUS) {
    fail("WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATION_FAILED");
  }
  return true;
}

async function quitCommand(
  child,
  nextMessage,
  timeoutCode = "WINDOWS_ELECTRON_SMOKE_SHUTDOWN_TIMEOUT",
) {
  await sendCommand(child, "quit-v1", timeoutCode);
  await nextMessage(
    (candidate) => candidate.message === WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE
      && candidate.status === WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS,
    "clean quit acknowledgement",
    timeoutCode,
  );
}

function assertRendererShellSnapshot(snapshot) {
  if (snapshot?.topbar !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_TOPBAR_MISSING");
  if (snapshot?.sidebar !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_SIDEBAR_MISSING");
  if (snapshot?.navCount !== 5) fail("WINDOWS_ELECTRON_SMOKE_SHELL_NAVIGATION_INVALID");
  if (snapshot?.activeLinkCount !== 1) fail("WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_NAV_INVALID");
  if (snapshot?.activePageCount !== 1) fail("WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_PAGE_INVALID");
  if (snapshot?.refresh !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_REFRESH_MISSING");
  if (snapshot?.language !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_LANGUAGE_MISSING");
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
  if (trends?.activeLink !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_INACTIVE");
  if (trends?.activePage !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_PAGE_INACTIVE");
  if (trends?.previousPageInactive !== true) fail("WINDOWS_ELECTRON_SMOKE_SHELL_PREVIOUS_PAGE_ACTIVE");
  if (trends?.activePageCount !== 1) fail("WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_COUNT_INVALID");
  await cdp.evaluate(`document.querySelector('[data-nav="overview"]')?.click()`);
}

/**
 * Select only the main dashboard page for this smoke's ephemeral server.
 *
 * Electron exposes loading, recovery, settings, and other renderer targets
 * through the same /json endpoint. A page target is not sufficient evidence
 * of the dashboard: the URL must be the exact loopback root for a valid local
 * dashboard port, while the CDP websocket must belong to this run's exact
 * debugging port. Recovery is a data URL and is intentionally ignored here.
 */
export function isWindowsDashboardTarget(target, debugPort) {
  if (target === null
      || typeof target !== "object"
      || Array.isArray(target)
      || target.type !== "page"
      || typeof target.url !== "string"
      || typeof target.webSocketDebuggerUrl !== "string"
      || target.webSocketDebuggerUrl.length === 0
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
  const dashboardPort = Number(parsed.port);
  return parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && Number.isInteger(dashboardPort)
    && dashboardPort >= 1
    && dashboardPort <= 65_535
    && target.url === `http://127.0.0.1:${dashboardPort}/`
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.username === ""
    && parsed.password === ""
    && websocket.protocol === "ws:"
    && websocket.hostname === "127.0.0.1"
    && websocket.port === String(debugPort)
    && /^\/devtools\/page\/[^/?#]+$/u.test(websocket.pathname)
    && websocket.search === ""
    && websocket.hash === ""
    && websocket.username === ""
    && websocket.password === "";
}

export function selectWindowsDashboardTarget(targets, debugPort) {
  if (!Array.isArray(targets)) return undefined;
  return targets.find((target) => isWindowsDashboardTarget(target, debugPort));
}

/**
 * The pre-companion recovery window is the only non-dashboard page that may
 * be classified as recovery-only.  Its source is a fixed data-document
 * surface from recovery-window.js; the encoded document body is never read
 * or returned at this boundary.
 */
export function isWindowsRecoveryTarget(target) {
  return target !== null
    && typeof target === "object"
    && !Array.isArray(target)
    && target.type === "page"
    && typeof target.url === "string"
    && target.url.startsWith("data:text/html;charset=utf-8,");
}

export function classifyWindowsDashboardTargetPoll(targets, debugPort) {
  if (selectWindowsDashboardTarget(targets, debugPort) !== undefined) {
    return "target_poll_dashboard_candidate";
  }
  const pageTargets = Array.isArray(targets)
    ? targets.filter((candidate) => candidate?.type === "page")
    : [];
  return pageTargets.length > 0 && pageTargets.every(isWindowsRecoveryTarget)
    ? "target_poll_recovery_only"
    : "target_poll_no_page";
}

async function mainFrameLoaderId(cdp) {
  const tree = await cdp.request("Page.getFrameTree");
  const loaderId = tree?.frameTree?.frame?.loaderId;
  return typeof loaderId === "string" && loaderId.length > 0 ? loaderId : null;
}

function selectRequiredRefreshLoader(refreshObserver, loaderId) {
  if (typeof loaderId !== "string" || loaderId.length === 0
      || refreshObserver.selectLoader(loaderId) !== loaderId) {
    fail("WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID");
  }
}

/**
 * Release the Windows preload-owned startup pass only after the CDP observer
 * has been bound to the active dashboard document.  The renderer evaluates a
 * strict, fixed bridge contract and returns only a closed vocabulary result;
 * all failure classes intentionally collapse to the content-free boundary
 * code used by the runtime receipt.
 */
export async function releaseWindowsSmokeRefreshGate(cdp) {
  if (cdp === null || typeof cdp !== "object"
      || typeof cdp.evaluate !== "function") {
    fail(WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid);
  }
  let result;
  try {
    result = await cdp.evaluate(`(() => {
      const bridgeName = ${JSON.stringify(WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_BRIDGE_NAME)};
      const bridge = globalThis[bridgeName];
      if (!Object.hasOwn(globalThis, bridgeName)) return "missing";
      if (bridge === null
          || typeof bridge !== "object"
          || Array.isArray(bridge)
          || Object.isFrozen(bridge) !== true
          || bridge.version !== ${JSON.stringify(WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_BRIDGE_VERSION)}
          || Object.keys(bridge).length !== 3
          || Object.keys(bridge)[0] !== "version"
          || Object.keys(bridge)[1] !== "waitForStartupRefresh"
          || Object.keys(bridge)[2] !== "releaseStartupRefresh"
          || !Object.hasOwn(bridge, "version")
          || !Object.hasOwn(bridge, "waitForStartupRefresh")
          || !Object.hasOwn(bridge, "releaseStartupRefresh")
          || typeof bridge.waitForStartupRefresh !== "function"
          || typeof bridge.releaseStartupRefresh !== "function"
          || bridge.waitForStartupRefresh.length !== 0
          || bridge.releaseStartupRefresh.length !== 0) {
        return "malformed";
      }
      try {
        const released = bridge.releaseStartupRefresh();
        return released === true
          ? "released"
          : released === false
            ? "duplicate"
            : "malformed";
      } catch {
        return "malformed";
      }
    })()`);
  } catch {
    result = "malformed";
  }
  const decision = classifyWindowsSmokeStartupGateResult(result);
  if (decision.status !== "released") fail(decision.errorCode);
  return true;
}

/**
 * Observe the renderer's first-party refresh mutation without asking the
 * companion to expose an additional qualification-only counter. The
 * automatic Electron startup pass is a real renderer POST, so CDP's network
 * boundary is the narrowest evidence that it actually happened. Requests are
 * scoped to the validated dashboard loopback origin and active main-frame
 * loader so another local port or prior page cannot satisfy a reload
 * assertion.
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
 * document. This runs after the renderer's app-owned readiness marker and
 * before the smoke's explicit synthetic refresh, so the latter remains a
 * separate data/persistence qualification step.
 */
async function assertAutomaticStartupRefresh({
  child,
  dashboardUrl,
  refreshObserver,
  previousRefreshId = null,
  onCheckpoint = () => {},
  onRefreshProgress = () => {},
  completionTimeoutMs = MAX_REFRESH_MS,
}) {
  const refreshUrl = new URL("/api/local/refresh", dashboardUrl);
  let refreshId = null;
  let requestObserved = false;
  await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const requests = refreshObserver.snapshot();
    if (requests.length === 0) return null;
    const noReceiptDecision = classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: requests.length,
      refresh: { status: "idle" },
      previousRefreshId,
    });
    if (noReceiptDecision.status === "failed") fail(noReceiptDecision.errorCode);
    if (requests.length === 1 && !requestObserved) {
      requestObserved = true;
      onCheckpoint("startup_refresh_request_observed");
    }
    const status = await jsonFetch(
      refreshUrl,
      undefined,
      "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
    );
    const refresh = status?.refresh;
    onRefreshProgress(classifyWindowsDashboardRefreshProgress(refresh));
    const decision = classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: requests.length,
      refresh,
      previousRefreshId,
    });
    if (decision.status === "pending") return null;
    if (decision.status === "failed") failStartupRefreshDecision(decision);
    refreshId = decision.refreshId;
    onCheckpoint("startup_refresh_receipt_accepted");
    return true;
  }, MAX_REFRESH_MS, "automatic startup refresh acceptance", "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT");

  await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const requests = refreshObserver.snapshot();
    if (requests.length !== 1) {
      const requestDecision = classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: requests.length,
        expectedRefreshId: refreshId,
      });
      if (requestDecision.status === "failed") fail(requestDecision.errorCode);
      return false;
    }
    const status = await jsonFetch(
      refreshUrl,
      undefined,
      "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
    );
    const refresh = status?.refresh;
    onRefreshProgress(classifyWindowsDashboardRefreshProgress(refresh));
    const decision = classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: requests.length,
      refresh,
      expectedRefreshId: refreshId,
    });
    if (decision.status === "pending") return false;
    if (decision.status === "failed") failStartupRefreshDecision(decision);
    onCheckpoint("startup_refresh_terminal_succeeded");
    return true;
  }, completionTimeoutMs, "automatic startup refresh completion", "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT");
  // A completed pass may schedule an intentional bounded reindex continuation.
  // It is a separate operation, not a second startup trigger; stop counting
  // this document once the startup receipt has reached its terminal success.
  refreshObserver.seal();
  return refreshId;
}

async function dashboardConnection(
  child,
  port,
  onCheckpoint = () => {},
  onRefreshProgress = () => {},
  startupRefreshCompletionMs = MAX_REFRESH_MS,
) {
  let currentCheckpoint = "not_started";
  const checkpoint = (value) => {
    const normalized = normalizeWindowsDashboardCheckpoint(value);
    const advanced = advanceWindowsDashboardCheckpoint(currentCheckpoint, normalized);
    if (advanced === currentCheckpoint) return;
    currentCheckpoint = advanced;
    onCheckpoint(advanced);
  };
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
  checkpoint("debug_endpoint_ready");
  const target = await waitFor(async () => {
    if (childExited(child)) fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    const targets = await jsonFetch(
      `http://127.0.0.1:${port}/json`,
      undefined,
      "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
    );
    const selected = selectWindowsDashboardTarget(targets, port);
    checkpoint(classifyWindowsDashboardTargetPoll(targets, port));
    if (selected !== undefined) {
      return selected;
    }
    return undefined;
  }, MAX_STARTUP_MS, "Electron dashboard target", "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT");
  let targetDashboardOrigin;
  try {
    targetDashboardOrigin = new URL(target.url).origin;
  } catch {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_ORIGIN_INVALID");
  }
  let cdp;
  try {
    cdp = await connectCdp(target);
  } catch {
    checkpoint("cdp_attach_failed");
    fail("WINDOWS_ELECTRON_SMOKE_CDP_ATTACH_FAILED");
  }
  const refreshObserver = observeLocalRefreshRequests(cdp);
  // Enable both domains immediately after attaching. The renderer's startup
  // pass is launched by the dashboard bootstrap, so delaying these domains
  // until after readiness can miss the only POST we are qualifying.
  try {
    await cdp.request("Page.enable");
    await cdp.request("Network.enable");
  } catch (error) {
    checkpoint("frame_unavailable");
    throw error;
  }
  const initialLoader = await waitFor(
    async () => {
      if (childExited(child)) {
        checkpoint("frame_unavailable");
        fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
      }
      try {
        const loaderId = await mainFrameLoaderId(cdp);
        if (loaderId === null) checkpoint("frame_unavailable");
        return loaderId;
      } catch {
        checkpoint("frame_unavailable");
        return null;
      }
    },
    MAX_STARTUP_MS,
    "Electron dashboard frame",
    "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  );
  selectRequiredRefreshLoader(refreshObserver, initialLoader);
  const ready = await waitFor(async () => {
    if (childExited(child)) {
      checkpoint("renderer_not_ready");
      fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY");
    }
    try {
      const snapshot = await cdp.evaluate(`(() => ({
        ready: document.documentElement?.dataset?.localDashboardReady === "true",
        title: document.title,
        heading: document.querySelector("#overview-title")?.textContent?.trim() ?? "",
        location: location.href,
      }))()`);
      if (snapshot.ready && snapshot.title === "TiboTattle" && snapshot.heading) {
        checkpoint("dashboard_ready");
        return snapshot;
      }
    } catch {
      // A renderer evaluation failure is indistinguishable from a renderer
      // that has not reached its app-owned readiness marker at this boundary.
    }
    checkpoint("renderer_not_ready");
    return null;
  }, MAX_STARTUP_MS, "dashboard readiness", "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT");
  let readyLoader;
  try {
    readyLoader = await mainFrameLoaderId(cdp);
  } catch (error) {
    checkpoint("frame_unavailable");
    throw error;
  }
  if (readyLoader === null) checkpoint("frame_unavailable");
  selectRequiredRefreshLoader(refreshObserver, readyLoader);
  const dashboardUrl = new URL(ready.location);
  if (dashboardUrl.protocol !== "http:" || dashboardUrl.hostname !== "127.0.0.1") {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_REQUIRED");
  }
  if (dashboardUrl.origin !== targetDashboardOrigin
      || dashboardUrl.pathname !== "/"
      || dashboardUrl.search !== ""
      || dashboardUrl.hash !== ""
      || dashboardUrl.username !== ""
      || dashboardUrl.password !== "") {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_ORIGIN_INVALID");
  }
  if (refreshObserver.selectOrigin(dashboardUrl.origin) !== dashboardUrl.origin) {
    fail("WINDOWS_ELECTRON_SMOKE_LOOPBACK_ORIGIN_INVALID");
  }
  await releaseWindowsSmokeRefreshGate(cdp);
  checkpoint("startup_gate_released");
  const health = await jsonFetch(
    new URL("/api/local/health", dashboardUrl),
    undefined,
    "WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT",
  );
  if (health.status !== "ready") fail("WINDOWS_ELECTRON_SMOKE_COMPANION_NOT_READY");
  await assertRendererShell(cdp);
  await assertAutomaticStartupRefresh({
    child,
    dashboardUrl,
    refreshObserver,
    onCheckpoint: checkpoint,
    onRefreshProgress,
    completionTimeoutMs: startupRefreshCompletionMs,
  });
  return Object.freeze({
    cdp,
    dashboardUrl,
    browser: version.Browser,
    refreshObserver,
    onCheckpoint: checkpoint,
    onRefreshProgress,
    child,
  });
}

/**
 * Reload through the CDP Page domain and require a main-frame navigation plus
 * a changed performance time origin before accepting dashboard readiness. The
 * navigation event and new-document timestamp prevent the old DOM from
 * satisfying the post-refresh render proof.
 */
async function reloadDashboardDocument(connection) {
  const previousStatus = await jsonFetch(
    new URL("/api/local/refresh", connection.dashboardUrl),
    undefined,
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  const previousRefreshId = typeof previousStatus?.refresh?.refreshId === "string"
    ? previousStatus.refresh.refreshId
    : null;
  connection.refreshObserver.reset();
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
  const navigated = await navigation;
  selectRequiredRefreshLoader(
    connection.refreshObserver,
    navigated?.frame?.loaderId ?? null,
  );
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
  await releaseWindowsSmokeRefreshGate(connection.cdp);
  connection.onCheckpoint?.("startup_gate_released");
  await assertAutomaticStartupRefresh({
    child: connection.child,
    dashboardUrl: new URL(before.url),
    refreshObserver: connection.refreshObserver,
    previousRefreshId,
    onCheckpoint: connection.onCheckpoint,
    onRefreshProgress: connection.onRefreshProgress,
  });
}

async function runSyntheticRefresh(connection) {
  const { dashboardUrl } = connection;
  const response = await withTimeout(
    fetch(new URL("/api/local/refresh", dashboardUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: dashboardUrl.origin,
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
  await assertRendererShell(connection.cdp);
}

/**
 * Qualify the fail-closed status projection from the real packaged companion
 * after its synthetic refresh. This disposable lane has no CODEX_BIN or
 * authenticated provider session, so it must remain `stale` with no
 * allowance/evidence. It does not qualify direct provider evidence or a fresh
 * allowance projection; those belong to an authenticated provider lane.
 */
async function assertFailClosedDesktopStatusRoute(connection) {
  const { dashboardUrl } = connection;
  const value = await jsonFetch(
    new URL("/api/local/desktop-status", dashboardUrl),
    undefined,
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  let status;
  try {
    status = validateDesktopShellStatus(value);
  } catch {
    fail("WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_SCHEMA_INVALID");
  }
  if (status.state !== "stale"
      || status.allowance !== null
      || status.notificationEvidence !== null) {
    fail("WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_FAIL_CLOSED_INVALID");
  }

  const queryResponse = await withTimeout(
    fetch(new URL("/api/local/desktop-status?private=1", dashboardUrl)),
    MAX_OPERATION_MS,
    "desktop status query rejection",
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  await queryResponse.body?.cancel?.().catch?.(() => {});
  if (queryResponse.status !== 400) {
    fail("WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_QUERY_ACCEPTED");
  }

  const methodResponse = await withTimeout(
    fetch(new URL("/api/local/desktop-status", dashboardUrl), {
      method: "POST",
    }),
    MAX_OPERATION_MS,
    "desktop status method rejection",
    "WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT",
  );
  await methodResponse.body?.cancel?.().catch?.(() => {});
  if (methodResponse.status !== 405) {
    fail("WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_METHOD_ACCEPTED");
  }
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
  await writeSmokeDiagnostic("run_smoke_started");
  const executable = resolve(process.env.TIBOTATTLE_ELECTRON_EXE ?? DEFAULT_EXECUTABLE);
  const artifactRoot = dirname(executable);
  progress.dashboardCheckpoint = normalizeWindowsDashboardCheckpoint(
    progress.dashboardCheckpoint,
  );
  progress.dashboardRefreshProgress = normalizeWindowsDashboardRefreshProgress(
    progress.dashboardRefreshProgress,
  );
  progress.dashboardRefreshFailure = normalizeWindowsDashboardRefreshFailure(
    progress.dashboardRefreshFailure,
  );
  const setDashboardCheckpoint = (checkpoint) => {
    const normalized = normalizeWindowsDashboardCheckpoint(checkpoint);
    const advanced = advanceWindowsDashboardCheckpoint(
      progress.dashboardCheckpoint,
      normalized,
    );
    if (advanced !== progress.dashboardCheckpoint) progress.dashboardCheckpoint = advanced;
  };
  const setDashboardRefreshProgress = (refreshProgress) => {
    const advanced = advanceWindowsDashboardRefreshProgress(
      progress.dashboardRefreshProgress,
      refreshProgress,
    );
    if (advanced !== progress.dashboardRefreshProgress) {
      progress.dashboardRefreshProgress = advanced;
    }
  };
  let fixture = null;
  let primary = null;
  let second = null;
  let relaunch = null;
  let connection = null;
  let nextPrimaryMessage = null;
  let nextRelaunchMessage = null;
  let secondMessageReader = null;
  let primaryQuitRequested = false;
  let relaunchQuitRequested = false;
  let credentialMayExist = false;
  let credentialDeleted = false;
  let failurePhase = "artifact";
  const cleanupCredential = async ({ allowLiveControl = true } = {}) => {
    if (!credentialMayExist || credentialDeleted) return;
    let liveAttempted = false;
    if (allowLiveControl) {
      for (const [child, nextMessage, quitRequested] of [
        [relaunch, nextRelaunchMessage, relaunchQuitRequested],
        [primary, nextPrimaryMessage, primaryQuitRequested],
      ]) {
        if (quitRequested || child === null || childExited(child)
            || typeof nextMessage !== "function") continue;
        liveAttempted = true;
        try {
          await credentialCommand(child, nextMessage, "credential-delete-v1");
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
    try {
      fixture = await createSyntheticFixture();
    } catch {
      // Keep fixture construction inside the classified boundary. Its
      // adapter, protected-store, or seed failure is represented only by the
      // existing artifact/assertion aggregate fields.
      fail("WINDOWS_ELECTRON_SMOKE_FIXTURE_SETUP_FAILED");
    }
    await assertWindowsExecutable(executable);
    progress.artifact = true;
    failurePhase = "launch";
    const primaryPort = await freeTcpPort();
    primary = spawnPackagedElectron(executable, fixture, primaryPort, artifactRoot);
    if (!primary.pid) fail("WINDOWS_ELECTRON_SMOKE_PRIMARY_PID_MISSING");
    nextPrimaryMessage = controlReader(primary);
    failurePhase = "control";
    const initialState = await waitFor(
      () => {
        if (childExited(primary)) {
          fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL");
        }
        return command(primary, nextPrimaryMessage, "status-v1");
      },
      MAX_STARTUP_MS,
      "primary shell status",
      "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT",
    );
    assertPrimaryShellState(initialState, "WINDOWS_ELECTRON_SMOKE_PRIMARY_STATE_INVALID");
    failurePhase = "dashboard";
    connection = await dashboardConnection(
      primary,
      primaryPort,
      setDashboardCheckpoint,
      setDashboardRefreshProgress,
      MAX_STARTUP_REFRESH_COMPLETION_MS,
    );
    failurePhase = "lifecycle";
    const primaryDescendantPids = await captureDescendantPids(primary.pid);
    progress.dashboardReady = true;

    // Run the random-namespace probe first, then create the deterministic
    // credential that must survive the first process exit and relaunch.
    failurePhase = "credential";
    await credentialCommand(primary, nextPrimaryMessage, "credential-probe-v1");
    credentialMayExist = true;
    await credentialCommand(primary, nextPrimaryMessage, "credential-create-v1");

    failurePhase = "lifecycle";
    const hidden = await command(primary, nextPrimaryMessage, "tray-hide-v1");
    const shown = await command(primary, nextPrimaryMessage, "tray-show-v1");
    const toggledHidden = await command(primary, nextPrimaryMessage, "tray-toggle-v1");
    const toggledShown = await command(primary, nextPrimaryMessage, "tray-toggle-v1");
    if (!hidden.tray || hidden.visible || !shown.visible || !toggledHidden.tray
        || toggledHidden.visible || !toggledShown.visible) {
      fail("WINDOWS_ELECTRON_SMOKE_WINDOW_TRAY_LIFECYCLE_FAILED");
    }
    progress.showHideTrayLifecycle = true;

    failurePhase = "refresh";
    await runSyntheticRefresh(connection);
    progress.syntheticRefresh = true;
    failurePhase = "status";
    await assertFailClosedDesktopStatusRoute(connection);
    failurePhase = "persistence";
    await writePersistentQualificationState(connection);

    failurePhase = "instance";
    second = spawnPackagedElectron(executable, fixture, null, artifactRoot, {
      remoteDebugging: false,
    });
    const secondObservedMessages = [];
    secondMessageReader = controlReader(second, (message) => {
      if (secondObservedMessages.length < 32) secondObservedMessages.push(message);
    }, false);
    const secondDescendantPids = new Set();
    const secondDescendantMonitor = attachSmokeMonitorRejectionBoundary(
      monitorDescendantsUntilExit(
        second,
        secondDescendantPids,
        "second instance descendant monitor",
      ),
    );
    let primaryDuringSecond;
    try {
      primaryDuringSecond = await command(
        primary,
        nextPrimaryMessage,
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
      secondMessageReader?.close?.();
      await secondDescendantMonitor;
    }
    assertPrimaryShellState(
      primaryDuringSecond,
      "WINDOWS_ELECTRON_SMOKE_PRIMARY_LOST_DURING_SECOND_INSTANCE",
    );
    if (second.exitCode !== 0 || second.signalCode !== null) {
      fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_NOT_REJECTED");
    }
    for (const message of secondObservedMessages) {
      if (message.message !== WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE) continue;
      const state = parseState(message);
      if (state.primary) fail("WINDOWS_ELECTRON_SMOKE_SECOND_INSTANCE_BECAME_PRIMARY");
    }
    const primaryAfterSecond = await command(
      primary,
      nextPrimaryMessage,
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

    const primaryDescendantMonitor = attachSmokeMonitorRejectionBoundary(
      monitorDescendantsUntilExit(
        primary,
        primaryDescendantPids,
        "primary descendant monitor",
      ),
    );
    primaryQuitRequested = true;
    try {
      await quitCommand(
        primary,
        nextPrimaryMessage,
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
    nextRelaunchMessage = controlReader(relaunch);
    try {
      const state = await waitFor(
        () => {
          if (childExited(relaunch)) {
            fail("WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL");
          }
          return command(relaunch, nextRelaunchMessage, "status-v1");
        },
        MAX_STARTUP_MS,
        "relaunch shell status",
        "WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT",
      );
      if (!state.started || !state.primary || !state.tray) {
        fail("WINDOWS_ELECTRON_SMOKE_RELAUNCH_STATE_INVALID");
      }
      const relaunched = await dashboardConnection(
        relaunch,
        relaunchPort,
        setDashboardCheckpoint,
        setDashboardRefreshProgress,
      );
      const relaunchDescendantPids = await captureDescendantPids(relaunch.pid);
      await verifyPersistentQualificationState(relaunched);
      progress.statePersistence = true;
      await credentialCommand(relaunch, nextRelaunchMessage, "credential-read-v1");
      relaunched.cdp.close();
      await credentialCommand(relaunch, nextRelaunchMessage, "credential-delete-v1");
      credentialDeleted = true;
      credentialMayExist = false;
      progress.credentialPersistence = true;
      const relaunchDescendantMonitor = attachSmokeMonitorRejectionBoundary(
        monitorDescendantsUntilExit(
          relaunch,
          relaunchDescendantPids,
          "relaunch descendant monitor",
        ),
      );
      relaunchQuitRequested = true;
      try {
        await quitCommand(
          relaunch,
          nextRelaunchMessage,
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
    if (progress.dashboardCheckpoint !== "startup_refresh_terminal_succeeded") {
      fail("WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID");
    }
    return aggregate("passed", progress);
  } catch (error) {
    const diagnostic = classifySmokeFailure(error, failurePhase);
    progress.failureStage = diagnostic.failureStage;
    progress.failureReason = diagnostic.failureReason;
    progress.dashboardRefreshFailure = normalizeWindowsDashboardRefreshFailure(
      error?.dashboardRefreshFailure,
    );
    throw error;
  } finally {
    await writeSmokeDiagnostic("cleanup_started");
    await cleanupCredential({ allowLiveControl: true });
    nextPrimaryMessage?.close?.();
    nextRelaunchMessage?.close?.();
    secondMessageReader?.close?.();
    connection?.refreshObserver?.dispose?.();
    connection?.cdp.close();
    await terminateProcessTree(second);
    await terminateProcessTree(primary);
    await terminateProcessTree(relaunch);
    await writeSmokeDiagnostic("post_terminate_cleanup_started");
    await cleanupCredential({ allowLiveControl: false });
    if (fixture !== null) {
      await rm(fixture.root, { recursive: true, force: true });
    }
    await writeSmokeDiagnostic("cleanup_finished");
  }
}

await writeSmokeDiagnostic("module_loaded");

if (isWindowsSmokeDirectEntry()) {
  // Keep progress outside the smoke promise so a startup, dashboard, or
  // cleanup failure can retain only the already-completed closed-schema
  // booleans and fixed diagnostic enums. The caller owns this plain object;
  // aggregate() projects only the allowlisted result keys and diagnostics.
  const progress = {};
  let output;
  try {
    await writeSmokeDiagnostic("entry_started");
    output = await runSmoke(progress);
  } catch {
    // Never expose executable paths, child diagnostics, account values, or
    // filesystem contents. The aggregate is the only supported smoke output.
    output = aggregate("failed", progress);
    process.exitCode = 1;
    await writeSmokeDiagnostic("caught_failure", "sealed", "caught_failure");
  }
  if (output?.status === "passed" || output?.status === "unsupported") {
    await writeSmokeDiagnostic("completed", "sealed", "completed");
  }
  const outputPath = process.env[WINDOWS_ELECTRON_SMOKE_OUTPUT_PATH_ENV];
  if (typeof outputPath === "string" && outputPath.length > 0) {
    try {
      // The workflow consumes this explicit, awaited file as the canonical
      // aggregate.  Console stdout remains a transient diagnostic stream;
      // relying on its PowerShell redirection can lose the final write when a
      // native Windows child exits during cleanup.
      await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
    } catch {
      // Keep the aggregate closed on stdout while forcing the workflow to
      // reject the missing sidecar rather than infer a runtime result.
      process.exitCode = 1;
    }
  }
  printAggregate(output);
}
