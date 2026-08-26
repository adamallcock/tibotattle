/**
 * Pure, content-free status projection for the Electron tray.
 *
 * The native menu-bar implementation deliberately separates lifecycle phase
 * from evidence freshness.  This smaller cross-platform contract exposes the
 * five user-visible states the tray may claim and carries only the companion's
 * closed, direct allowance windows when it has supplied fresh, validated
 * evidence. It does not read the filesystem, inspect a renderer,
 * preserve raw errors, or infer a value from stale data.
 */

import { projectDesktopShellNotificationEvidence } from "../../src/desktop-shell-status.js";

export const DESKTOP_TRAY_STATUS_STATES = Object.freeze([
  "starting",
  "analyzing",
  "fresh",
  "stale",
  "unavailable",
]);

export const DESKTOP_TRAY_ALLOWANCE_WINDOWS = Object.freeze([
  "five_hour",
  "seven_day",
]);

export const DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES = 256;

export const DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS = Object.freeze({
  starting: "electron.tray.statusStarting",
  analyzing: "electron.tray.statusAnalyzing",
  fresh: "electron.tray.statusFresh",
  stale: "electron.tray.statusStale",
  unavailable: "electron.tray.statusUnavailable",
});

export const DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS = Object.freeze({
  five_hour: "electron.tray.allowanceFiveHour",
  seven_day: "electron.tray.allowanceSevenDay",
});

const STATUS_SET = new Set(DESKTOP_TRAY_STATUS_STATES);
const ALLOWANCE_WINDOW_SET = new Set(DESKTOP_TRAY_ALLOWANCE_WINDOWS);
const INITIAL_STATUS = Object.freeze({
  status: "starting",
  allowance: null,
  notificationEvidence: null,
});

const DEFAULT_STATUS_LABELS = Object.freeze({
  starting: "Starting",
  analyzing: "Analyzing",
  fresh: "Fresh",
  stale: "Stale",
  unavailable: "Status unavailable",
});

const DEFAULT_ALLOWANCE_LABELS = Object.freeze({
  five_hour: "Five-hour allowance",
  seven_day: "Seven-day allowance",
});

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertPlainRecord(value, label) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertStatus(value) {
  if (typeof value !== "string" || !STATUS_SET.has(value)) {
    throw new TypeError("tray status is invalid");
  }
  return value;
}

function assertBoundedText(value, label) {
  if (typeof value !== "string"
      || value.length === 0
      || new TextEncoder().encode(value).byteLength
        > DESKTOP_TRAY_STATUS_MAX_LABEL_BYTES) {
    throw new TypeError(`${label} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new TypeError(`${label} is invalid`);
    }
  }
  return value;
}

function cloneAllowance(allowance, { allowNull = true } = {}) {
  if (allowance === null) {
    if (allowNull) return null;
    throw new TypeError("allowance is required");
  }
  assertPlainRecord(allowance, "allowance");
  if (!hasExactKeys(allowance, ["source", "window", "remainingPercent"])) {
    throw new TypeError("allowance has unexpected fields");
  }
  if (allowance.source !== "direct") {
    throw new TypeError("allowance source is invalid");
  }
  if (typeof allowance.window !== "string"
      || !ALLOWANCE_WINDOW_SET.has(allowance.window)) {
    throw new TypeError("allowance window is invalid");
  }
  if (typeof allowance.remainingPercent !== "number"
      || !Number.isFinite(allowance.remainingPercent)
      || allowance.remainingPercent < 0
      || allowance.remainingPercent > 100) {
    throw new TypeError("allowance remainingPercent is invalid");
  }
  return Object.freeze({
    source: "direct",
    window: allowance.window,
    remainingPercent: allowance.remainingPercent,
  });
}

function cloneNotificationEvidence(value, { allowNull = true } = {}) {
  if (value === null) {
    if (allowNull) return null;
    throw new TypeError("notification evidence is required");
  }
  const observedAt = Date.parse(value?.observedAt);
  const projected = projectDesktopShellNotificationEvidence(value, {
    now: observedAt,
  });
  if (projected === null) {
    throw new TypeError("notification evidence lanes are invalid");
  }
  return projected;
}

function statusSnapshot(status, allowance = null, notificationEvidence = null) {
  assertStatus(status);
  if (status !== "fresh" && (allowance !== null || notificationEvidence !== null)) {
    throw new TypeError("only fresh status may carry evidence");
  }
  return Object.freeze({
    status,
    allowance: cloneAllowance(allowance),
    notificationEvidence: cloneNotificationEvidence(notificationEvidence),
  });
}

/**
 * Validate and freeze the reducer state.  Stale, unavailable, analyzing, and
 * starting states intentionally have no allowance field beyond `null`.
 */
export function validateDesktopTrayStatus(value) {
  assertPlainRecord(value, "tray status");
  if (!hasExactKeys(value, ["status", "allowance", "notificationEvidence"])) {
    throw new TypeError("tray status has unexpected fields");
  }
  return statusSnapshot(value.status, value.allowance, value.notificationEvidence);
}

/**
 * Validate a fixed direct allowance summary independently of lifecycle state.
 * This is useful at the companion adapter boundary before emitting a `fresh`
 * event; the reducer still validates it again.
 */
export function validateDesktopTrayAllowance(value) {
  return cloneAllowance(value, { allowNull: false });
}

/**
 * Reduce one bounded lifecycle/evidence event into the next tray state.
 *
 * Events use the same closed vocabulary as the output status. A `fresh`
 * event carries the already-validated notification evidence alongside its
 * optional primary summary. All other events reject evidence and error
 * payloads and clear every previously displayed numeric claim.
 */
export function reduceDesktopTrayStatus(current, event) {
  const previous = validateDesktopTrayStatus(current);
  assertPlainRecord(event, "tray event");
  if (typeof event.type !== "string") {
    throw new TypeError("tray event type is invalid");
  }
  switch (event.type) {
    case "starting":
    case "analyzing":
    case "stale":
    case "unavailable":
      if (!hasExactKeys(event, ["type"])) {
        throw new TypeError("tray event has unexpected fields");
      }
      return statusSnapshot(event.type);
    case "fresh":
      if (!hasExactKeys(event, ["type", "allowance", "notificationEvidence"])) {
        throw new TypeError("fresh tray event has unexpected fields");
      }
      return statusSnapshot("fresh", event.allowance, event.notificationEvidence);
    default:
      // Keep `previous` referenced so a debugger can inspect the validated
      // boundary without changing the fail-closed behavior.
      void previous;
      throw new TypeError("tray event type is invalid");
  }
}

function defaultLocalize(key, values = {}) {
  const status = Object.entries(DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS)
    .find(([, candidate]) => candidate === key)?.[0];
  if (status !== undefined) {
    return DEFAULT_STATUS_LABELS[status];
  }
  const window = Object.entries(DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS)
    .find(([, candidate]) => candidate === key)?.[0];
  if (window !== undefined) {
    const percent = values.remainingPercent;
    return `${DEFAULT_ALLOWANCE_LABELS[window]}: ${percent}% remaining`;
  }
  if (key === "electron.tray.evidenceCurrent") {
    return `Observed ${values.age} · verified current evidence`;
  }
  if (key === "electron.tray.windowFiveHour") {
    return `Five-hour allowance: ${values.remainingPercent}% remaining · resets in ${values.reset}`;
  }
  if (key === "electron.tray.windowSevenDay") {
    return `Seven-day allowance: ${values.elapsedPercent}% elapsed · ${values.usedPercent}% used · resets in ${values.reset}`;
  }
  throw new TypeError("tray localization key is invalid");
}

function localizeText(localize, key, values, label) {
  let text;
  try {
    text = localize(key, Object.freeze({ ...values }));
  } catch {
    throw new TypeError(`${label} is unavailable`);
  }
  return assertBoundedText(text, label);
}

/**
 * Project semantic state into fixed tray copy.  `localize` is the only copy
 * seam: it receives a reviewed key and a bounded numeric value, never a raw
 * companion payload.  The default keeps the pure module usable in tests and
 * before Electron's desktop catalog is wired in.
 */
export function projectDesktopTrayStatus(value, options = {}) {
  assertPlainRecord(options, "projector options");
  if (Reflect.ownKeys(options).some((key) => !["localize", "now"].includes(key))) {
    throw new TypeError("projector options have unexpected fields");
  }
  const { localize = defaultLocalize, now = Date.now() } = options;
  const status = validateDesktopTrayStatus(value);
  if (typeof localize !== "function") {
    throw new TypeError("localize must be a function");
  }

  const statusLabel = localizeText(
    localize,
    DESKTOP_TRAY_STATUS_LOCALIZATION_KEYS[status.status],
    {},
    "status label",
  );
  let allowance = null;
  if (status.allowance !== null) {
    const roundedRemainingPercent = Math.round(status.allowance.remainingPercent);
    allowance = Object.freeze({
      window: status.allowance.window,
      remainingPercent: roundedRemainingPercent,
      label: localizeText(
        localize,
        DESKTOP_TRAY_ALLOWANCE_LOCALIZATION_KEYS[status.allowance.window],
        { remainingPercent: roundedRemainingPercent },
        "allowance label",
      ),
    });
  }
  const evidence = status.notificationEvidence;
  const windows = evidence === null ? [] : evidence.windows.map((window) => {
    const remainingPercent = Math.round(100 - window.usedPercent);
    const resetMs = Math.max(0, Date.parse(window.resetAt) - now);
    const resetMinutes = Math.ceil(resetMs / 60_000);
    const resetText = resetMinutes >= 1_440
      ? `${Math.floor(resetMinutes / 1_440)}d ${Math.floor((resetMinutes % 1_440) / 60)}h`
      : resetMinutes >= 60
        ? `${Math.floor(resetMinutes / 60)}h ${resetMinutes % 60}m`
        : `${resetMinutes}m`;
    const isWeekly = window.durationMinutes === 10_080;
    const elapsedPercent = Math.max(0, Math.min(100, Math.round(
      ((now - (Date.parse(window.resetAt) - window.durationMinutes * 60_000))
        / (window.durationMinutes * 60_000)) * 100,
    )));
    const label = localizeText(
      localize,
      isWeekly ? "electron.tray.windowSevenDay" : "electron.tray.windowFiveHour",
      isWeekly
        ? { elapsedPercent, usedPercent: Math.round(window.usedPercent), reset: resetText }
        : { remainingPercent, reset: resetText },
      "quota window label",
    );
    return Object.freeze({ ...window, remainingPercent, label });
  });
  const primary = windows.find(({ lane }) => lane === "primary") ?? windows[0] ?? null;
  const observedMinutes = evidence === null
    ? null
    : Math.max(0, Math.floor((now - Date.parse(evidence.observedAt)) / 60_000));
  return Object.freeze({
    status: status.status,
    label: statusLabel,
    allowance,
    compactTitle: primary === null ? (status.status === "analyzing" ? "…" : "–") : `${primary.remainingPercent}%`,
    evidenceLabel: evidence === null ? statusLabel : localizeText(
      localize,
      "electron.tray.evidenceCurrent",
      { age: observedMinutes === 0 ? "just now" : `${observedMinutes} minute${observedMinutes === 1 ? "" : "s"} ago` },
      "evidence label",
    ),
    windows: Object.freeze(windows),
  });
}

/**
 * Stateful convenience wrapper around the pure reducer.  The returned object
 * has no method that accepts raw labels, paths, or arbitrary errors.
 */
export function createDesktopTrayStatusReducer() {
  let current = INITIAL_STATUS;
  return Object.freeze({
    dispatch(event) {
      current = reduceDesktopTrayStatus(current, event);
      return current;
    },
    project(options = {}) {
      return projectDesktopTrayStatus(current, options);
    },
    reset() {
      current = INITIAL_STATUS;
      return current;
    },
    get state() {
      return current;
    },
  });
}

export { INITIAL_STATUS as DESKTOP_TRAY_INITIAL_STATUS };
