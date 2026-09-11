import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopNotificationCoordinator,
  createDesktopNotificationPolicyCodec,
  DESKTOP_NOTIFICATION_COORDINATOR_SCHEMA_VERSION,
} from "../desktop-notification-coordinator.js";
import {
  DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
  DESKTOP_NOTIFICATION_KEYS,
  DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
} from "../desktop-notification-policy.js";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
} from "../../../src/desktop-shell-status.js";

const RESET_AT = "2026-09-01T10:00:00.000Z";
const OBSERVED_FIRST = "2026-08-22T10:00:00.000Z";
const OBSERVED_SECOND = "2026-08-22T10:05:00.000Z";
const CONTINUITY = "a".repeat(43);

function evidence({
  observedAt = OBSERVED_FIRST,
  usedPercent = 40,
  resetAt = RESET_AT,
} = {}) {
  return {
    schemaVersion: DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey: CONTINUITY,
    windows: [{
      lane: "primary",
      durationMinutes: 300,
      resetAt,
      resetProofKind: "provider_reported_schedule_only",
      usedPercent,
    }],
  };
}

function shellStatus({
  state = "fresh",
  notificationEvidence = evidence(),
} = {}) {
  return {
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state,
    allowance: state === "fresh"
      ? { source: "direct", window: "five_hour", remainingPercent: 100 - notificationEvidence.windows[0].usedPercent }
      : null,
    notificationEvidence: state === "fresh" ? {
      ...notificationEvidence,
      schemaVersion: DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    } : null,
  };
}

function backendFixture({ value = null, loadError = null, saveError = null, events = [] } = {}) {
  let stored = value;
  return {
    get stored() {
      return stored;
    },
    async load() {
      events.push("load");
      if (loadError) throw loadError;
      return stored;
    },
    async save(next) {
      events.push("save");
      if (saveError) throw saveError;
      stored = next;
      return next;
    },
  };
}

function deliveryFixture({ status = "ready", deliverStatus = "delivered", events = [] } = {}) {
  const deliveries = [];
  return {
    deliveries,
    status() {
      return { status };
    },
    deliver(value) {
      events.push("deliver");
      deliveries.push(value);
      if (deliverStatus instanceof Error) throw deliverStatus;
      return { status: deliverStatus };
    },
  };
}

async function readyCoordinator({ backend = backendFixture(), delivery = deliveryFixture(), onStatus } = {}) {
  const coordinator = createDesktopNotificationCoordinator({ backend, delivery, onStatus });
  const initialized = await coordinator.initialize();
  assert.equal(initialized.outcome, "initialized");
  return { coordinator, backend, delivery };
}

test("policy codec is a separate bounded schema and round-trips deeply frozen state", () => {
  const codec = createDesktopNotificationPolicyCodec();
  const state = {
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: { enabled: true, resetEnabled: true, thresholdMode: "ninety" },
    baselines: {},
    handledKeys: [],
  };
  const encoded = codec.encode(state, 64 * 1024);
  assert.ok(encoded.bytes instanceof Uint8Array);
  assert.ok(encoded.bytes.byteLength > 0);
  assert.equal(Object.isFrozen(encoded.value), true);
  assert.deepEqual(codec.decodeBytes(encoded.bytes), encoded.value);
  assert.deepEqual(codec.decodeValue(encoded.value), encoded.value);
  assert.throws(() => codec.decodeBytes(new Uint8Array([0xff])), TypeError);
  assert.throws(() => codec.decodeValue({ ...state, path: "/private" }), TypeError);
  assert.throws(() => codec.encode(state, 1), TypeError);
  assert.equal(JSON.stringify(encoded.value).includes("path"), false);
});
test("missing state is created and corrupt or unavailable state fails closed", async () => {
  const missingEvents = [];
  const missingBackend = backendFixture({ events: missingEvents });
  const missingDelivery = deliveryFixture();
  const missing = createDesktopNotificationCoordinator({
    backend: missingBackend,
    delivery: missingDelivery,
  });
  assert.equal((await missing.initialize()).outcome, "initialized");
  assert.deepEqual(missing.status(), {
    schemaVersion: DESKTOP_NOTIFICATION_COORDINATOR_SCHEMA_VERSION,
    state: "ready",
    enabled: false,
    threshold: "off",
    resetEnabled: true,
    delivery: "ready",
    lastOutcome: "initialized",
    lastReason: "none",
    lastDelivery: "not_attempted",
  });
  assert.deepEqual(missingEvents, ["load", "save"]);

  const corrupt = createDesktopNotificationCoordinator({
    backend: backendFixture({ value: { schemaVersion: "other" } }),
    delivery: deliveryFixture(),
  });
  assert.equal((await corrupt.initialize()).outcome, "state_unavailable");
  assert.equal(corrupt.status().state, "state_unavailable");
  assert.equal(corrupt.status().enabled, false);

  const unavailable = createDesktopNotificationCoordinator({
    backend: backendFixture({ loadError: new Error("private path") }),
    delivery: deliveryFixture(),
  });
  assert.equal((await unavailable.initialize()).reason, "state_unavailable");
  assert.equal(unavailable.status().state, "state_unavailable");

  const saveFailure = createDesktopNotificationCoordinator({
    backend: backendFixture({ saveError: new Error("private path") }),
    delivery: deliveryFixture(),
  });
  assert.equal((await saveFailure.initialize()).outcome, "state_unavailable");
  assert.equal(saveFailure.status().delivery, "state_unavailable");
});

test("settings thresholds map exactly and preference changes start a new comparison epoch", async () => {
  const { coordinator, backend } = await readyCoordinator();
  assert.throws(() => coordinator.setPreferences({ enabled: true, threshold: "custom" }), TypeError);
  assert.throws(() => coordinator.setPreferences({ enabled: true, threshold: "ninety", extra: true }), TypeError);
  assert.throws(() => coordinator.setPreferences({ enabled: 1, threshold: "ninety" }), TypeError);

  let result = await coordinator.setPreferences({ enabled: true, threshold: "eighty_and_ninety" });
  assert.equal(result.outcome, "preferences_updated");
  assert.equal(result.status.threshold, "eighty_and_ninety");
  assert.equal(result.status.enabled, true);

  result = await coordinator.evaluate(shellStatus({ notificationEvidence: evidence({ usedPercent: 70 }) }));
  assert.equal(result.outcome, "first_observation");
  assert.equal(result.delivery, "not_attempted");
  assert.equal(backend.stored.preferences.thresholdMode, "eightyAndNinety");

  await coordinator.setPreferences({ enabled: false, threshold: "off" });
  assert.equal(coordinator.status().enabled, false);
  await coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  assert.equal(coordinator.status().threshold, "ninety");
  result = await coordinator.evaluate(shellStatus({ notificationEvidence: evidence({ usedPercent: 95 }) }));
  assert.equal(result.outcome, "first_observation");
  assert.equal(result.delivery, "not_attempted");
});

test("first observation, crossing, dedupe, replay, and save-before-delivery are serialized", async () => {
  const events = [];
  const backend = backendFixture({ events });
  const delivery = deliveryFixture({ events });
  const { coordinator } = await readyCoordinator({ backend, delivery });
  await coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  events.length = 0;

  let result = await coordinator.evaluate(shellStatus({ notificationEvidence: evidence() }));
  assert.equal(result.outcome, "first_observation");
  assert.deepEqual(events, ["save"]);

  events.length = 0;
  result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: OBSERVED_SECOND, usedPercent: 95 }),
  }));
  assert.equal(result.outcome, "notification");
  assert.equal(result.notification.key, DESKTOP_NOTIFICATION_KEYS.THRESHOLD);
  assert.equal(result.notification.thresholdPercent, 90);
  assert.equal(result.delivery, "delivered");
  assert.deepEqual(events, ["save", "deliver"]);
  assert.equal(delivery.deliveries.length, 1);

  result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: "2026-08-22T10:06:00.000Z", usedPercent: 95 }),
  }));
  assert.equal(result.outcome, "no_crossing");
  assert.equal(result.delivery, "not_attempted");
  assert.equal(delivery.deliveries.length, 1);

  result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: OBSERVED_SECOND, usedPercent: 95 }),
  }));
  assert.equal(result.outcome, "no_crossing");
  assert.equal(delivery.deliveries.length, 1);
});

test("reset precedence, nonfresh clearing, and invalid status never deliver", async () => {
  const { coordinator, delivery } = await readyCoordinator();
  await coordinator.setPreferences({ enabled: true, threshold: "eighty_and_ninety" });
  await coordinator.evaluate(shellStatus({ notificationEvidence: evidence({ usedPercent: 70 }) }));
  let result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({
      observedAt: OBSERVED_SECOND,
      usedPercent: 95,
      resetAt: "2026-09-02T10:00:00.000Z",
    }),
  }));
  assert.equal(result.outcome, "no_crossing");
  // A stale accepted shell state is an ineligible policy evaluation and
  // clears the baseline before a future fresh observation.
  result = await coordinator.evaluate(shellStatus({ state: "stale" }));
  assert.equal(result.outcome, "ineligible");
  assert.equal(result.reason, "stale");
  result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({
      observedAt: "2026-08-22T10:10:00.000Z",
      usedPercent: 99,
    }),
  }));
  assert.equal(result.outcome, "first_observation");
  assert.equal(delivery.deliveries.length, 0);

  result = await coordinator.evaluate({
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "fresh",
    allowance: null,
    notificationEvidence: null,
    rawError: "secret",
  });
  assert.equal(result.outcome, "status_invalid");
  assert.equal(result.reason, "status_invalid");
  assert.equal(delivery.deliveries.length, 0);
});

test("delivery unavailable or native failure is fixed and policy state remains committed", async () => {
  const unavailable = await readyCoordinator({ delivery: deliveryFixture({ status: "not_packaged", deliverStatus: "not_packaged" }) });
  await unavailable.coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  await unavailable.coordinator.evaluate(shellStatus({ notificationEvidence: evidence() }));
  const result = await unavailable.coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: OBSERVED_SECOND, usedPercent: 95 }),
  }));
  assert.equal(result.outcome, "notification");
  assert.equal(result.delivery, "not_packaged");
  assert.equal(unavailable.coordinator.status().lastDelivery, "not_packaged");

  const nativeFailure = await readyCoordinator({ delivery: deliveryFixture({ deliverStatus: new Error("private native error") }) });
  await nativeFailure.coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  await nativeFailure.coordinator.evaluate(shellStatus({ notificationEvidence: evidence() }));
  const failed = await nativeFailure.coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: OBSERVED_SECOND, usedPercent: 95 }),
  }));
  assert.equal(failed.outcome, "notification");
  assert.equal(failed.delivery, "state_unavailable");
  const replay = await nativeFailure.coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: "2026-08-22T10:06:00.000Z", usedPercent: 95 }),
  }));
  assert.equal(replay.outcome, "no_crossing");
  assert.equal(nativeFailure.delivery.deliveries.length, 1);
});

test("save failure prevents delivery and does not advance in-memory policy state", async () => {
  const events = [];
  const backend = backendFixture({ events });
  const delivery = deliveryFixture({ events });
  const { coordinator } = await readyCoordinator({ backend, delivery });
  await coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  await coordinator.evaluate(shellStatus({ notificationEvidence: evidence() }));
  const before = backend.stored;
  backend.save = async () => {
    events.push("save-failure");
    throw new Error("private path");
  };
  const result = await coordinator.evaluate(shellStatus({
    notificationEvidence: evidence({ observedAt: OBSERVED_SECOND, usedPercent: 95 }),
  }));
  assert.equal(result.outcome, "state_unavailable");
  assert.equal(result.delivery, "state_unavailable");
  assert.deepEqual(backend.stored, before);
  assert.equal(delivery.deliveries.length, 0);
});

test("concurrent operations serialize, callback exceptions are contained, and status is frozen", async () => {
  const events = [];
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const backend = {
    value: null,
    async load() {
      events.push("load-start");
      await loadGate;
      events.push("load-end");
      return this.value;
    },
    async save(value) {
      events.push("save");
      this.value = value;
      return value;
    },
  };
  const delivery = deliveryFixture({ events });
  const observed = [];
  const coordinator = createDesktopNotificationCoordinator({
    backend,
    delivery,
    onStatus(value) {
      observed.push(value);
      throw new Error("observer must not break queue");
    },
  });
  const initialize = coordinator.initialize();
  const preferences = coordinator.setPreferences({ enabled: true, threshold: "ninety" });
  const evaluation = coordinator.evaluate(shellStatus({ notificationEvidence: evidence() }));
  releaseLoad();
  assert.equal((await initialize).outcome, "initialized");
  assert.equal((await preferences).outcome, "preferences_updated");
  assert.equal((await evaluation).outcome, "first_observation");
  assert.deepEqual(events.slice(0, 5), ["load-start", "load-end", "save", "save", "save"]);
  assert.ok(observed.length >= 3);
  assert.equal(Object.isFrozen(coordinator.status()), true);
  assert.throws(() => { coordinator.status().state = "ready"; }, TypeError);
  assert.equal((await coordinator.dispose()).outcome, "disposed");
  assert.equal((await coordinator.initialize()).outcome, "disposed");
  assert.equal((await coordinator.drain()).state, "disposed");
});
