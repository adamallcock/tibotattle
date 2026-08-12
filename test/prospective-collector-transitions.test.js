import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProspectiveCollectorTransitions,
  PROSPECTIVE_COLLECTOR_TRANSITIONS_SCHEMA_VERSION,
} from "../src/prospective-collector-transitions.js";

const ACCOUNT_A = `openai-account:v1:${"a".repeat(43)}`;
const ACCOUNT_B = `openai-account:v1:${"b".repeat(43)}`;
const RESET = 1_785_459_600;

function account(scopeId = ACCOUNT_A, planType = "pro") {
  return {
    status: "available",
    reason: null,
    version: "openai-account-v1",
    scopeId,
    planType,
  };
}

function surface() {
  return {
    schemaVersion: "0.1",
    threadSource: "user",
    surface: "local_rollout_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
  };
}

function tier(codexSpeedMode = "standard") {
  return {
    schemaVersion: "0.1",
    billingSurface: "chatgpt_subscription",
    codexSpeedMode,
    apiServiceTier: "unknown",
    providerTierRaw: codexSpeedMode,
    tierSource: "rollout_thread_settings",
    tierObservedAt: "2026-07-25T00:00:00.000Z",
  };
}

function components(value = 10) {
  return {
    input_uncached_tokens: value,
    input_cache_read_tokens: 2,
    input_cache_write_tokens: 1,
    output_text_tokens: 3,
    output_reasoning_tokens: 4,
  };
}

function window(usedPercent, {
  planType = "pro",
  resetsAt = RESET,
  slot = "primary",
  limitId = "codex",
  windowDurationMins = 10_080,
} = {}) {
  return {
    provider: "openai_codex",
    planType,
    limitId,
    slot,
    usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

function usage({
  eventKey,
  observedAt,
  usedPercent,
  scopeId = ACCOUNT_A,
  planType = "pro",
  speed = "standard",
  tokenValue = 10,
  resetsAt = RESET,
  stalenessMs = 0,
  limitId = "codex",
  slot = "primary",
} = {}) {
  const receivedAt = new Date(Date.parse(observedAt) + stalenessMs).toISOString();
  return {
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt,
    stalenessMs,
    source: "rollout_token_count",
    model: "gpt-5.6",
    components: components(tokenValue),
    tierSemantics: tier(speed),
    surfaceClassification: surface(),
    accountScope: account(scopeId, planType),
    accountScopeAttribution: "provisional_fresh_app_server_marker",
    windows: [window(usedPercent, {
      planType, resetsAt, limitId, slot,
    })],
    controlledState: "unknown",
    eventKey,
  };
}

function quota({
  eventKey,
  observedAt,
  usedPercent,
  scopeId = ACCOUNT_A,
  planType = "pro",
  resetsAt = RESET,
  limitId = "codex",
  slot = "primary",
} = {}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source: "app_server_notification",
    windows: [window(usedPercent, {
      planType, resetsAt, limitId, slot,
    })],
    providerSurface: "account_shared_unallocated",
    accountScope: account(scopeId, planType),
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey,
  };
}

function tool({
  eventKey,
  observedAt,
  scopeId = ACCOUNT_A,
  planType = "pro",
  toolClass = "local_shell",
} = {}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_tool_class_event",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source: "rollout_tool_call",
    toolClass,
    surfaceClassification: surface(),
    accountScope: account(scopeId, planType),
    accountScopeAttribution: "provisional_fresh_app_server_marker",
    controlledState: "unknown",
    eventKey,
  };
}

test("builds deterministic account-local adjacent transitions with marginal usage and tools", () => {
  const records = [
    quota({
      eventKey: "3".repeat(64),
      observedAt: "2026-07-25T00:03:00.000Z",
      usedPercent: 12,
    }),
    tool({
      eventKey: "4".repeat(64),
      observedAt: "2026-07-25T00:02:30.000Z",
      toolClass: "subagent",
    }),
    usage({
      eventKey: "2".repeat(64),
      observedAt: "2026-07-25T00:02:00.000Z",
      usedPercent: 11,
      speed: "fast",
      tokenValue: 20,
    }),
    quota({
      eventKey: "1".repeat(64),
      observedAt: "2026-07-25T00:01:00.000Z",
      usedPercent: 10,
    }),
  ];
  const first = buildProspectiveCollectorTransitions(records, { priceUsage: () => 1.25 });
  const second = buildProspectiveCollectorTransitions([...records].reverse(), {
    priceUsage: () => 1.25,
  });
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, PROSPECTIVE_COLLECTOR_TRANSITIONS_SCHEMA_VERSION);
  assert.equal(first.localOnly, true);
  assert.equal(first.transitions.length, 2);
  assert.equal(Object.hasOwn(first.transitions[0], "localOnly"), false);
  assert.equal(Object.hasOwn(first.transitions[0], "schemaVersion"), false);
  assert.equal(first.transitions[0].accountScopeId, ACCOUNT_A);
  assert.equal(first.transitions[0].slot, "duration_led");
  assert.equal(first.transitions[0].marginalUsageEventCount, 1);
  assert.equal(first.transitions[0].marginalComponents.input_uncached_tokens, 20);
  assert.equal(first.transitions[0].marginalApiPricedUsd, 1.25);
  assert.equal(first.transitions[0].tierUsageEventCounts.fast, 1);
  assert.equal(first.transitions[1].aggregateToolClassMix.subagent, 1);
});

test("never pools switched accounts and removes duplicate event keys deterministically", () => {
  const aPrior = quota({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 10,
  });
  const aNext = quota({
    eventKey: "3".repeat(64),
    observedAt: "2026-07-25T00:03:00.000Z",
    usedPercent: 11,
  });
  const bPrior = quota({
    eventKey: "5".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 20,
    scopeId: ACCOUNT_B,
  });
  const bNext = quota({
    eventKey: "7".repeat(64),
    observedAt: "2026-07-25T00:03:00.000Z",
    usedPercent: 21,
    scopeId: ACCOUNT_B,
  });
  const aUsage = usage({
    eventKey: "2".repeat(64),
    observedAt: "2026-07-25T00:02:00.000Z",
    usedPercent: 10,
    tokenValue: 7,
  });
  const bUsage = usage({
    eventKey: "6".repeat(64),
    observedAt: "2026-07-25T00:02:00.000Z",
    usedPercent: 20,
    scopeId: ACCOUNT_B,
    tokenValue: 70,
  });
  const result = buildProspectiveCollectorTransitions(
    [bNext, aNext, aUsage, bUsage, aPrior, bPrior, structuredClone(aUsage)],
    { priceUsage: (record) => record.accountScope.scopeId === ACCOUNT_A ? 1 : 10 },
  );
  assert.equal(result.transitions.length, 2);
  assert.deepEqual(
    result.transitions.map((row) => [
      row.accountScopeId,
      row.marginalComponents.input_uncached_tokens,
      row.marginalApiPricedUsd,
    ]),
    [
      [ACCOUNT_A, 7, 1],
      [ACCOUNT_B, 70, 10],
    ],
  );
  assert.equal(result.diagnostics.exclusions.duplicateEventKey, 1);
});

test("accounts for unavailable, stale, reset, regression, nonmovement, and malformed exclusions", () => {
  const unavailable = quota({
    eventKey: "a".repeat(64),
    observedAt: "2026-07-25T00:00:00.000Z",
    usedPercent: 1,
  });
  unavailable.accountScope = {
    status: "unavailable",
    reason: "missing_secret",
    version: "openai-account-v1",
    scopeId: null,
    planType: "pro",
  };
  const stale = usage({
    eventKey: "b".repeat(64),
    observedAt: "2026-07-25T00:00:00.000Z",
    usedPercent: 1,
    stalenessMs: 300_001,
  });
  const records = [
    unavailable,
    stale,
    { ...quota({
      eventKey: "c".repeat(64),
      observedAt: "2026-07-25T00:00:00.000Z",
      usedPercent: 1,
    }), content: "PRIVATE-CANARY" },
    quota({
      eventKey: "d".repeat(64),
      observedAt: "2026-07-25T00:01:00.000Z",
      usedPercent: 5,
    }),
    quota({
      eventKey: "e".repeat(64),
      observedAt: "2026-07-25T00:02:00.000Z",
      usedPercent: 5,
    }),
    quota({
      eventKey: "f".repeat(64),
      observedAt: "2026-07-25T00:03:00.000Z",
      usedPercent: 4,
    }),
    quota({
      eventKey: "0".repeat(64),
      observedAt: "2026-07-25T00:04:00.000Z",
      usedPercent: 1,
      resetsAt: RESET + 60,
    }),
  ];
  const result = buildProspectiveCollectorTransitions(records, { priceUsage: () => 0 });
  assert.equal(result.transitions.length, 0);
  assert.deepEqual(result.diagnostics.exclusions, {
    unattributed: 1,
    stale: 1,
    resetBoundary: 1,
    regression: 1,
    nonmovement: 1,
    malformed: 1,
    duplicateEventKey: 0,
    conflictingEventKey: 0,
    slotConflict: 0,
    unsupportedPolicyEpoch: 0,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE-CANARY"), false);
});

test("rejects plan-inconsistent rows, extra raw identity fields, paths, and emails as malformed", () => {
  const inconsistent = quota({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 1,
  });
  inconsistent.windows[0].planType = "team";
  const withProviderId = {
    ...quota({
      eventKey: "2".repeat(64),
      observedAt: "2026-07-25T00:02:00.000Z",
      usedPercent: 2,
    }),
    providerAccountId: "raw-provider-id",
  };
  const withPath = usage({
    eventKey: "3".repeat(64),
    observedAt: "2026-07-25T00:03:00.000Z",
    usedPercent: 3,
  });
  withPath.model = "/Users/private/model";
  const withEmail = usage({
    eventKey: "4".repeat(64),
    observedAt: "2026-07-25T00:04:00.000Z",
    usedPercent: 4,
  });
  withEmail.model = "private@example.test";
  const withInvalidReset = quota({
    eventKey: "5".repeat(64),
    observedAt: "2026-07-25T00:05:00.000Z",
    usedPercent: 5,
    resetsAt: Number.MAX_SAFE_INTEGER,
  });
  const result = buildProspectiveCollectorTransitions(
    [inconsistent, withProviderId, withPath, withEmail, withInvalidReset],
    { priceUsage: () => 0 },
  );
  assert.equal(result.transitions.length, 0);
  assert.equal(result.diagnostics.exclusions.malformed, 5);
});

test("fails closed when pricing throws or returns an invalid value", () => {
  const record = usage({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 1,
  });
  for (const priceUsage of [
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => -1,
    () => "1",
    () => { throw new Error("private pricing failure"); },
  ]) {
    assert.throws(
      () => buildProspectiveCollectorTransitions([record], { priceUsage }),
      /priceUsage/,
    );
  }
});

test("foreign-account key reuse cannot suppress a track and conflicting same-track keys are excluded", () => {
  const aPrior = quota({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 10,
  });
  const aNext = quota({
    eventKey: "2".repeat(64),
    observedAt: "2026-07-25T00:03:00.000Z",
    usedPercent: 11,
  });
  const foreignSameKey = quota({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:00.000Z",
    usedPercent: 20,
    scopeId: ACCOUNT_B,
  });
  const conflict = quota({
    eventKey: "1".repeat(64),
    observedAt: "2026-07-25T00:01:30.000Z",
    usedPercent: 12,
  });

  const isolated = buildProspectiveCollectorTransitions(
    [aPrior, aNext, foreignSameKey],
    { priceUsage: () => 0 },
  );
  assert.equal(isolated.transitions.length, 1);
  assert.equal(isolated.transitions[0].accountScopeId, ACCOUNT_A);

  const conflicted = buildProspectiveCollectorTransitions(
    [aPrior, aNext, conflict],
    { priceUsage: () => 0 },
  );
  assert.equal(conflicted.transitions.length, 0);
  assert.equal(conflicted.diagnostics.exclusions.conflictingEventKey, 2);
});

test("usage is allocated only to its exact semantic limit and slot moves preserve duration continuity", () => {
  const records = [
    quota({
      eventKey: "1".repeat(64),
      observedAt: "2026-07-25T00:01:00.000Z",
      usedPercent: 10,
      slot: "primary",
    }),
    usage({
      eventKey: "2".repeat(64),
      observedAt: "2026-07-25T00:02:00.000Z",
      usedPercent: 20,
      limitId: "codex-spark",
      tokenValue: 90,
    }),
    quota({
      eventKey: "3".repeat(64),
      observedAt: "2026-07-25T00:03:00.000Z",
      usedPercent: 11,
      slot: "secondary",
    }),
  ];
  const result = buildProspectiveCollectorTransitions(records, {
    priceUsage: () => 9,
  });
  const codex = result.transitions.find((row) => row.limitId === "codex");
  assert.ok(codex);
  assert.equal(codex.marginalUsageEventCount, 0);
  assert.equal(codex.marginalApiPricedUsd, 0);
  assert.equal(codex.snapshot.priorSlot, "primary");
  assert.equal(codex.snapshot.nextSlot, "secondary");
});

test("conflicting simultaneous slot observations are excluded instead of pooled", () => {
  const result = buildProspectiveCollectorTransitions([
    quota({
      eventKey: "1".repeat(64),
      observedAt: "2026-07-25T00:01:00.000Z",
      usedPercent: 10,
      slot: "primary",
    }),
    quota({
      eventKey: "2".repeat(64),
      observedAt: "2026-07-25T00:01:00.000Z",
      usedPercent: 12,
      slot: "secondary",
    }),
    quota({
      eventKey: "3".repeat(64),
      observedAt: "2026-07-25T00:03:00.000Z",
      usedPercent: 13,
      slot: "secondary",
    }),
  ], { priceUsage: () => 0 });
  assert.equal(result.transitions.length, 0);
  assert.equal(result.diagnostics.exclusions.slotConflict, 2);
});
