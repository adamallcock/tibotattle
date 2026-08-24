/**
 * Pure, fail-closed quota notification policy for the Electron shell.
 *
 * This module deliberately stops at the policy boundary.  It does not read
 * the filesystem, call Electron, ask for notification permission, schedule a
 * task, or deliver an operating-system notification.  A future adapter may
 * persist the validated state and turn the one semantic `notification` result
 * into a platform-local notification.
 *
 * The input contract mirrors the native shell's fresh-provider boundary:
 * only a terminal, direct app-server observation may be compared.  Dashboard
 * summaries, logs, inferred values, paths, account identifiers, and raw
 * errors are not accepted by this module.
 */

export const DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION =
  "tibotattle-electron-notification-policy-v1";

export const DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION =
  "tibotattle-notification-evidence-v2";

export const DESKTOP_NOTIFICATION_THRESHOLD_MODES = Object.freeze([
  "off",
  "ninety",
  "eightyAndNinety",
]);

export const DESKTOP_NOTIFICATION_KEYS = Object.freeze({
  RESET: "quota.reset",
  THRESHOLD: "quota.threshold",
});

export const DESKTOP_NOTIFICATION_OUTCOMES = Object.freeze([
  "disabled",
  "ineligible",
  "first_observation",
  "no_crossing",
  "notification",
]);

export const DESKTOP_NOTIFICATION_REASONS = Object.freeze([
  "disabled",
  "fresh",
  "stale",
  "inferred",
  "mixed_source",
  "malformed",
  "nonfinite",
  "invalid_identity",
  "path_present",
  "raw_error",
  "extra_field",
  "schema_changed",
  "unobserved",
  "out_of_order",
  "malformed_state",
]);

export const DESKTOP_NOTIFICATION_MAX_BASELINES = 256;
export const DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS = 512;
export const DESKTOP_NOTIFICATION_MAX_HANDLED_KEY_BYTES = 512;
export const DESKTOP_NOTIFICATION_MAX_STATE_BYTES = 128 * 1024;
export const DESKTOP_NOTIFICATION_MAX_IDENTITY_BYTES = 128;
export const DESKTOP_NOTIFICATION_MAX_CONTINUITY_KEY_BYTES = 43;
export const DESKTOP_NOTIFICATION_MAX_DURATION_MINUTES = 525_600;

const THRESHOLDS_BY_MODE = Object.freeze({
  off: Object.freeze([]),
  ninety: Object.freeze([90]),
  eightyAndNinety: Object.freeze([80, 90]),
});

const THRESHOLD_MODE_SET = new Set(DESKTOP_NOTIFICATION_THRESHOLD_MODES);
const OUTCOME_SET = new Set(DESKTOP_NOTIFICATION_OUTCOMES);
const REASON_SET = new Set(DESKTOP_NOTIFICATION_REASONS);
const WINDOWS = new Set(["primary", "secondary"]);
const PROOF_KINDS = new Set([
  "provider_reported_schedule_only",
  "provider_reported_identity",
]);
const BASE_WINDOW_KEYS = Object.freeze([
  "durationMinutes",
  "lane",
  "resetAt",
  "resetProofKind",
  "usedPercent",
]);
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
const STATE_KEYS = Object.freeze([
  "baselines",
  "handledKeys",
  "preferences",
  "schemaVersion",
]);
const PREFERENCES_KEYS = Object.freeze([
  "enabled",
  "resetEnabled",
  "thresholdMode",
]);
const BASELINE_KEYS = Object.freeze([
  "observedAt",
  "resetAt",
  "resetIdentity",
  "usedPercent",
]);

const INPUT_ERROR = Symbol("desktop-notification-policy-input-error");

class DesktopNotificationPolicyInputError extends TypeError {
  constructor(message, reason = "malformed") {
    super(message);
    this[INPUT_ERROR] = true;
    this.reason = reason;
  }
}

function inputError(message, reason = "malformed") {
  return new DesktopNotificationPolicyInputError(message, reason);
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainRecord(value, label, reason = "malformed") {
  if (!isPlainRecord(value)) {
    throw inputError(`${label} must be a plain object`, reason);
  }
  return value;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value, keys, label, reason = "extra_field") {
  if (!hasExactKeys(value, keys)) {
    const actual = Reflect.ownKeys(value);
    const extra = actual.some((key) => !keys.includes(key));
    if (extra) {
      const stringKeys = actual.filter((key) => typeof key === "string");
      if (stringKeys.some((key) => key === "path" || key.endsWith("Path"))) {
        throw inputError(`${label} contains a path`, "path_present");
      }
      if (stringKeys.some((key) => key === "rawError" || key === "error")) {
        throw inputError(`${label} contains an error`, "raw_error");
      }
      if (stringKeys.some((key) => key === "identity" || key === "accountId")) {
        throw inputError(`${label} contains an identity`, "invalid_identity");
      }
      throw inputError(`${label} has unexpected fields`, reason);
    }
    throw inputError(`${label} is missing fields`, "malformed");
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw inputError(`${label} must be boolean`);
  }
  return value;
}

function assertString(value, label, reason = "malformed") {
  if (typeof value !== "string") {
    throw inputError(`${label} must be a string`, reason);
  }
  return value;
}

function canonicalDate(value, label = "date") {
  assertString(value, label);
  // Keep the boundary narrower than Date.parse.  This is the same
  // millisecond UTC representation used by the native implementation and
  // prevents alternate spellings from becoming distinct dedupe keys.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw inputError(`${label} is not canonical`, "malformed");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw inputError(`${label} is not canonical`, "malformed");
  }
  return value;
}

function validContinuityKey(value) {
  return typeof value === "string"
    && new TextEncoder().encode(value).byteLength
      === DESKTOP_NOTIFICATION_MAX_CONTINUITY_KEY_BYTES
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertContinuityKey(value) {
  if (!validContinuityKey(value)) {
    throw inputError("continuity key is invalid", "invalid_identity");
  }
  return value;
}

function validResetIdentity(value) {
  return typeof value === "string"
    && new TextEncoder().encode(value).byteLength >= 1
    && new TextEncoder().encode(value).byteLength
      <= DESKTOP_NOTIFICATION_MAX_IDENTITY_BYTES
    && /^[A-Za-z0-9._-]+$/.test(value);
}

function assertResetIdentity(value) {
  if (!validResetIdentity(value)) {
    throw inputError("provider reset identity is invalid", "invalid_identity");
  }
  return value;
}

function validDuration(value) {
  return Number.isInteger(value)
    && value >= 1
    && value <= DESKTOP_NOTIFICATION_MAX_DURATION_MINUTES;
}

function assertDuration(value) {
  if (!validDuration(value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw inputError("duration is nonfinite", "nonfinite");
    }
    throw inputError("duration is invalid", "malformed");
  }
  return value;
}

function assertUsedPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw inputError("used percent is nonfinite", "nonfinite");
  }
  if (value < 0 || value > 100) {
    throw inputError("used percent is out of range", "malformed");
  }
  // JSON has no negative-zero spelling; normalize it before state or
  // evidence reaches the deterministic serializer/comparator.
  return Object.is(value, -0) ? 0 : value;
}

function assertThresholdMode(value) {
  if (typeof value !== "string" || !THRESHOLD_MODE_SET.has(value)) {
    throw inputError("threshold mode is invalid", "malformed");
  }
  return value;
}

function laneKey(continuityKey, lane, durationMinutes) {
  return `${continuityKey}|${lane}|${durationMinutes}`;
}

function parseLaneKey(value) {
  if (typeof value !== "string") {
    throw inputError("baseline key is invalid", "malformed");
  }
  const pieces = value.split("|");
  if (pieces.length !== 3
      || !validContinuityKey(pieces[0])
      || !WINDOWS.has(pieces[1])
      || !validDuration(Number(pieces[2]))
      || String(Number(pieces[2])) !== pieces[2]) {
    throw inputError("baseline key is invalid", "invalid_identity");
  }
  return Object.freeze({
    continuityKey: pieces[0],
    lane: pieces[1],
    durationMinutes: Number(pieces[2]),
  });
}

function parseHandledKey(value) {
  assertString(value, "handled key");
  if (new TextEncoder().encode(value).byteLength
      > DESKTOP_NOTIFICATION_MAX_HANDLED_KEY_BYTES) {
    throw inputError("handled key is too large", "malformed_state");
  }
  const pieces = value.split("|");
  const kind = pieces[0];
  if (kind === "threshold") {
    if (pieces.length !== 6) {
      throw inputError("threshold handled key is invalid", "malformed");
    }
    parseLaneKey(pieces.slice(1, 4).join("|"));
    canonicalDate(pieces[4], "handled key reset date");
    if (!Number.isInteger(Number(pieces[5]))
        || ![80, 90].includes(Number(pieces[5]))
        || String(Number(pieces[5])) !== pieces[5]) {
      throw inputError("threshold handled key is invalid", "malformed");
    }
    return Object.freeze({ kind, laneKey: pieces.slice(1, 4).join("|"), resetAt: pieces[4], threshold: Number(pieces[5]) });
  }
  if (kind === "reset") {
    if (pieces.length !== 5 && pieces.length !== 6) {
      throw inputError("reset handled key is invalid", "malformed");
    }
    parseLaneKey(pieces.slice(1, 4).join("|"));
    canonicalDate(pieces[4], "handled key reset date");
    if (pieces.length === 6) assertResetIdentity(pieces[5]);
    return Object.freeze({
      kind,
      laneKey: pieces.slice(1, 4).join("|"),
      resetAt: pieces[4],
      resetIdentity: pieces.length === 6 ? pieces[5] : null,
    });
  }
  throw inputError("handled key kind is invalid", "malformed");
}

function freezeBaseline(value) {
  return Object.freeze({
    observedAt: value.observedAt,
    resetAt: value.resetAt,
    resetIdentity: value.resetIdentity,
    usedPercent: value.usedPercent,
  });
}

function freezePreferences(value) {
  return Object.freeze({
    enabled: value.enabled,
    resetEnabled: value.resetEnabled,
    thresholdMode: value.thresholdMode,
  });
}

function freezeState({ schemaVersion, preferences, baselines, handledKeys }) {
  const sortedBaselines = {};
  for (const key of Object.keys(baselines).sort()) {
    sortedBaselines[key] = freezeBaseline(baselines[key]);
  }
  return Object.freeze({
    schemaVersion,
    preferences: freezePreferences(preferences),
    baselines: Object.freeze(sortedBaselines),
    handledKeys: Object.freeze([...handledKeys].sort()),
  });
}

function cloneState(value) {
  return freezeState(value);
}

function invalidState(message) {
  throw inputError(message, "malformed_state");
}

/**
 * Validate and return a deeply frozen policy state.  The state intentionally
 * contains no pending OS request IDs: delivery and platform persistence are
 * separate integration seams.
 */
export function validateDesktopNotificationPolicyState(value) {
  if (!isPlainRecord(value)) invalidState("notification state must be an object");
  try {
    assertExactKeys(value, STATE_KEYS, "notification state", "malformed_state");
  } catch (error) {
    throw inputError("notification state has unexpected fields", "malformed_state");
  }
  if (value.schemaVersion !== DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION) {
    invalidState("notification state schema is unsupported");
  }
  assertPlainRecord(value.preferences, "notification preferences", "malformed_state");
  try {
    assertExactKeys(value.preferences, PREFERENCES_KEYS, "notification preferences", "malformed_state");
  } catch {
    invalidState("notification preferences fields are invalid");
  }
  const preferences = {
    enabled: assertBoolean(value.preferences.enabled, "enabled"),
    resetEnabled: assertBoolean(value.preferences.resetEnabled, "resetEnabled"),
    thresholdMode: assertThresholdMode(value.preferences.thresholdMode),
  };

  assertPlainRecord(value.baselines, "notification baselines", "malformed_state");
  const baselineKeys = Reflect.ownKeys(value.baselines);
  if (baselineKeys.length > DESKTOP_NOTIFICATION_MAX_BASELINES
      || baselineKeys.some((key) => typeof key !== "string")) {
    invalidState("notification baselines exceed their bound");
  }
  const baselines = {};
  for (const key of baselineKeys) {
    parseLaneKey(key);
    const baseline = value.baselines[key];
    assertPlainRecord(baseline, "notification baseline", "malformed_state");
    try {
      assertExactKeys(baseline, BASELINE_KEYS, "notification baseline", "malformed_state");
    } catch {
      invalidState("notification baseline fields are invalid");
    }
    const observedAt = canonicalDate(baseline.observedAt, "baseline observedAt");
    const resetAt = canonicalDate(baseline.resetAt, "baseline resetAt");
    if (new Date(resetAt).getTime() <= new Date(observedAt).getTime()) {
      invalidState("notification baseline resetAt must be in the future");
    }
    const usedPercent = assertUsedPercent(baseline.usedPercent);
    const resetIdentity = baseline.resetIdentity === null
      ? null
      : assertResetIdentity(baseline.resetIdentity);
    baselines[key] = { observedAt, resetAt, resetIdentity, usedPercent };
  }

  if (!Array.isArray(value.handledKeys)
      || value.handledKeys.length > DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS) {
    invalidState("notification handled keys exceed their bound");
  }
  const handledKeys = [];
  const seen = new Set();
  for (const key of value.handledKeys) {
    parseHandledKey(key);
    if (seen.has(key)) invalidState("notification handled keys are duplicated");
    seen.add(key);
    handledKeys.push(key);
  }
  return freezeState({
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences,
    baselines,
    handledKeys,
  });
}

/** Create a validated state for a fresh installation or an explicit opt-in. */
export function createDesktopNotificationPolicyState(options = {}) {
  assertPlainRecord(options, "notification state options");
  const allowed = ["enabled", "resetEnabled", "thresholdMode"];
  if (Reflect.ownKeys(options).some((key) => !allowed.includes(key))) {
    throw inputError("notification state options have unexpected fields");
  }
  return validateDesktopNotificationPolicyState({
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: {
      enabled: options.enabled ?? false,
      resetEnabled: options.resetEnabled ?? true,
      // Native opt-in selects both threshold alerts by default.  An explicit
      // `off` remains available for a user who enabled consent but has not
      // selected a threshold alert.
      thresholdMode: options.thresholdMode
        ?? (options.enabled === true ? "eightyAndNinety" : "off"),
    },
    baselines: {},
    handledKeys: [],
  });
}

/**
 * Serialize the validated state with stable key ordering and a bounded UTF-8
 * size.  Callers may write these bytes using their platform owner-only store.
 */
export function serializeDesktopNotificationPolicyState(value) {
  const state = validateDesktopNotificationPolicyState(value);
  const serialized = `${JSON.stringify(state)}\n`;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > DESKTOP_NOTIFICATION_MAX_STATE_BYTES) {
    throw inputError("notification state is too large", "malformed_state");
  }
  return serialized;
}

/** Parse and validate state bytes without accepting arbitrary JSON fields. */
export function deserializeDesktopNotificationPolicyState(serialized) {
  if (typeof serialized !== "string") {
    throw inputError("notification state bytes must be a string", "malformed_state");
  }
  if (new TextEncoder().encode(serialized).byteLength
      > DESKTOP_NOTIFICATION_MAX_STATE_BYTES) {
    throw inputError("notification state is too large", "malformed_state");
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw inputError("notification state JSON is invalid", "malformed_state");
  }
  return validateDesktopNotificationPolicyState(parsed);
}

function validatedWindow(rawWindow, observedAt) {
  assertPlainRecord(rawWindow, "notification window");
  assertString(rawWindow.resetProofKind, "resetProofKind");
  if (!PROOF_KINDS.has(rawWindow.resetProofKind)) {
    throw inputError("reset proof kind is invalid", "malformed");
  }
  const keys = rawWindow.resetProofKind === "provider_reported_identity"
    ? [...BASE_WINDOW_KEYS, "resetIdentity"]
    : [...BASE_WINDOW_KEYS];
  assertExactKeys(rawWindow, keys, "notification window");
  if (!WINDOWS.has(rawWindow.lane)) {
    throw inputError("notification lane is invalid", "malformed");
  }
  const durationMinutes = assertDuration(rawWindow.durationMinutes);
  const usedPercent = assertUsedPercent(rawWindow.usedPercent);
  const resetAt = canonicalDate(rawWindow.resetAt, "window resetAt");
  if (new Date(resetAt).getTime() <= new Date(observedAt).getTime()) {
    throw inputError("window resetAt must be after observedAt", "malformed");
  }
  const resetIdentity = rawWindow.resetProofKind === "provider_reported_identity"
    ? assertResetIdentity(rawWindow.resetIdentity)
    : null;
  return {
    lane: rawWindow.lane,
    durationMinutes,
    usedPercent,
    resetAt,
    resetProofKind: rawWindow.resetProofKind,
    resetIdentity,
  };
}

/** Validate the closed, direct-provider evidence contract. */
export function validateDesktopNotificationEvidence(value) {
  assertPlainRecord(value, "notification evidence");
  assertExactKeys(value, EVIDENCE_KEYS, "notification evidence");
  if (value.schemaVersion !== DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION) {
    throw inputError("notification evidence schema is unsupported", "schema_changed");
  }
  if (value.status !== "fresh_provider_observation") {
    const reason = value.status === "stale" ? "stale"
      : value.status === "inferred" ? "inferred"
        : value.status === "mixed" ? "mixed_source"
          : value.status === "unobserved" ? "unobserved"
            : "malformed";
    throw inputError("notification evidence status is ineligible", reason);
  }
  if (value.provider !== "openai_codex" || value.source !== "app_server_read") {
    throw inputError("notification evidence source is not direct", "mixed_source");
  }
  if (value.freshness !== "fresh") {
    const reason = value.freshness === "inferred" ? "inferred"
      : value.freshness === "mixed" ? "mixed_source" : "stale";
    throw inputError("notification evidence is not fresh", reason);
  }
  const observedAt = canonicalDate(value.observedAt, "evidence observedAt");
  const continuityKey = assertContinuityKey(value.continuityKey);
  if (!Array.isArray(value.windows) || value.windows.length < 1 || value.windows.length > 2) {
    throw inputError("notification evidence windows are invalid", "malformed");
  }
  const seenLanes = new Set();
  const windows = value.windows.map((rawWindow) => {
    const window = validatedWindow(rawWindow, observedAt);
    if (seenLanes.has(window.lane)) {
      throw inputError("notification evidence contains duplicate lanes", "malformed");
    }
    seenLanes.add(window.lane);
    return window;
  }).sort((left, right) => left.lane.localeCompare(right.lane));
  return Object.freeze({
    schemaVersion: DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey,
    windows: Object.freeze(windows.map((window) => Object.freeze(window))),
  });
}

function result(state, outcome, reason, notification = null) {
  if (!OUTCOME_SET.has(outcome) || !REASON_SET.has(reason)) {
    throw new Error("internal notification policy result is invalid");
  }
  if (notification !== null) {
    if (notification.key === DESKTOP_NOTIFICATION_KEYS.THRESHOLD) {
      if (!Number.isInteger(notification.thresholdPercent)
          || ![80, 90].includes(notification.thresholdPercent)) {
        throw new Error("internal threshold notification is invalid");
      }
      notification = Object.freeze({
        key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
        thresholdPercent: notification.thresholdPercent,
      });
    } else if (notification.key === DESKTOP_NOTIFICATION_KEYS.RESET) {
      notification = Object.freeze({ key: DESKTOP_NOTIFICATION_KEYS.RESET });
    } else {
      throw new Error("internal notification key is invalid");
    }
  }
  return Object.freeze({
    state: validateDesktopNotificationPolicyState(state),
    outcome,
    reason,
    notification,
  });
}

function clearBaselines(state) {
  return cloneState({
    schemaVersion: state.schemaVersion,
    preferences: state.preferences,
    baselines: {},
    handledKeys: state.handledKeys,
  });
}

function pruneHandledKeys(values) {
  return [...new Set(values)].sort().slice(-DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS);
}

function pruneBaselines(values) {
  const keys = Object.keys(values).sort().slice(-DESKTOP_NOTIFICATION_MAX_BASELINES);
  const result = {};
  for (const key of keys) result[key] = values[key];
  return result;
}

function eventKeyForThreshold(key, resetAt, threshold) {
  return `threshold|${key}|${resetAt}|${threshold}`;
}

function eventKeyForReset(key, resetAt, resetIdentity) {
  return resetIdentity === null
    ? `reset|${key}|${resetAt}`
    : `reset|${key}|${resetAt}|${resetIdentity}`;
}

function candidateSort(left, right) {
  if (left.kind !== right.kind) return left.kind === "reset" ? -1 : 1;
  if (left.kind === "threshold" && left.threshold !== right.threshold) {
    return right.threshold - left.threshold;
  }
  return left.eventKey.localeCompare(right.eventKey);
}

/**
 * Evaluate one accepted foreground refresh.  The caller supplies the
 * previous validated state and the terminal receipt's direct evidence.  An
 * ineligible or malformed evidence payload clears baselines (so no threshold
 * can be inferred across a gap) but preserves handled keys for dedupe.
 */
export function evaluateDesktopNotificationPolicy(stateValue, evidenceValue) {
  const state = validateDesktopNotificationPolicyState(stateValue);
  if (!state.preferences.enabled) {
    return result(state, "disabled", "disabled");
  }

  let evidence;
  try {
    evidence = validateDesktopNotificationEvidence(evidenceValue);
  } catch (error) {
    const reason = error?.[INPUT_ERROR] && REASON_SET.has(error.reason)
      ? error.reason
      : "malformed";
    return result(clearBaselines(state), "ineligible", reason);
  }

  const nextBaselines = { ...state.baselines };
  let workingHandledKeys = [...state.handledKeys];
  let sawFirstObservation = false;
  const candidates = [];
  const thresholds = THRESHOLDS_BY_MODE[state.preferences.thresholdMode];

  for (const window of evidence.windows) {
    const key = laneKey(evidence.continuityKey, window.lane, window.durationMinutes);
    const previous = nextBaselines[key];
    if (previous === undefined) {
      nextBaselines[key] = {
        observedAt: evidence.observedAt,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt,
        resetIdentity: window.resetIdentity,
      };
      sawFirstObservation = true;
      continue;
    }

    const currentObservedAt = new Date(evidence.observedAt).getTime();
    const previousObservedAt = new Date(previous.observedAt).getTime();
    // Duplicate, replayed, or reordered receipts never produce a new
    // comparison and never move the local baseline backwards.
    if (currentObservedAt <= previousObservedAt) continue;
    const resetIdentityChanged = previous.resetIdentity !== null
      && window.resetIdentity !== null
      && previous.resetIdentity !== window.resetIdentity;
    const scheduleChanged = window.resetAt !== previous.resetAt;
    const resetIsDue = currentObservedAt >= new Date(previous.resetAt).getTime();

    if (resetIdentityChanged) {
      nextBaselines[key] = {
        observedAt: evidence.observedAt,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt,
        resetIdentity: window.resetIdentity,
      };
      if (scheduleChanged) {
        const keep = eventKeyForReset(key, window.resetAt, window.resetIdentity);
        const retained = workingHandledKeys.filter((handledKey) =>
          !(handledKey.startsWith(`threshold|${key}|`)
            || handledKey.startsWith(`reset|${key}|`))
          || handledKey === keep);
        workingHandledKeys = retained;
      }
      if (state.preferences.resetEnabled) {
        const eventKey = eventKeyForReset(key, window.resetAt, window.resetIdentity);
        if (!workingHandledKeys.includes(eventKey)) {
          candidates.push({ kind: "reset", eventKey, threshold: null });
        }
      }
      continue;
    }

    if (resetIsDue) {
      const resetIdentity = window.resetIdentity ?? previous.resetIdentity;
      const eventKey = eventKeyForReset(key, previous.resetAt, resetIdentity);
      if (state.preferences.resetEnabled && !workingHandledKeys.includes(eventKey)) {
        candidates.push({ kind: "reset", eventKey, threshold: null });
      }
      nextBaselines[key] = {
        observedAt: evidence.observedAt,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt,
        resetIdentity: window.resetIdentity,
      };
      // A reset opens a new threshold epoch. Keep the reset event key being
      // consumed, and remove older events for this lane.
      const retained = workingHandledKeys.filter((handledKey) =>
        !(handledKey.startsWith(`threshold|${key}|`)
          || handledKey.startsWith(`reset|${key}|`))
        || handledKey === eventKey);
      workingHandledKeys = retained;
      continue;
    }

    if (scheduleChanged) {
      nextBaselines[key] = {
        observedAt: evidence.observedAt,
        usedPercent: window.usedPercent,
        resetAt: window.resetAt,
        resetIdentity: window.resetIdentity,
      };
      const retained = workingHandledKeys.filter((handledKey) =>
        !(handledKey.startsWith(`threshold|${key}|`)
          || handledKey.startsWith(`reset|${key}|`)));
      workingHandledKeys = retained;
      continue;
    }

    nextBaselines[key] = {
      observedAt: evidence.observedAt,
      usedPercent: window.usedPercent,
      resetAt: window.resetAt,
      resetIdentity: window.resetIdentity,
    };
    for (const threshold of thresholds) {
      const eventKey = eventKeyForThreshold(key, window.resetAt, threshold);
      if (previous.usedPercent < threshold
          && window.usedPercent >= threshold
          && !workingHandledKeys.includes(eventKey)) {
        candidates.push({ kind: "threshold", eventKey, threshold });
      }
    }
  }

  // The handled-key list above carries reset/schedule epoch changes through
  // the whole refresh. Reconstruct one validated copy before choosing an
  // alert.
  const workingState = validateDesktopNotificationPolicyState({
    ...state,
    baselines: pruneBaselines(nextBaselines),
    handledKeys: workingHandledKeys,
  });
  if (candidates.length === 0) {
    return result(
      workingState,
      sawFirstObservation ? "first_observation" : "no_crossing",
      "fresh",
    );
  }

  const chosen = [...candidates].sort(candidateSort)[0];
  const handledKeys = pruneHandledKeys([
    ...workingState.handledKeys,
    ...candidates.map((candidate) => candidate.eventKey),
  ]);
  const nextState = validateDesktopNotificationPolicyState({
    ...workingState,
    handledKeys,
  });
  const notification = chosen.kind === "reset"
    ? { key: DESKTOP_NOTIFICATION_KEYS.RESET }
    : {
      key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
      thresholdPercent: chosen.threshold,
    };
  return result(nextState, "notification", "fresh", notification);
}
