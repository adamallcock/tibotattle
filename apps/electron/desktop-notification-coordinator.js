/**
 * Serialized main-process coordinator for Electron quota notifications.
 *
 * This module is deliberately independent of Electron.  It joins the three
 * closed contracts at the main-process boundary:
 *
 *   desktop-shell-status -> notification policy -> delivery adapter
 *
 * The policy state is persisted in its own protected settings record.  The
 * coordinator never exposes that state, evidence, filesystem paths, account
 * identifiers, or exception messages to a caller or to its status callback.
 */

import {
  createDesktopNotificationPolicyState,
  deserializeDesktopNotificationPolicyState,
  evaluateDesktopNotificationPolicy,
  serializeDesktopNotificationPolicyState,
  validateDesktopNotificationPolicyState,
} from "./desktop-notification-policy.js";
import {
  DESKTOP_NOTIFICATION_DELIVERY_STATUSES as DELIVERY_STATUSES,
} from "./desktop-notification-delivery.js";
import {
  validateDesktopShellStatus,
} from "../../src/desktop-shell-status.js";

export const DESKTOP_NOTIFICATION_COORDINATOR_SCHEMA_VERSION =
  "tibotattle-electron-notification-coordinator-v1";

export const DESKTOP_NOTIFICATION_POLICY_FILE_NAME =
  "desktop-notification-policy-v1.json";

export const DESKTOP_NOTIFICATION_COORDINATOR_STATES = Object.freeze([
  "uninitialized",
  "ready",
  "state_unavailable",
  "disposed",
]);

export const DESKTOP_NOTIFICATION_COORDINATOR_OUTCOMES = Object.freeze([
  "none",
  "initialized",
  "already_initialized",
  "preferences_updated",
  "preferences_unchanged",
  "disabled",
  "ineligible",
  "first_observation",
  "no_crossing",
  "notification",
  "state_unavailable",
  "status_invalid",
  "disposed",
]);

export const DESKTOP_NOTIFICATION_COORDINATOR_REASONS = Object.freeze([
  "none",
  "fresh",
  "stale",
  "inferred",
  "mixed_source",
  "malformed",
  "state_unavailable",
  "status_invalid",
  "disposed",
]);

export const DESKTOP_NOTIFICATION_COORDINATOR_DELIVERY_STATUSES = Object.freeze([
  "not_attempted",
  ...DELIVERY_STATUSES,
  "state_unavailable",
]);

const SETTINGS_THRESHOLDS = Object.freeze([
  "off",
  "ninety",
  "eighty_and_ninety",
]);

const POLICY_THRESHOLDS = Object.freeze({
  off: "off",
  ninety: "ninety",
  eighty_and_ninety: "eightyAndNinety",
});

const DELIVERY_STATUS_SET = new Set(
  DESKTOP_NOTIFICATION_COORDINATOR_DELIVERY_STATUSES,
);
const COORDINATOR_STATE_SET = new Set(DESKTOP_NOTIFICATION_COORDINATOR_STATES);
const COORDINATOR_OUTCOME_SET = new Set(DESKTOP_NOTIFICATION_COORDINATOR_OUTCOMES);
const COORDINATOR_REASON_SET = new Set(DESKTOP_NOTIFICATION_COORDINATOR_REASONS);
const POLICY_OUTCOME_SET = new Set([
  "disabled",
  "ineligible",
  "first_observation",
  "no_crossing",
  "notification",
]);
function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  return isPlainRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function cloneStatus(value) {
  return Object.freeze({ ...value });
}

function defaultStatus() {
  return cloneStatus({
    schemaVersion: DESKTOP_NOTIFICATION_COORDINATOR_SCHEMA_VERSION,
    state: "uninitialized",
    enabled: false,
    threshold: "off",
    resetEnabled: true,
    delivery: "not_attempted",
    lastOutcome: "none",
    lastReason: "none",
    lastDelivery: "not_attempted",
  });
}

function safeStatusValue({
  state,
  enabled,
  threshold,
  resetEnabled,
  delivery,
  lastOutcome,
  lastReason,
  lastDelivery,
}) {
  const safeState = COORDINATOR_STATE_SET.has(state) ? state : "state_unavailable";
  const safeThreshold = SETTINGS_THRESHOLDS.includes(threshold) ? threshold : "off";
  const safeDelivery = DELIVERY_STATUS_SET.has(delivery)
    ? delivery
    : "state_unavailable";
  const safeOutcome = COORDINATOR_OUTCOME_SET.has(lastOutcome)
    ? lastOutcome
    : "state_unavailable";
  const safeReason = COORDINATOR_REASON_SET.has(lastReason)
    ? lastReason
    : "state_unavailable";
  const safeLastDelivery = DELIVERY_STATUS_SET.has(lastDelivery)
    ? lastDelivery
    : "state_unavailable";
  return cloneStatus({
    schemaVersion: DESKTOP_NOTIFICATION_COORDINATOR_SCHEMA_VERSION,
    state: safeState,
    enabled: safeState === "ready" && enabled === true,
    threshold: safeState === "ready" ? safeThreshold : "off",
    resetEnabled: safeState === "ready" && resetEnabled === true,
    delivery: safeDelivery,
    lastOutcome: safeOutcome,
    lastReason: safeReason,
    lastDelivery: safeLastDelivery,
  });
}

function assertBackend(backend) {
  if (!isPlainRecord(backend)
      || typeof backend.load !== "function"
      || typeof backend.save !== "function") {
    throw new TypeError("notification policy backend is required");
  }
  return backend;
}

function assertDelivery(delivery) {
  if (!isPlainRecord(delivery) || typeof delivery.deliver !== "function") {
    throw new TypeError("notification delivery is required");
  }
  if (delivery.status !== undefined && typeof delivery.status !== "function") {
    throw new TypeError("notification delivery status must be a function");
  }
  return delivery;
}

function assertOptions(options) {
  if (!isPlainRecord(options)) {
    throw new TypeError("notification coordinator options must be an object");
  }
  if (Reflect.ownKeys(options).some((key) =>
    !["backend", "delivery", "onStatus"].includes(key))) {
    throw new TypeError("notification coordinator options have unexpected fields");
  }
  const backend = assertBackend(options.backend);
  const delivery = assertDelivery(options.delivery);
  if (options.onStatus !== undefined && typeof options.onStatus !== "function") {
    throw new TypeError("notification coordinator onStatus must be a function");
  }
  return Object.freeze({
    backend,
    delivery,
    onStatus: options.onStatus ?? null,
  });
}

function assertPreferenceInput(value) {
  if (!hasExactKeys(value, ["enabled", "threshold"])) {
    throw new TypeError("notification preferences are invalid");
  }
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("notification enabled preference is invalid");
  }
  if (!SETTINGS_THRESHOLDS.includes(value.threshold)) {
    throw new TypeError("notification threshold preference is invalid");
  }
  return Object.freeze({
    enabled: value.enabled,
    threshold: value.threshold,
  });
}

function settingsThresholdForPolicy(value) {
  return POLICY_THRESHOLDS[value];
}

function settingsPreferencesForState(state) {
  const threshold = Object.entries(POLICY_THRESHOLDS)
    .find(([, policyThreshold]) => policyThreshold === state.preferences.thresholdMode)?.[0]
    ?? "off";
  return Object.freeze({
    enabled: state.preferences.enabled,
    threshold,
    resetEnabled: state.preferences.resetEnabled,
  });
}

function fixedResult({ outcome, reason, delivery, status, notification = null }) {
  const safeOutcome = COORDINATOR_OUTCOME_SET.has(outcome)
    ? outcome
    : "state_unavailable";
  const safeReason = COORDINATOR_REASON_SET.has(reason)
    ? reason
    : "state_unavailable";
  const safeDelivery = DELIVERY_STATUS_SET.has(delivery)
    ? delivery
    : "state_unavailable";
  const result = {
    outcome: safeOutcome,
    reason: safeReason,
    delivery: safeDelivery,
    status: cloneStatus(status),
  };
  if (notification !== null) result.notification = Object.freeze({ ...notification });
  return Object.freeze(result);
}

function staleEvidence() {
  // The policy only reads status/freshness before validating windows for an
  // ineligible receipt.  This fixed shape therefore clears baselines without
  // carrying a path, account, refresh ID, or provider error into the policy.
  return {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "stale",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "stale",
    observedAt: new Date().toISOString(),
    continuityKey: "0".repeat(43),
    windows: [],
  };
}

function statusForDelivery(delivery) {
  if (typeof delivery.status !== "function") return "not_attempted";
  try {
    const value = delivery.status();
    if (!isPlainRecord(value)
        || !hasExactKeys(value, ["status"])
        || !DELIVERY_STATUS_SET.has(value.status)) {
      return "state_unavailable";
    }
    return value.status;
  } catch {
    return "state_unavailable";
  }
}

function deliveryResultStatus(delivery, notification) {
  try {
    const result = delivery.deliver(notification);
    if (!isPlainRecord(result)
        || !hasExactKeys(result, ["status"])
        || !DELIVERY_STATUS_SET.has(result.status)) {
      return "state_unavailable";
    }
    return result.status;
  } catch {
    // The platform adapter is expected to catch native exceptions.  A test
    // double or a future adapter must not break the coordinator queue or leak
    // an exception message across the main-process boundary.
    return "state_unavailable";
  }
}

function equalState(left, right) {
  try {
    return serializeDesktopNotificationPolicyState(left)
      === serializeDesktopNotificationPolicyState(right);
  } catch {
    return false;
  }
}

function statusWithState(previous, state, lifecycle, delivery, outcome, reason, lastDelivery) {
  const preferences = state === null
    ? { enabled: false, threshold: "off", resetEnabled: true }
    : settingsPreferencesForState(state);
  return safeStatusValue({
    state: lifecycle,
    ...preferences,
    delivery,
    lastOutcome: outcome,
    lastReason: reason,
    lastDelivery,
  });
}

/**
 * Codec for the dedicated policy-state child of the owner-only/protected
 * settings backend.  Its shape intentionally differs from desktop settings:
 * one record can never be decoded as the other record by accident.
 */
export const DESKTOP_NOTIFICATION_POLICY_CODEC = Object.freeze({
  encode(value, maximumBytes) {
    const state = validateDesktopNotificationPolicyState(value);
    const serialized = serializeDesktopNotificationPolicyState(state);
    const bytes = new TextEncoder().encode(serialized);
    if (maximumBytes !== undefined
        && (!Number.isSafeInteger(maximumBytes)
          || maximumBytes < 1
          || bytes.byteLength > maximumBytes)) {
      throw new TypeError("notification policy state is too large");
    }
    return Object.freeze({ value: state, bytes });
  },

  decodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("notification policy bytes are invalid");
    }
    let serialized;
    try {
      serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeError("notification policy bytes are invalid");
    }
    return deserializeDesktopNotificationPolicyState(serialized);
  },

  decodeValue(value) {
    return validateDesktopNotificationPolicyState(value);
  },
});

export function createDesktopNotificationPolicyCodec() {
  return DESKTOP_NOTIFICATION_POLICY_CODEC;
}

/**
 * Create a serialized notification coordinator.  Every public operation is
 * queued behind the prior operation, including initialize and dispose.  The
 * coordinator owns no Electron primitive and is safe to construct in a unit
 * test or in a Windows qualification process.
 */
export function createDesktopNotificationCoordinator(options = {}) {
  const configuration = assertOptions(options);
  const { backend, delivery, onStatus } = configuration;
  let lifecycle = "uninitialized";
  let state = null;
  let currentStatus = defaultStatus();
  let queue = Promise.resolve();

  function publish(nextStatus) {
    currentStatus = cloneStatus(nextStatus);
    if (onStatus !== null) {
      try {
        onStatus(currentStatus);
      } catch {
        // Status observers are telemetry/UI conveniences.  They cannot abort
        // persistence, policy evaluation, or the serialized queue.
      }
    }
    return currentStatus;
  }

  function unavailableStatus(outcome = "state_unavailable", reason = "state_unavailable") {
    lifecycle = "state_unavailable";
    state = null;
    return publish(statusWithState(
      currentStatus,
      null,
      lifecycle,
      "state_unavailable",
      outcome,
      reason,
      "state_unavailable",
    ));
  }

  function disposedResult() {
    const status = publish(statusWithState(
      currentStatus,
      null,
      "disposed",
      "not_attempted",
      "disposed",
      "disposed",
      "not_attempted",
    ));
    return fixedResult({
      outcome: "disposed",
      reason: "disposed",
      delivery: "not_attempted",
      status,
    });
  }

  async function saveState(nextState) {
    try {
      await backend.save(nextState);
      return true;
    } catch {
      unavailableStatus();
      return false;
    }
  }

  async function initializeInternal() {
    if (lifecycle === "disposed") return disposedResult();
    if (lifecycle === "state_unavailable") {
      return fixedResult({
        outcome: "state_unavailable",
        reason: "state_unavailable",
        delivery: "state_unavailable",
        status: currentStatus,
      });
    }
    if (lifecycle === "ready" && state !== null) {
      const status = publish(statusWithState(
        currentStatus,
        state,
        lifecycle,
        statusForDelivery(delivery),
        "already_initialized",
        "none",
        currentStatus.lastDelivery,
      ));
      return fixedResult({
        outcome: "already_initialized",
        reason: "none",
        delivery: status.delivery,
        status,
      });
    }

    let loaded;
    try {
      loaded = await backend.load();
    } catch {
      const status = unavailableStatus();
      return fixedResult({
        outcome: "state_unavailable",
        reason: "state_unavailable",
        delivery: "state_unavailable",
        status,
      });
    }

    let nextState;
    try {
      nextState = loaded === null || loaded === undefined
        ? createDesktopNotificationPolicyState()
        : validateDesktopNotificationPolicyState(loaded);
    } catch {
      const status = unavailableStatus();
      return fixedResult({
        outcome: "state_unavailable",
        reason: "state_unavailable",
        delivery: "state_unavailable",
        status,
      });
    }

    if (loaded === null || loaded === undefined) {
      try {
        await backend.save(nextState);
      } catch {
        const status = unavailableStatus();
        return fixedResult({
          outcome: "state_unavailable",
          reason: "state_unavailable",
          delivery: "state_unavailable",
          status,
        });
      }
    }

    state = nextState;
    lifecycle = "ready";
    const status = publish(statusWithState(
      currentStatus,
      state,
      lifecycle,
      statusForDelivery(delivery),
      "initialized",
      "none",
      "not_attempted",
    ));
    return fixedResult({
      outcome: "initialized",
      reason: "none",
      delivery: status.delivery,
      status,
    });
  }

  function enqueue(operation) {
    const next = queue.then(operation, operation);
    // Keep the queue alive even if an unexpected programmer error escapes an
    // internal operation.  Public operations still report their own fixed
    // status for expected state/backend/delivery failures.
    queue = next.catch(() => undefined);
    return next;
  }

  function status() {
    return cloneStatus(currentStatus);
  }

  function initialize() {
    return enqueue(() => initializeInternal());
  }

  function setPreferences(preferencesValue) {
    const preferences = assertPreferenceInput(preferencesValue);
    return enqueue(async () => {
      if (lifecycle === "disposed") return disposedResult();
      if (lifecycle !== "ready" || state === null) {
        const initialized = await initializeInternal();
        if (initialized.outcome === "state_unavailable") return initialized;
      }

      const nextState = createDesktopNotificationPolicyState({
        enabled: preferences.enabled,
        thresholdMode: settingsThresholdForPolicy(preferences.threshold),
        resetEnabled: state.preferences.resetEnabled,
      });
      if (equalState(nextState, state)) {
        const nextStatus = publish(statusWithState(
          currentStatus,
          state,
          lifecycle,
          statusForDelivery(delivery),
          "preferences_unchanged",
          "none",
          currentStatus.lastDelivery,
        ));
        return fixedResult({
          outcome: "preferences_unchanged",
          reason: "none",
          delivery: nextStatus.delivery,
          status: nextStatus,
        });
      }

      // Preference changes intentionally create a new comparison epoch.  No
      // previous baseline or handled event is allowed to bridge disable /
      // re-enable or threshold-mode changes.
      if (!await saveState(nextState)) {
        const nextStatus = currentStatus;
        return fixedResult({
          outcome: "state_unavailable",
          reason: "state_unavailable",
          delivery: "state_unavailable",
          status: nextStatus,
        });
      }
      state = nextState;
      const nextStatus = publish(statusWithState(
        currentStatus,
        state,
        lifecycle,
        statusForDelivery(delivery),
        "preferences_updated",
        "none",
        currentStatus.lastDelivery,
      ));
      return fixedResult({
        outcome: "preferences_updated",
        reason: "none",
        delivery: nextStatus.delivery,
        status: nextStatus,
      });
    });
  }

  function evaluate(statusValue) {
    return enqueue(async () => {
      if (lifecycle === "disposed") return disposedResult();
      if (lifecycle !== "ready" || state === null) {
        const initialized = await initializeInternal();
        if (initialized.outcome === "state_unavailable") return initialized;
      }

      let validatedStatus;
      try {
        validatedStatus = validateDesktopShellStatus(statusValue);
      } catch {
        const nextStatus = publish(statusWithState(
          currentStatus,
          state,
          lifecycle,
          statusForDelivery(delivery),
          "status_invalid",
          "status_invalid",
          "not_attempted",
        ));
        return fixedResult({
          outcome: "status_invalid",
          reason: "status_invalid",
          delivery: "not_attempted",
          status: nextStatus,
        });
      }

      const evidence = validatedStatus.state === "fresh"
        ? validatedStatus.notificationEvidence
        : staleEvidence();
      const evaluated = evaluateDesktopNotificationPolicy(state, evidence);
      if (!POLICY_OUTCOME_SET.has(evaluated.outcome)) {
        const nextStatus = unavailableStatus();
        return fixedResult({
          outcome: "state_unavailable",
          reason: "state_unavailable",
          delivery: "state_unavailable",
          status: nextStatus,
        });
      }

      // State is published before delivery.  A process crash after this
      // point may lose the OS toast but can never replay it on the next
      // refresh because the handled key has already been committed.
      if (!equalState(evaluated.state, state) && !await saveState(evaluated.state)) {
        return fixedResult({
          outcome: "state_unavailable",
          reason: "state_unavailable",
          delivery: "state_unavailable",
          status: currentStatus,
        });
      }
      state = evaluated.state;

      let deliveryStatus = "not_attempted";
      if (evaluated.notification !== null) {
        deliveryStatus = deliveryResultStatus(delivery, evaluated.notification);
      }
      const nextStatus = publish(statusWithState(
        currentStatus,
        state,
        lifecycle,
        statusForDelivery(delivery),
        evaluated.outcome,
        evaluated.reason,
        deliveryStatus,
      ));
      return fixedResult({
        outcome: evaluated.outcome,
        reason: evaluated.reason,
        delivery: deliveryStatus,
        status: nextStatus,
        notification: evaluated.notification,
      });
    });
  }

  function drain() {
    return queue.then(() => status());
  }

  function dispose() {
    return enqueue(async () => {
      if (lifecycle === "disposed") return disposedResult();
      lifecycle = "disposed";
      state = null;
      return disposedResult();
    });
  }

  return Object.freeze({
    initialize,
    setPreferences,
    evaluate,
    status,
    drain,
    dispose,
  });
}
