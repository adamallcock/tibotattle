import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopNotificationPolicyState,
  deserializeDesktopNotificationPolicyState,
  DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
  DESKTOP_NOTIFICATION_KEYS,
  DESKTOP_NOTIFICATION_MAX_BASELINES,
  DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS,
  DESKTOP_NOTIFICATION_OUTCOMES,
  DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
  DESKTOP_NOTIFICATION_REASONS,
  DESKTOP_NOTIFICATION_THRESHOLD_MODES,
  evaluateDesktopNotificationPolicy,
  serializeDesktopNotificationPolicyState,
  validateDesktopNotificationEvidence,
  validateDesktopNotificationPolicyState,
} from "../desktop-notification-policy.js";

const CONTINUITY = "a".repeat(43);
const OTHER_CONTINUITY = "b".repeat(43);
const FIRST_RESET = "2026-08-30T10:00:00.000Z";
const SECOND_RESET = "2026-09-06T10:00:00.000Z";

function windowValue({
  lane = "primary",
  durationMinutes = 300,
  usedPercent = 40,
  resetAt = FIRST_RESET,
  resetProofKind = "provider_reported_schedule_only",
  resetIdentity = "window-2026-08-30",
} = {}) {
  const value = {
    lane,
    durationMinutes,
    usedPercent,
    resetAt,
    resetProofKind,
  };
  if (resetProofKind === "provider_reported_identity") {
    value.resetIdentity = resetIdentity;
  }
  return value;
}

function evidenceValue({
  observedAt = "2026-08-22T10:00:00.000Z",
  continuityKey = CONTINUITY,
  provider = "openai_codex",
  source = "app_server_read",
  freshness = "fresh",
  status = "fresh_provider_observation",
  windows = [windowValue()],
} = {}) {
  return {
    schemaVersion: DESKTOP_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    status,
    provider,
    source,
    freshness,
    observedAt,
    continuityKey,
    windows,
  };
}

function enabledState({
  thresholdMode = "eightyAndNinety",
  resetEnabled = true,
  baselines = {},
  handledKeys = [],
} = {}) {
  return validateDesktopNotificationPolicyState({
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: { enabled: true, thresholdMode, resetEnabled },
    baselines,
    handledKeys,
  });
}

function firstObservation({
  thresholdMode = "eightyAndNinety",
  resetEnabled = true,
  evidence = evidenceValue(),
} = {}) {
  const state = enabledState({ thresholdMode, resetEnabled });
  return evaluateDesktopNotificationPolicy(state, evidence);
}

function baselineFor({
  continuityKey = CONTINUITY,
  lane = "primary",
  durationMinutes = 300,
  observedAt = "2026-08-22T10:00:00.000Z",
  usedPercent = 40,
  resetAt = FIRST_RESET,
  resetIdentity = null,
} = {}) {
  return {
    observedAt,
    usedPercent,
    resetAt,
    resetIdentity,
    laneKey: `${continuityKey}|${lane}|${durationMinutes}`,
  };
}

test("exports a frozen, closed policy vocabulary", () => {
  assert.deepEqual(DESKTOP_NOTIFICATION_THRESHOLD_MODES, [
    "off",
    "ninety",
    "eightyAndNinety",
  ]);
  assert.deepEqual(DESKTOP_NOTIFICATION_KEYS, {
    RESET: "quota.reset",
    THRESHOLD: "quota.threshold",
  });
  assert.deepEqual(DESKTOP_NOTIFICATION_OUTCOMES, [
    "disabled",
    "ineligible",
    "first_observation",
    "no_crossing",
    "notification",
  ]);
  assert.ok(DESKTOP_NOTIFICATION_REASONS.includes("stale"));
  assert.equal(Object.isFrozen(DESKTOP_NOTIFICATION_THRESHOLD_MODES), true);
  assert.equal(Object.isFrozen(DESKTOP_NOTIFICATION_KEYS), true);
  assert.equal(Object.isFrozen(DESKTOP_NOTIFICATION_OUTCOMES), true);
});

test("fresh installation state is explicit, bounded, and deeply frozen", () => {
  const state = createDesktopNotificationPolicyState();
  assert.deepEqual(state, {
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: {
      enabled: false,
      resetEnabled: true,
      thresholdMode: "off",
    },
    baselines: {},
    handledKeys: [],
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.preferences), true);
  assert.equal(Object.isFrozen(state.baselines), true);
  assert.equal(Object.isFrozen(state.handledKeys), true);
  assert.equal(
    createDesktopNotificationPolicyState({ enabled: true }).preferences.thresholdMode,
    "eightyAndNinety",
  );
  assert.equal(
    createDesktopNotificationPolicyState({ enabled: true, thresholdMode: "off" })
      .preferences.thresholdMode,
    "off",
  );
});

test("state serialization is canonical and round-trips through strict validation", () => {
  const raw = {
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: {
      enabled: true,
      resetEnabled: true,
      thresholdMode: "ninety",
    },
    baselines: {
      [`${OTHER_CONTINUITY}|secondary|10080`]: {
        observedAt: "2026-08-22T10:01:00.000Z",
        usedPercent: 41.5,
        resetAt: SECOND_RESET,
        resetIdentity: "window-2026-09-06",
      },
      [`${CONTINUITY}|primary|300`]: {
        observedAt: "2026-08-22T10:00:00.000Z",
        usedPercent: 40,
        resetAt: FIRST_RESET,
        resetIdentity: null,
      },
    },
    handledKeys: [
      `threshold|${CONTINUITY}|primary|300|${FIRST_RESET}|90`,
    ],
  };
  const state = validateDesktopNotificationPolicyState(raw);
  const serialized = serializeDesktopNotificationPolicyState(state);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(deserializeDesktopNotificationPolicyState(serialized), state);

  const reordered = {
    handledKeys: [...raw.handledKeys],
    baselines: {
      [`${CONTINUITY}|primary|300`]: raw.baselines[`${CONTINUITY}|primary|300`],
      [`${OTHER_CONTINUITY}|secondary|10080`]: raw.baselines[`${OTHER_CONTINUITY}|secondary|10080`],
    },
    preferences: { ...raw.preferences },
    schemaVersion: raw.schemaVersion,
  };
  assert.equal(
    serializeDesktopNotificationPolicyState(reordered),
    serialized,
  );
});

test("state serialization rejects malformed, unsafe, nonfinite, duplicate, and oversized state", () => {
  const valid = {
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: {
      enabled: true,
      resetEnabled: true,
      thresholdMode: "ninety",
    },
    baselines: {},
    handledKeys: [],
  };
  const invalid = [
    null,
    [],
    { ...valid, path: "/private" },
    { ...valid, schemaVersion: "other" },
    { ...valid, preferences: { ...valid.preferences, identity: "account" } },
    { ...valid, preferences: { ...valid.preferences, enabled: 1 } },
    { ...valid, preferences: { ...valid.preferences, thresholdMode: "custom" } },
    { ...valid, baselines: { bad: {} } },
    {
      ...valid,
      baselines: {
        [`${CONTINUITY}|primary|300`]: {
          observedAt: "2026-08-22T10:00:00.000Z",
          usedPercent: Number.NaN,
          resetAt: FIRST_RESET,
          resetIdentity: null,
        },
      },
    },
    {
      ...valid,
      baselines: {
        [`${CONTINUITY}|primary|300`]: {
          observedAt: "2026-08-22T10:00:00.000Z",
          usedPercent: 20,
          resetAt: FIRST_RESET,
          resetIdentity: null,
          rawError: "do not retain",
        },
      },
    },
    {
      ...valid,
      handledKeys: [
        `threshold|${CONTINUITY}|primary|300|${FIRST_RESET}|90`,
        `threshold|${CONTINUITY}|primary|300|${FIRST_RESET}|90`,
      ],
    },
    {
      ...valid,
      handledKeys: [`threshold|${CONTINUITY}|primary|300|${FIRST_RESET}|80|extra`],
    },
  ];
  for (const value of invalid) {
    assert.throws(() => validateDesktopNotificationPolicyState(value), TypeError);
  }
  assert.throws(() => deserializeDesktopNotificationPolicyState("not-json"), TypeError);
  assert.throws(() => deserializeDesktopNotificationPolicyState(`${"x".repeat(128 * 1024)}\n`), TypeError);

  // Make the over-bound fixture unique while keeping each key valid.
  const uniqueHandled = Array.from({ length: DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS + 1 }, (_, index) =>
    `reset|${String.fromCharCode(97 + (index % 26)).repeat(43)}|primary|300|${FIRST_RESET}`);
  assert.throws(() => validateDesktopNotificationPolicyState({
    ...valid,
    handledKeys: uniqueHandled,
  }), TypeError);
});

test("evidence accepts only the exact fresh direct-provider contract", () => {
  const validated = validateDesktopNotificationEvidence(evidenceValue({
    windows: [
      windowValue({ lane: "secondary", durationMinutes: 10080, usedPercent: 12 }),
      windowValue({ lane: "primary", durationMinutes: 300, usedPercent: 40 }),
    ],
  }));
  assert.deepEqual(validated.windows.map((window) => window.lane), ["primary", "secondary"]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.windows), true);
  assert.equal(Object.isFrozen(validated.windows[0]), true);

  const invalidEvidence = [
    evidenceValue({ freshness: "stale" }),
    evidenceValue({ freshness: "inferred" }),
    evidenceValue({ status: "inferred" }),
    evidenceValue({ provider: "other" }),
    evidenceValue({ source: "logs" }),
    evidenceValue({ windows: [windowValue({ usedPercent: Number.NaN })] }),
    evidenceValue({ windows: [windowValue({ usedPercent: Number.POSITIVE_INFINITY })] }),
    evidenceValue({ windows: [windowValue({ resetIdentity: "../account" , resetProofKind: "provider_reported_identity" })] }),
    evidenceValue({ windows: [windowValue({ resetProofKind: "provider_reported_identity", resetIdentity: null })] }),
    evidenceValue({ windows: [windowValue(), windowValue()] }),
    { ...evidenceValue(), path: "/Users/adam" },
    { ...evidenceValue(), rawError: "provider failed" },
    { ...evidenceValue(), identity: "account-123" },
    { ...evidenceValue(), extra: true },
    { ...evidenceValue({ windows: [windowValue()] }), windows: [{ ...windowValue(), path: "/private" }] },
  ];
  for (const value of invalidEvidence) {
    assert.throws(() => validateDesktopNotificationEvidence(value), TypeError);
  }
});

test("disabled consent never evaluates or emits a notification", () => {
  const state = createDesktopNotificationPolicyState();
  const evaluated = evaluateDesktopNotificationPolicy(state, {
    ...evidenceValue(),
    rawError: "ignored while disabled",
  });
  assert.equal(evaluated.outcome, "disabled");
  assert.equal(evaluated.reason, "disabled");
  assert.equal(evaluated.notification, null);
  assert.deepEqual(evaluated.state, state);
});

test("first fresh observation stores a baseline without notifying", () => {
  const evaluated = firstObservation();
  assert.equal(evaluated.outcome, "first_observation");
  assert.equal(evaluated.reason, "fresh");
  assert.equal(evaluated.notification, null);
  assert.equal(Object.keys(evaluated.state.baselines).length, 1);
  assert.equal(evaluated.state.baselines[`${CONTINUITY}|primary|300`].usedPercent, 40);
});

test("threshold modes implement upward crossings and one alert per accepted refresh", () => {
  let state = firstObservation({ thresholdMode: "eightyAndNinety" }).state;
  let evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.deepEqual(evaluated.notification, {
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
  });
  assert.equal(evaluated.outcome, "notification");
  assert.equal(evaluated.state.handledKeys.length, 2);
  assert.equal(evaluated.state.handledKeys.some((key) => key.endsWith("|80")), true);
  assert.equal(evaluated.state.handledKeys.some((key) => key.endsWith("|90")), true);

  state = evaluated.state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:06:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(evaluated.notification, null);
  assert.equal(evaluated.outcome, "no_crossing");

  // Even after falling below and rising above again, this reset epoch's
  // deterministic handled key prevents a duplicate alert.
  state = evaluateDesktopNotificationPolicy(evaluated.state, evidenceValue({
    observedAt: "2026-08-22T10:07:00.000Z",
    windows: [windowValue({ usedPercent: 70 })],
  })).state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:08:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(evaluated.notification, null);

  state = firstObservation({ thresholdMode: "ninety" }).state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.deepEqual(evaluated.notification, {
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
  });

  state = firstObservation({ thresholdMode: "off" }).state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(evaluated.notification, null);
  assert.equal(evaluated.outcome, "no_crossing");
});

test("crossing is based on the previous value, not merely being near a threshold", () => {
  let state = firstObservation({ thresholdMode: "eightyAndNinety" }).state;
  let evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:01:00.000Z",
    windows: [windowValue({ usedPercent: 79 })],
  }));
  assert.equal(evaluated.notification, null);
  state = evaluated.state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:02:00.000Z",
    windows: [windowValue({ usedPercent: 80 })],
  }));
  assert.deepEqual(evaluated.notification, {
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 80,
  });
  state = evaluated.state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:03:00.000Z",
    windows: [windowValue({ usedPercent: 85 })],
  }));
  assert.equal(evaluated.notification, null);
  state = evaluated.state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:04:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.deepEqual(evaluated.notification, {
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
  });
});

test("reset alerts take precedence and all same-refresh candidates are consumed", () => {
  let state = firstObservation({
    thresholdMode: "eightyAndNinety",
    evidence: evidenceValue({
      windows: [
        windowValue({ lane: "primary", usedPercent: 70, resetAt: FIRST_RESET }),
        windowValue({ lane: "secondary", durationMinutes: 10080, usedPercent: 70, resetAt: FIRST_RESET }),
      ],
    }),
  }).state;
  const evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-30T10:01:00.000Z",
    windows: [
      windowValue({ lane: "primary", usedPercent: 95, resetAt: SECOND_RESET }),
      windowValue({ lane: "secondary", durationMinutes: 10080, usedPercent: 95, resetAt: SECOND_RESET }),
    ],
  }));
  assert.deepEqual(evaluated.notification, { key: DESKTOP_NOTIFICATION_KEYS.RESET });
  assert.equal(evaluated.state.handledKeys.length, 2);
  assert.equal(evaluated.state.handledKeys.every((key) => key.startsWith("reset|")), true);
  assert.equal(evaluated.state.baselines[`${CONTINUITY}|primary|300`].resetAt, SECOND_RESET);

  const repeated = evaluateDesktopNotificationPolicy(evaluated.state, evidenceValue({
    observedAt: "2026-08-30T10:02:00.000Z",
    windows: [
      windowValue({ lane: "primary", usedPercent: 95, resetAt: SECOND_RESET }),
      windowValue({ lane: "secondary", durationMinutes: 10080, usedPercent: 95, resetAt: SECOND_RESET }),
    ],
  }));
  assert.equal(repeated.notification, null);
});

test("schedule-only reset is emitted once after the provider-reported due time", () => {
  let state = firstObservation({
    thresholdMode: "off",
    evidence: evidenceValue({ windows: [windowValue({ usedPercent: 70 })] }),
  }).state;
  let evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-29T10:01:00.000Z",
    windows: [windowValue({ usedPercent: 72, resetAt: SECOND_RESET })],
  }));
  assert.equal(evaluated.notification, null);
  state = evaluated.state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-09-06T10:01:00.000Z",
    windows: [windowValue({ usedPercent: 4, resetAt: "2026-09-13T10:00:00.000Z" })],
  }));
  assert.deepEqual(evaluated.notification, { key: DESKTOP_NOTIFICATION_KEYS.RESET });
  evaluated = evaluateDesktopNotificationPolicy(evaluated.state, evidenceValue({
    observedAt: "2026-09-06T10:02:00.000Z",
    windows: [windowValue({ usedPercent: 4, resetAt: "2026-09-13T10:00:00.000Z" })],
  }));
  assert.equal(evaluated.notification, null);
});

test("provider reset identity can trigger before schedule due, but malformed identity cannot", () => {
  let state = firstObservation({
    thresholdMode: "off",
    evidence: evidenceValue({
      windows: [windowValue({
        usedPercent: 70,
        resetProofKind: "provider_reported_identity",
        resetIdentity: "window-old",
      })],
    }),
  }).state;
  let evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({
      usedPercent: 3,
      resetProofKind: "provider_reported_identity",
      resetIdentity: "window-new",
    })],
  }));
  assert.deepEqual(evaluated.notification, { key: DESKTOP_NOTIFICATION_KEYS.RESET });

  state = firstObservation({ thresholdMode: "off" }).state;
  evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({
      usedPercent: 3,
      resetProofKind: "provider_reported_identity",
      resetIdentity: "../secret",
    })],
  }));
  assert.equal(evaluated.outcome, "ineligible");
  assert.equal(evaluated.reason, "invalid_identity");
  assert.equal(evaluated.notification, null);
});

test("ineligible evidence re-baselines and cannot bridge a stale or mixed gap", () => {
  let state = firstObservation({ thresholdMode: "ninety" }).state;
  let evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    freshness: "stale",
    observedAt: "2026-08-22T10:05:00.000Z",
  }));
  assert.equal(evaluated.outcome, "ineligible");
  assert.equal(evaluated.reason, "stale");
  assert.deepEqual(evaluated.state.baselines, {});

  evaluated = evaluateDesktopNotificationPolicy(evaluated.state, evidenceValue({
    observedAt: "2026-08-22T10:06:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(evaluated.outcome, "first_observation");
  assert.equal(evaluated.notification, null);

  evaluated = evaluateDesktopNotificationPolicy(evaluated.state, evidenceValue({
    provider: "mixed-provider",
    observedAt: "2026-08-22T10:07:00.000Z",
  }));
  assert.equal(evaluated.reason, "mixed_source");
  assert.equal(evaluated.notification, null);
});

test("duplicate and out-of-order fresh receipts cannot move a baseline or replay", () => {
  const initial = firstObservation({ thresholdMode: "ninety" });
  const duplicate = evaluateDesktopNotificationPolicy(initial.state, evidenceValue());
  assert.equal(duplicate.notification, null);
  assert.deepEqual(duplicate.state, initial.state);

  const crossing = evaluateDesktopNotificationPolicy(initial.state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(crossing.notification.thresholdPercent, 90);
  const reordered = evaluateDesktopNotificationPolicy(crossing.state, evidenceValue({
    observedAt: "2026-08-22T10:04:00.000Z",
    windows: [windowValue({ usedPercent: 99 })],
  }));
  assert.equal(reordered.notification, null);
  assert.equal(reordered.state.baselines[`${CONTINUITY}|primary|300`].usedPercent, 95);
});

test("bounded state stays bounded while retaining only semantic notification output", () => {
  const baselines = {};
  for (let index = 0; index < DESKTOP_NOTIFICATION_MAX_BASELINES - 1; index += 1) {
    const continuityKey = `${index.toString(36).padStart(2, "0")}${"c".repeat(41)}`;
    const baseline = baselineFor({ continuityKey });
    baselines[baseline.laneKey] = {
      observedAt: baseline.observedAt,
      usedPercent: baseline.usedPercent,
      resetAt: baseline.resetAt,
      resetIdentity: baseline.resetIdentity,
    };
  }
  const currentBaseline = baselineFor({ continuityKey: CONTINUITY });
  baselines[currentBaseline.laneKey] = {
    observedAt: currentBaseline.observedAt,
    usedPercent: currentBaseline.usedPercent,
    resetAt: currentBaseline.resetAt,
    resetIdentity: currentBaseline.resetIdentity,
  };
  const state = enabledState({
    thresholdMode: "ninety",
    baselines,
  });
  const evaluated = evaluateDesktopNotificationPolicy(state, evidenceValue({
    observedAt: "2026-08-22T10:05:00.000Z",
    windows: [windowValue({ usedPercent: 95 })],
  }));
  assert.equal(Object.keys(evaluated.state.baselines).length, DESKTOP_NOTIFICATION_MAX_BASELINES);
  assert.deepEqual(evaluated.notification, {
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
  });
  assert.deepEqual(Object.keys(evaluated.notification), ["key", "thresholdPercent"]);
  assert.equal(Object.keys(evaluated.notification).some((key) => /path|identity|error/i.test(key)), false);
  assert.equal(evaluated.state.handledKeys.length <= DESKTOP_NOTIFICATION_MAX_HANDLED_KEYS, true);

  const fullBaselines = {};
  for (let index = 0; index < DESKTOP_NOTIFICATION_MAX_BASELINES; index += 1) {
    const continuityKey = `${(index + 300).toString(36).padStart(2, "0")}${"d".repeat(41)}`;
    const baseline = baselineFor({ continuityKey });
    fullBaselines[baseline.laneKey] = {
      observedAt: baseline.observedAt,
      usedPercent: baseline.usedPercent,
      resetAt: baseline.resetAt,
      resetIdentity: baseline.resetIdentity,
    };
  }
  const pruned = evaluateDesktopNotificationPolicy(
    enabledState({ thresholdMode: "ninety", baselines: fullBaselines }),
    evidenceValue({
      observedAt: "2026-08-22T10:05:00.000Z",
      windows: [windowValue({ usedPercent: 95 })],
    }),
  );
  assert.equal(pruned.notification, null);
  assert.equal(Object.keys(pruned.state.baselines).length, DESKTOP_NOTIFICATION_MAX_BASELINES);
  assert.equal(Object.hasOwn(pruned.state.baselines, `${CONTINUITY}|primary|300`), true);
});

test("all malformed evidence categories fail closed without leaking input data", () => {
  const state = firstObservation({ thresholdMode: "ninety" }).state;
  const cases = [
    ["stale", evidenceValue({ freshness: "stale" })],
    ["inferred", evidenceValue({ freshness: "inferred" })],
    ["mixed_source", evidenceValue({ source: "logs" })],
    ["nonfinite", evidenceValue({ windows: [windowValue({ usedPercent: Number.NaN })] })],
    ["path_present", { ...evidenceValue(), path: "/private/account" }],
    ["raw_error", { ...evidenceValue(), rawError: "secret" }],
    ["invalid_identity", { ...evidenceValue(), identity: "account" }],
    ["extra_field", { ...evidenceValue(), extra: "value" }],
  ];
  for (const [reason, evidence] of cases) {
    const evaluated = evaluateDesktopNotificationPolicy(state, evidence);
    assert.equal(evaluated.outcome, "ineligible");
    assert.equal(evaluated.reason, reason);
    assert.equal(evaluated.notification, null);
    assert.deepEqual(Object.keys(evaluated), ["state", "outcome", "reason", "notification"]);
  }
});

test("invalid persisted state is rejected before policy evaluation", () => {
  assert.throws(() => evaluateDesktopNotificationPolicy({
    schemaVersion: DESKTOP_NOTIFICATION_POLICY_SCHEMA_VERSION,
    preferences: {
      enabled: true,
      resetEnabled: true,
      thresholdMode: "ninety",
    },
    baselines: {},
    handledKeys: [],
    rawError: "not accepted",
  }, evidenceValue()), TypeError);
});
