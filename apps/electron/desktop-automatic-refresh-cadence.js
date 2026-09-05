import { randomUUID } from "node:crypto";

import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
} from "./desktop-settings-backends.js";

export const DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION =
  "tibotattle-electron-automatic-refresh-cadence-v1";
export const DESKTOP_AUTOMATIC_REFRESH_CADENCE_FILE_NAME =
  "automatic-refresh-cadence-v1.json";
export const DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS = 60 * 60_000;

const MAXIMUM_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function validTimestamp(value, { nullable = false } = {}) {
  return (nullable && value === null)
    || (Number.isSafeInteger(value) && value >= 0);
}

function validToken(value, { nullable = false } = {}) {
  return (nullable && value === null)
    || (typeof value === "string" && UUID_PATTERN.test(value));
}

function validateCadenceState(value) {
  if (!hasExactKeys(value, [
    "schemaVersion",
    "lastAutomaticDetailedAtMs",
    "reservationToken",
  ])
      || value.schemaVersion !== DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION
      || !validTimestamp(value.lastAutomaticDetailedAtMs, { nullable: true })
      || !validToken(value.reservationToken, { nullable: true })
      // A token only exists for a stamped reservation.  Rejecting this
      // impossible pair keeps a damaged record from looking like a valid
      // reservation after a process restart.
      || (value.lastAutomaticDetailedAtMs === null
        && value.reservationToken !== null)) {
    throw new TypeError("automatic refresh cadence state is invalid");
  }
  return Object.freeze({
    schemaVersion: DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION,
    lastAutomaticDetailedAtMs: value.lastAutomaticDetailedAtMs,
    reservationToken: value.reservationToken,
  });
}

function createCadenceState(lastAutomaticDetailedAtMs, reservationToken = null) {
  return validateCadenceState({
    schemaVersion: DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION,
    lastAutomaticDetailedAtMs,
    reservationToken,
  });
}

/**
 * Codec for the dedicated cadence child of the protected desktop settings
 * store. It has an exact shape so the ordinary settings record can never be
 * decoded as cadence state by accident.
 */
export const DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC = Object.freeze({
  encode(value, maximumBytes) {
    const validated = validateCadenceState(value);
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (maximumBytes !== undefined
        && (!Number.isSafeInteger(maximumBytes)
          || maximumBytes < 1
          || bytes.byteLength > maximumBytes)) {
      throw new TypeError("automatic refresh cadence state is too large");
    }
    return Object.freeze({ value: validated, bytes });
  },

  decodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("automatic refresh cadence bytes are invalid");
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TypeError("automatic refresh cadence bytes are invalid");
    }
    return validateCadenceState(value);
  },

  decodeValue(value) {
    return validateCadenceState(value);
  },
});

function assertOptions(options) {
  if (!isPlainRecord(options)) {
    throw new TypeError("automatic refresh cadence options must be an object");
  }
  const allowed = ["backend", "clock", "intervalMs", "tokenFactory"];
  if (Reflect.ownKeys(options).some((key) => !allowed.includes(key))) {
    throw new TypeError("automatic refresh cadence options have unexpected fields");
  }
  if (!isPlainRecord(options.backend)
      || typeof options.backend.load !== "function"
      || typeof options.backend.save !== "function") {
    throw new TypeError("automatic refresh cadence backend is required");
  }
  const clock = options.clock ?? (() => Date.now());
  if (typeof clock !== "function") throw new TypeError("automatic refresh cadence clock is invalid");
  const intervalMs = options.intervalMs ?? DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError("automatic refresh cadence interval is invalid");
  }
  const tokenFactory = options.tokenFactory ?? randomUUID;
  if (typeof tokenFactory !== "function") {
    throw new TypeError("automatic refresh cadence token factory is invalid");
  }
  return Object.freeze({
    backend: options.backend,
    clock,
    intervalMs,
    tokenFactory,
  });
}

function readClock(clock, lastObservedClockMs) {
  let candidate;
  try {
    candidate = clock();
  } catch {
    return { value: null, lastObservedClockMs };
  }
  if (!validTimestamp(candidate)) {
    return { value: null, lastObservedClockMs };
  }
  if (lastObservedClockMs !== null && candidate < lastObservedClockMs) {
    // A wall-clock rollback must never unlock a second detailed attempt in
    // this process. Keep the logical clock monotonic until it catches up.
    return { value: lastObservedClockMs, lastObservedClockMs };
  }
  return { value: candidate, lastObservedClockMs: candidate };
}

function reservationInput(value) {
  if (!hasExactKeys(value, [
    "stampedAtMs",
    "token",
    "previousAttemptAtMs",
    "previousToken",
  ])
      || !validTimestamp(value.stampedAtMs)
      || !validToken(value.token)
      || !validTimestamp(value.previousAttemptAtMs, { nullable: true })
      || !validToken(value.previousToken, { nullable: true })) {
    return null;
  }
  return Object.freeze({
    stampedAtMs: value.stampedAtMs,
    token: value.token,
    previousAttemptAtMs: value.previousAttemptAtMs,
    previousToken: value.previousToken,
  });
}

/**
 * Create the durable hourly automatic-refresh cadence coordinator.
 *
 * The backend is intentionally injected so the Electron runtime can select
 * its existing POSIX or Windows protected settings implementation. Manual
 * refreshes never call this coordinator. Automatic callers first ask for a
 * mode, then persist a reservation immediately before delivering a detailed
 * command; a confirmed quick join can restore the prior timestamp safely.
 */
export function createDesktopAutomaticRefreshCadence(options = {}) {
  const configuration = assertOptions(options);
  const {
    backend,
    clock,
    intervalMs,
    tokenFactory,
  } = configuration;
  let loaded = false;
  let state = null;
  let loadStatus = "uninitialized";
  let lastObservedClockMs = null;
  let operation = Promise.resolve();

  function enqueue(run) {
    const previous = operation;
    const current = previous.catch(() => {}).then(run);
    operation = current.catch(() => {});
    return current;
  }

  async function initializeInternal() {
    if (loaded) return loadStatus;
    let persisted;
    try {
      persisted = await backend.load();
    } catch {
      loaded = true;
      state = null;
      loadStatus = "unavailable";
      return loadStatus;
    }
    loaded = true;
    if (persisted === null || persisted === undefined) {
      state = null;
      loadStatus = "missing";
      return loadStatus;
    }
    try {
      state = validateCadenceState(persisted);
      loadStatus = "ready";
    } catch {
      state = null;
      loadStatus = "invalid";
    }
    return loadStatus;
  }

  function initialize() {
    return enqueue(() => initializeInternal());
  }

  async function saveState(next) {
    try {
      await backend.save(next);
    } catch {
      return false;
    }
    state = next;
    loadStatus = "ready";
    return true;
  }

  async function automaticModeInternal() {
    await initializeInternal();
    const { value: now, lastObservedClockMs: observed } = readClock(
      clock,
      lastObservedClockMs,
    );
    lastObservedClockMs = observed;
    if (now === null || loadStatus === "unavailable") return "quick";

    const last = state?.lastAutomaticDetailedAtMs ?? null;
    if (loadStatus !== "ready" || !validTimestamp(last, { nullable: true })) {
      // Missing, malformed, or unrecoverable state receives one conservative
      // quick-first seed. A failed write leaves the state unavailable and
      // therefore cannot unlock a detailed attempt.
      await saveState(createCadenceState(now));
      return "quick";
    }
    if (last === null) {
      await saveState(createCadenceState(now));
      return "quick";
    }
    if (last > now) {
      // Match the native shell's future-timestamp recovery: reseed at the
      // current valid wall-clock value and require a fresh hourly interval.
      await saveState(createCadenceState(now));
      return "quick";
    }
    return now - last >= intervalMs ? "detailed" : "quick";
  }

  function automaticMode() {
    return enqueue(() => automaticModeInternal());
  }

  async function recordDetailedAttemptInternal() {
    await initializeInternal();
    if (loadStatus !== "ready" || state === null) return null;
    const { value: now, lastObservedClockMs: observed } = readClock(
      clock,
      lastObservedClockMs,
    );
    lastObservedClockMs = observed;
    const previousAttemptAtMs = state.lastAutomaticDetailedAtMs;
    if (now === null
        || previousAttemptAtMs === null
        || now < previousAttemptAtMs
        || now - previousAttemptAtMs < intervalMs) {
      return null;
    }
    let token;
    try {
      token = tokenFactory();
    } catch {
      return null;
    }
    if (!validToken(token)) return null;
    const previousToken = state.reservationToken;
    const next = createCadenceState(now, token);
    if (!await saveState(next)) return null;
    return Object.freeze({
      stampedAtMs: now,
      token,
      previousAttemptAtMs,
      previousToken,
    });
  }

  function recordDetailedAttempt() {
    return enqueue(() => recordDetailedAttemptInternal());
  }

  async function restoreAfterQuickJoinInternal(reservation, attempt) {
    await initializeInternal();
    const selected = reservationInput(reservation);
    if (selected === null || attempt?.mode !== "quick"
        || loadStatus !== "ready" || state === null
        || state.lastAutomaticDetailedAtMs !== selected.stampedAtMs
        || state.reservationToken !== selected.token) {
      return false;
    }
    const restored = createCadenceState(
      selected.previousAttemptAtMs,
      selected.previousToken,
    );
    return saveState(restored);
  }

  function restoreAfterQuickJoin(reservation, attempt) {
    return enqueue(() => restoreAfterQuickJoinInternal(reservation, attempt));
  }

  return Object.freeze({
    initialize,
    automaticMode,
    recordDetailedAttempt,
    restoreAfterQuickJoin,
  });
}

/**
 * Select the existing protected settings backend for the cadence child.
 * Windows deliberately has no ordinary filesystem fallback.
 */
export function createDesktopAutomaticRefreshCadenceBackend({
  platform = process.platform,
  rootPath,
  windowsProtectedStateStore,
} = {}) {
  const options = {
    platform,
    rootPath,
    maximumBytes: MAXIMUM_BYTES,
    codec: DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC,
  };
  return platform === "win32"
    ? createWindowsDesktopSettingsBackend({
      ...options,
      childName: DESKTOP_AUTOMATIC_REFRESH_CADENCE_FILE_NAME,
      windowsProtectedStateStore,
    })
    : createPosixDesktopSettingsBackend({
      ...options,
      filename: DESKTOP_AUTOMATIC_REFRESH_CADENCE_FILE_NAME,
    });
}
