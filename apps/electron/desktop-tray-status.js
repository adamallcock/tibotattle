/**
 * Pure, content-free status projection for the Electron tray.
 *
 * The native menu-bar implementation deliberately separates lifecycle phase
 * from evidence freshness.  This smaller cross-platform contract exposes the
 * five user-visible states the tray may claim and carries one primary
 * allowance summary only when the companion has supplied fresh, direct,
 * validated evidence.  It does not read the filesystem, inspect a renderer,
 * preserve raw errors, or infer a value from stale data.
 */

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

function statusSnapshot(status, allowance = null) {
  assertStatus(status);
  if (status !== "fresh" && allowance !== null) {
    throw new TypeError("only fresh status may carry allowance evidence");
  }
  return Object.freeze({
    status,
    allowance: cloneAllowance(allowance),
  });
}

/**
 * Validate and freeze the reducer state.  Stale, unavailable, analyzing, and
 * starting states intentionally have no allowance field beyond `null`.
 */
export function validateDesktopTrayStatus(value) {
  assertPlainRecord(value, "tray status");
  if (!hasExactKeys(value, ["status", "allowance"])) {
    throw new TypeError("tray status has unexpected fields");
  }
  return statusSnapshot(value.status, value.allowance);
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
 * Events use the same closed vocabulary as the output status.  A `fresh`
 * event may carry `allowance: null` when the companion is current but has no
 * eligible primary allowance window.  All other events reject any allowance
 * or error payload and clear a previously displayed summary.
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
      if (!hasExactKeys(event, ["type", "allowance"])) {
        throw new TypeError("fresh tray event has unexpected fields");
      }
      return statusSnapshot("fresh", event.allowance);
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
  if (Reflect.ownKeys(options).some((key) => key !== "localize")) {
    throw new TypeError("projector options have unexpected fields");
  }
  const { localize = defaultLocalize } = options;
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
  return Object.freeze({
    status: status.status,
    label: statusLabel,
    allowance,
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
