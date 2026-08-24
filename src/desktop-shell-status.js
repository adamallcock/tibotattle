import { isValidQuotaWindowDuration } from "@app-usagemonitor/quota-analysis";

/**
 * Content-free status projection for the cross-platform desktop shell.
 *
 * This boundary is deliberately smaller than the dashboard contract.  The
 * shell may use it for a tray/menu label and for the notification policy, but
 * it may not use it as a second dashboard API.  Only the closed v2 direct
 * provider evidence produced by the companion refresh boundary is accepted.
 * Malformed, stale, inferred, and mixed-source evidence is projected as an
 * unavailable allowance rather than being repaired or guessed here.
 */

export const DESKTOP_SHELL_STATUS_SCHEMA_VERSION =
  "tibotattle-desktop-shell-status-v1";

export const DESKTOP_SHELL_STATUS_STATES = Object.freeze([
  "starting",
  "analyzing",
  "fresh",
  "stale",
  "unavailable",
]);

export const DESKTOP_SHELL_ALLOWANCE_WINDOWS = Object.freeze([
  "five_hour",
  "seven_day",
]);

export const DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION =
  "tibotattle-notification-evidence-v2";

export const DESKTOP_SHELL_NOTIFICATION_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1_000;

const STATUS_SET = new Set(DESKTOP_SHELL_STATUS_STATES);
const ALLOWANCE_WINDOW_SET = new Set(DESKTOP_SHELL_ALLOWANCE_WINDOWS);
const EVIDENCE_KEYS = Object.freeze([
  "continuityKey",
  "freshness",
  "observedAt",
  "provider",
  "schemaVersion",
  "source",
  "status",
  "windows",
]);
const EVIDENCE_WINDOW_KEYS = Object.freeze([
  "durationMinutes",
  "lane",
  "resetAt",
  "resetProofKind",
  "usedPercent",
]);
const EVIDENCE_LANES = new Set(["primary", "secondary"]);
const REFRESH_STATES = new Set([
  "idle",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function validContinuityKey(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function validEvidenceWindow(value, observedAt) {
  if (!hasExactKeys(value, EVIDENCE_WINDOW_KEYS)
      || !EVIDENCE_LANES.has(value.lane)
      || !isValidQuotaWindowDuration(value.durationMinutes)
      || value.resetProofKind !== "provider_reported_schedule_only"
      || typeof value.usedPercent !== "number"
      || !Number.isFinite(value.usedPercent)
      || value.usedPercent < 0
      || value.usedPercent > 100) {
    return null;
  }
  const resetAt = canonicalInstant(value.resetAt);
  if (resetAt === null || Date.parse(resetAt) <= Date.parse(observedAt)) {
    return null;
  }
  return Object.freeze({
    lane: value.lane,
    usedPercent: Object.is(value.usedPercent, -0) ? 0 : value.usedPercent,
    durationMinutes: value.durationMinutes,
    resetAt,
    resetProofKind: "provider_reported_schedule_only",
  });
}

/**
 * Validate and clone the already-closed v2 evidence contract.
 *
 * `null` is the only failure result so a route caller cannot accidentally
 * serialize an exception message, path, account identifier, or raw provider
 * response into the desktop surface.
 */
export function projectDesktopShellNotificationEvidence(value, {
  now = Date.now(),
} = {}) {
  if (!hasExactKeys(value, EVIDENCE_KEYS)
      || value.schemaVersion
        !== DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION
      || value.status !== "fresh_provider_observation"
      || value.provider !== "openai_codex"
      || value.source !== "app_server_read"
      || value.freshness !== "fresh"
      || canonicalInstant(value.observedAt) === null
      || !validContinuityKey(value.continuityKey)
      || !Array.isArray(value.windows)
      || value.windows.length < 1
      || value.windows.length > 2
      || !Number.isFinite(now)) {
    return null;
  }
  const observedAtMs = Date.parse(value.observedAt);
  const ageMs = now - observedAtMs;
  if (!Number.isFinite(ageMs)
      || ageMs < 0
      || ageMs > DESKTOP_SHELL_NOTIFICATION_EVIDENCE_MAX_AGE_MS) {
    return null;
  }
  const seenLanes = new Set();
  const windows = [];
  for (const candidate of value.windows) {
    const window = validEvidenceWindow(candidate, value.observedAt);
    if (window === null || seenLanes.has(window.lane)) return null;
    seenLanes.add(window.lane);
    windows.push(window);
  }
  windows.sort((left, right) => left.lane.localeCompare(right.lane));
  return Object.freeze({
    schemaVersion: DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: value.observedAt,
    continuityKey: value.continuityKey,
    windows: Object.freeze(windows),
  });
}

function primaryAllowance(evidence) {
  const primary = evidence.windows
    .filter((window) => window.lane === "primary")
    .sort((left, right) => right.durationMinutes - left.durationMinutes)[0];
  if (primary === undefined) return null;
  const window = primary.durationMinutes === 300
    ? "five_hour"
    : primary.durationMinutes === 10_080
      ? "seven_day"
      : null;
  if (window === null || !ALLOWANCE_WINDOW_SET.has(window)) return null;
  return Object.freeze({
    source: "direct",
    window,
    remainingPercent: 100 - primary.usedPercent,
  });
}

function cloneAllowance(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ["remainingPercent", "source", "window"])
      || value.source !== "direct"
      || typeof value.window !== "string"
      || !ALLOWANCE_WINDOW_SET.has(value.window)
      || typeof value.remainingPercent !== "number"
      || !Number.isFinite(value.remainingPercent)
      || value.remainingPercent < 0
      || value.remainingPercent > 100) {
    throw new TypeError("desktop shell allowance is invalid");
  }
  return Object.freeze({
    source: "direct",
    window: value.window,
    remainingPercent: Object.is(value.remainingPercent, -0)
      ? 0
      : value.remainingPercent,
  });
}

function closedOutput(state, allowance = null, notificationEvidence = null) {
  if (!STATUS_SET.has(state)) throw new TypeError("desktop shell state is invalid");
  if (state !== "fresh") {
    allowance = null;
    notificationEvidence = null;
  } else {
    allowance = cloneAllowance(allowance);
  }
  return Object.freeze({
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state,
    allowance,
    notificationEvidence,
  });
}

function safeRefreshState(refresh) {
  if (!isPlainRecord(refresh) || typeof refresh.status !== "string") return null;
  return REFRESH_STATES.has(refresh.status) ? refresh.status : null;
}

/**
 * Project the companion lifecycle and latest closed refresh receipt.
 *
 * The input is intentionally limited to `snapshotStatus`, `refresh`, and a
 * testable clock.  A refresh ID, progress payload, error code, or arbitrary
 * dashboard value is never read or copied into the result.
 */
export function projectDesktopShellStatus({
  snapshotStatus = "ready",
  refresh = null,
  now = Date.now(),
} = {}) {
  if (!["building", "ready", "failed"].includes(snapshotStatus)) {
    return closedOutput("unavailable");
  }
  if (snapshotStatus === "building") return closedOutput("starting");
  if (snapshotStatus === "failed") return closedOutput("unavailable");

  const refreshStatus = safeRefreshState(refresh);
  if (refreshStatus === "running" || refreshStatus === "cancelling") {
    return closedOutput("analyzing");
  }
  if (refreshStatus !== "succeeded") {
    return closedOutput(
      refreshStatus === "cancelled" ? "stale" : "unavailable",
    );
  }

  const evidence = projectDesktopShellNotificationEvidence(
    refresh.result?.notificationEvidence,
    { now },
  );
  if (evidence === null) return closedOutput("stale");
  return closedOutput("fresh", primaryAllowance(evidence), evidence);
}

export function validateDesktopShellStatus(value) {
  if (!hasExactKeys(value, [
    "allowance",
    "notificationEvidence",
    "schemaVersion",
    "state",
  ])
      || value.schemaVersion !== DESKTOP_SHELL_STATUS_SCHEMA_VERSION
      || !STATUS_SET.has(value.state)) {
    throw new TypeError("desktop shell status is invalid");
  }
  const evidence = value.state === "fresh"
    ? projectDesktopShellNotificationEvidence(
      value.notificationEvidence,
      { now: Date.parse(value.notificationEvidence?.observedAt) },
    )
    : null;
  if (value.state === "fresh" && evidence === null) {
    throw new TypeError("desktop shell status is invalid");
  }
  if (value.state !== "fresh"
      && (value.allowance !== null || value.notificationEvidence !== null)) {
    throw new TypeError("desktop shell status is invalid");
  }
  return closedOutput(
    value.state,
    value.state === "fresh" ? value.allowance : null,
    evidence,
  );
}
