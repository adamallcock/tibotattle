import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APP_OFFICIAL_PRICE_CARDS,
  CODEX_SPEED_MODE_DECLARATION,
  CODEX_SPEED_MODE_OBSERVABILITY,
  FAST_MODE_ASSUMED_MULTIPLIER,
  FAST_MODE_ASSUMED_MULTIPLIER_SOURCE,
  FAST_MODE_MULTIPLIER_SOURCE,
  FAST_MODE_QUOTA_MULTIPLIERS,
  QUOTA_WEIGHTED_API_PRICE_METRIC,
  emptySpeedWeightingCrossing,
  fastModeQuotaMultiplier,
  inferFastModeFromCalibrationWindows,
  resolveEffectiveSpeedMode,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import {
  FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS,
  deriveFastModePriorityRatiosFromRegistry,
  fastModeModelFamily,
  quotaWeightedApiPriceEquivalent,
} from "../packages/accounting/src/subscription-speed.js";

import {
  CODEX_SPEED_BASELINE_SCHEMA_VERSION,
  createCodexSpeedBaselineController,
  declaredSpeedModeAt,
} from "../src/codex-speed-baseline.js";
import {
  readCodexConfigServiceTier,
} from "../src/platform/index.js";

function crossing(cells) {
  const value = emptySpeedWeightingCrossing();
  for (const [speed, family, events, usd] of cells) {
    value[speed][family] = { events, apiPriceEquivalentUsd: usd };
  }
  return value;
}

test("published Priority (Fast) API price ratios are derived, sourced, and dated", () => {
  // The published Priority API price is 2x Standard for GPT-5.6 and GPT-5.4
  // and 2.5x for GPT-5.5 - notably NOT the superseded credit-rate statement's
  // 2.5x for GPT-5.6.
  assert.deepEqual({ ...FAST_MODE_QUOTA_MULTIPLIERS }, {
    "gpt-5.6": 2,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
  });
  assert.equal(Object.isFrozen(FAST_MODE_QUOTA_MULTIPLIERS), true);
  // The map is derived from the price registry and re-deriving it is exact.
  assert.deepEqual(
    deriveFastModePriorityRatiosFromRegistry(),
    { ...FAST_MODE_QUOTA_MULTIPLIERS },
  );
  // A registry whose Priority row is not a uniform multiple of Standard is
  // refused rather than shipped as a wrong multiplier.
  const skewed = structuredClone(
    APP_OFFICIAL_PRICE_CARDS.filter((card) => card.provider === "openai"),
  );
  const target = skewed.find((card) => (
    card.model === "gpt-5.5" && card.service_tier === "priority"
  ));
  target.components.find(
    (component) => component.usage_component === "output_text_tokens",
  ).price.amount = "76";
  assert.throws(
    () => deriveFastModePriorityRatiosFromRegistry(skewed),
    /not uniform/,
  );
  assert.equal(FAST_MODE_MULTIPLIER_SOURCE.publisher, "openai");
  assert.equal(FAST_MODE_MULTIPLIER_SOURCE.recordedAt, "2026-08-30");
  assert.equal(
    FAST_MODE_MULTIPLIER_SOURCE.basis,
    "published_priority_api_price_ratio_relative_to_standard",
  );
  assert.equal(FAST_MODE_ASSUMED_MULTIPLIER, 2);
  assert.equal(FAST_MODE_ASSUMED_MULTIPLIER_SOURCE.recordedAt, "2026-08-30");
  assert.equal(
    FAST_MODE_MULTIPLIER_SOURCE.observability,
    "rollout_thread_settings_changes_only_no_session_baseline",
  );
  // The log proves tier CHANGES, never the session baseline. Any surface that
  // claims the mode is wholly unrecorded is wrong.
  assert.equal(CODEX_SPEED_MODE_OBSERVABILITY.sessionBaselineRecorded, false);
  assert.equal(
    CODEX_SPEED_MODE_OBSERVABILITY.recordedEvent,
    "event_msg.payload.thread_settings_applied.service_tier",
  );
  assert.deepEqual({ ...CODEX_SPEED_MODE_OBSERVABILITY.observedValues }, {
    priority: "fast",
    default: "standard",
  });
  assert.match(FAST_MODE_MULTIPLIER_SOURCE.statement, /2x .*2\.5x/u);
});

test("model families match exactly and unsupported models stay an explicit null", () => {
  assert.equal(fastModeModelFamily("gpt-5.6-sol"), "gpt-5.6");
  assert.equal(fastModeQuotaMultiplier("gpt-5.6"), 2);
  assert.equal(fastModeQuotaMultiplier("gpt-5.6-sol"), 2);
  assert.equal(fastModeQuotaMultiplier("gpt-5.5-codex"), 2.5);
  assert.equal(fastModeQuotaMultiplier("gpt-5.4-codex"), 2);
  // Never a silent published claim: a model outside the ratio families and a
  // near-miss name both resolve to null, and the weighting layers apply the
  // disclosed assumed multiplier instead.
  for (const model of ["gpt-5.60", "gpt-5.4future", "gpt-4.1", "gpt-5", null]) {
    assert.equal(fastModeQuotaMultiplier(model), null);
  }
});

test("effective mode resolves observed, then declared, then the scenario default", () => {
  // An observed mode beats a declaration and any scenario.
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "standard",
      declaredMode: "fast",
      unresolvedScenario: "unresolved_as_fast",
    }),
    { mode: "standard", provenance: "observed" },
  );
  // A covering declaration beats the scenario.
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "fast",
    }),
    { mode: "fast", provenance: "declared_codex_config" },
  );
  // With no evidence, the default scenario attributes Standard as a visible
  // assumption, and the fast sensitivity scenario re-attributes the same
  // residual to Fast.
  assert.deepEqual(
    resolveEffectiveSpeedMode({ observedMode: "unknown" }),
    { mode: "standard", provenance: "assumed_standard_default" },
  );
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "unknown",
      unresolvedScenario: "unresolved_as_fast",
    }),
    { mode: "fast", provenance: "assumed_fast_scenario" },
  );
});

test("weighting multiplies only Fast events and discloses assumed ratios", () => {
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-5.6-sol",
      mode: "fast",
    }),
    { usd: 8, multiplier: 2, status: "fast_weighted" },
  );
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-5.5",
      mode: "fast",
    }),
    { usd: 10, multiplier: 2.5, status: "fast_weighted" },
  );
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-5.6-sol",
      mode: "standard",
    }),
    { usd: 4, multiplier: 1, status: "standard_rate" },
  );
  // A Fast amount on a model without a published Priority rate is included at
  // the assumed multiplier with an assumed status, never excluded.
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-4.1",
      mode: "fast",
    }),
    { usd: 8, multiplier: 2, status: "fast_weighted_assumed_ratio" },
  );
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-5.6",
      mode: "unknown",
    }),
    { usd: null, multiplier: null, status: "unknown_mode" },
  );
});

test("observed Fast is weighted at the published Priority ratio", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([
      ["fast", "gpt-5.6", 4, 10],
      ["standard", "gpt-5.4", 2, 5],
    ]),
  });
  assert.equal(summary.standardApiPriceEquivalentUsd, 15);
  // 10 x 2 observed Fast + 5 observed Standard.
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 25);
  assert.equal(summary.weightingStatus, "complete");
  assert.deepEqual({ ...summary.appliedMultipliers }, { "gpt-5.6": 2 });
  assert.equal(summary.coverage.observedEvents, 6);
  assert.equal(summary.coverage.assumedEvents, 0);
  assert.equal(summary.coverage.unknownEvents, 0);
  assert.equal(summary.assumedRatioStandardApiPriceEquivalentUsd, 0);
  assert.equal(summary.metric.key, "quotaWeightedApiPriceEquivalentUsd");
  assert.equal(
    summary.metric.label,
    QUOTA_WEIGHTED_API_PRICE_METRIC.label,
  );
});

test("an unrecorded mode follows the scenario and never silently drops Fast dollars", () => {
  const cells = crossing([
    ["unknown", "gpt-5.5", 3, 8],
    ["unknown", "unsupported", 1, 2],
  ]);
  const standard = summarizeQuotaWeightedAccounting({
    speedWeighting: cells,
  });
  assert.equal(standard.unresolvedScenario, "unresolved_as_standard");
  assert.equal(standard.quotaWeightedApiPriceEquivalentUsd, 10);
  assert.equal(standard.coverage.assumedEvents, 4);
  assert.equal(standard.weightingStatus, "complete");

  const fast = summarizeQuotaWeightedAccounting({
    speedWeighting: cells,
    unresolvedScenario: "unresolved_as_fast",
  });
  // 8 x 2.5 published plus the unsupported model's 2 x 2 assumed ratio: the
  // Fast dollars are included and the assumption is reported, not excluded.
  assert.equal(fast.quotaWeightedApiPriceEquivalentUsd, 24);
  assert.equal(fast.assumedRatioStandardApiPriceEquivalentUsd, 2);
  assert.equal(fast.unweightedUnknownApiPriceEquivalentUsd, 0);
  assert.deepEqual({ ...fast.appliedMultipliers }, {
    "gpt-5.5": 2.5,
    unsupported: FAST_MODE_ASSUMED_MULTIPLIER,
  });
  assert.equal(fast.weightingStatus, "complete");
});

test("coverage partitions provenance while inference remains an assumed overlap", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([
      ["fast", "gpt-5.6", 2, 4],
      ["standard", "gpt-5.6", 2, 4],
      ["unknown", "gpt-5.6", 6, 12],
    ]),
    inferredFastEvents: 4,
    inference: { status: "inferred", inferredFastWindowCount: 2 },
  });
  assert.deepEqual({ ...summary.coverage }, {
    totalEvents: 10,
    observedEvents: 4,
    declaredFromConfigEvents: 0,
    assumedEvents: 6,
    inferredEvents: 4,
    unknownEvents: 0,
    observedSharePercent: 40,
    unknownSharePercent: 0,
  });
  assert.equal(
    summary.coverage.observedEvents
      + summary.coverage.declaredFromConfigEvents
      + summary.coverage.assumedEvents
      + summary.coverage.unknownEvents,
    summary.coverage.totalEvents,
  );
  assert.ok(summary.coverage.inferredEvents
    <= summary.coverage.assumedEvents + summary.coverage.unknownEvents);
  // Inference labels windows, so it never moves the weighted total: the six
  // assumed events stay Standard at 1x in the default scenario.
  assert.equal(summary.inference.appliedToWeighting, false);
  assert.equal(summary.inference.inferredFastWindows, 2);
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 24);
});

test("inferred event counts clamp to the no-evidence bucket without subtracting it", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([["unknown", "gpt-5.6", 3, 6]]),
    inferredFastEvents: 99,
  });
  assert.equal(summary.coverage.inferredEvents, 3);
  assert.equal(summary.coverage.assumedEvents, 3);
  assert.equal(summary.coverage.unknownEvents, 0);
  assert.equal(
    summary.coverage.observedEvents
      + summary.coverage.declaredFromConfigEvents
      + summary.coverage.assumedEvents
      + summary.coverage.unknownEvents,
    summary.coverage.totalEvents,
  );
});

function window(id, capacityUsd, overrides = {}) {
  return {
    id,
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-07-08T00:00:00.000Z",
    apiPriceEquivalentUsd: capacityUsd,
    knownSpeedFraction: 0.9,
    fastFractionOfKnown: 0,
    eligibleTransitions: 40,
    uniqueBoundaries: 20,
    observedSpanPercentagePoints: 60,
    unknownSpeedEvents: 5,
    ...overrides,
  };
}

test("residual inference marks a window Fast only at a published multiple", () => {
  const references = [
    window("a", 100),
    window("b", 102),
    window("c", 98),
  ];
  const result = inferFastModeFromCalibrationWindows([
    ...references,
    // 100 / 40 = 2.5x the Standard-priced prediction.
    window("fast", 40, { knownSpeedFraction: null, fastFractionOfKnown: null }),
    // 100 / 71 = 1.41x: no published multiple matches.
    window("plain", 71, { knownSpeedFraction: null, fastFractionOfKnown: null }),
  ]);
  assert.equal(result.status, "inferred");
  assert.equal(result.referenceStandardCapacityUsd, 100);
  assert.equal(result.referenceWindowCount, 3);
  assert.equal(result.inferredFastWindowCount, 1);
  assert.equal(result.inferredFastUnknownSpeedEvents, 5);
  const inferred = result.windows.find((row) => row.id === "fast");
  assert.equal(inferred.mode, "fast");
  assert.equal(inferred.provenance, "inferred");
  assert.equal(inferred.matchedMultiple, 2.5);
  assert.equal(inferred.observedToStandardPredictedRatio, 2.5);
  const plain = result.windows.find((row) => row.id === "plain");
  assert.equal(plain.mode, "unknown");
  assert.equal(plain.provenance, "unknown");
  assert.equal(plain.reasonCode, "ratio_matches_no_published_multiple");
});

test("the tolerance band keeps the two published multiples disjoint", () => {
  const tolerance =
    FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS.relativeToleranceOfPublishedMultiple;
  // A shared band would let one ratio claim both 2x and 2.5x.
  assert.equal(2 * (1 + tolerance) < 2.5 * (1 - tolerance), true);
  const result = inferFastModeFromCalibrationWindows([
    window("a", 100),
    window("b", 100),
    window("c", 100),
    // 100 / 50 = 2x exactly.
    window("two", 50, { knownSpeedFraction: null, fastFractionOfKnown: null }),
    // 2.225x falls in the gap between the 2x band ([1.8, 2.2]) and the
    // 2.5x band ([2.25, 2.75]), so neither multiple may claim it.
    window("between", 100 / 2.225, {
      knownSpeedFraction: null,
      fastFractionOfKnown: null,
    }),
  ]);
  assert.equal(
    result.windows.find((row) => row.id === "two").matchedMultiple,
    2,
  );
  assert.equal(result.windows.find((row) => row.id === "between").mode, "unknown");
});

test("inference refuses to run without enough matched signal", () => {
  assert.equal(
    inferFastModeFromCalibrationWindows([]).reasonCode,
    "windows_unavailable",
  );
  assert.equal(
    inferFastModeFromCalibrationWindows([window("a", 100), window("b", 100)])
      .reasonCode,
    "not_enough_scored_windows",
  );
  // Windows exist but none is a credible Standard reference.
  const noReference = inferFastModeFromCalibrationWindows([
    window("a", 100, { fastFractionOfKnown: 0.8 }),
    window("b", 100, { fastFractionOfKnown: 0.8 }),
    window("c", 100, { knownSpeedFraction: 0.1 }),
    window("d", 100, { knownSpeedFraction: null }),
  ]);
  assert.equal(noReference.status, "insufficient_signal");
  assert.equal(noReference.reasonCode, "not_enough_reference_windows");
  assert.equal(noReference.inferredFastWindowCount, 0);
  // A thin window is never scored, however extreme its ratio.
  const thin = inferFastModeFromCalibrationWindows([
    window("a", 100),
    window("b", 100),
    window("c", 100),
    window("thin", 40, {
      eligibleTransitions: 2,
      knownSpeedFraction: null,
      fastFractionOfKnown: null,
    }),
  ]);
  assert.equal(thin.windows.some((row) => row.id === "thin"), false);
});

// ---------------------------------------------------------------------------
// Declared Codex speed-mode baseline.
//
// Codex writes the mode to the rollout log only when it is applied or changed,
// so a session's baseline is unobservable there. `~/.codex/config.toml` holds a
// top-level `service_tier` key with the current setting, but the Codex UI
// rewrites that file on every toggle, so it proves the value only at the moment
// it is read. These tests pin the three properties that makes safe: it never
// reaches backwards, it never beats an observation, and it fails closed.
// ---------------------------------------------------------------------------

const CONFIG_WITH_SECRETS = [
  "# Codex configuration",
  'model = "gpt-5.6"',
  'service_tier = "priority"',
  "",
  "[mcp_servers.internal]",
  'command = "/usr/local/bin/secret-tool"',
  'env = { API_TOKEN = "sk-do-not-read-me" }',
  'service_tier = "default"',
  "",
  "[profiles.work]",
  'approval_policy = "never"',
  "",
].join("\n");

async function configRoot(contents) {
  const root = await mkdtemp(join(tmpdir(), "codex-speed-baseline-"));
  const configFile = join(root, "config.toml");
  if (contents !== null) {
    await writeFile(configFile, contents, { mode: 0o600 });
  }
  return { configFile, ledgerFile: join(root, "private", "baseline.json"), root };
}

test("only the root-table service_tier key is ever read from the Codex config", async () => {
  const { configFile, root } = await configRoot(CONFIG_WITH_SECRETS);
  try {
    const declaration = await readCodexConfigServiceTier({ configFile });
    // Exactly three content-free fields, and the only value carried out of the
    // file is the tier token itself.
    assert.deepEqual(Object.keys(declaration).sort(), [
      "retainedKeys",
      "serviceTier",
      "status",
    ]);
    assert.equal(declaration.status, "declared");
    assert.equal(declaration.serviceTier, "priority");
    assert.deepEqual([...declaration.retainedKeys], ["service_tier"]);
    // No model name, no MCP command, no token, no path - and specifically not
    // the `service_tier` that lives inside an MCP table, which is out of scope
    // by construction because the scan stops at the first table header.
    const serialized = JSON.stringify(declaration);
    for (const forbidden of [
      "gpt-5.6",
      "secret-tool",
      "sk-do-not-read-me",
      "API_TOKEN",
      "mcp_servers",
      "approval_policy",
      "default",
      root,
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing, unreadable, or unrecognised declaration fails closed", async () => {
  const missing = await configRoot(null);
  try {
    assert.deepEqual(
      await readCodexConfigServiceTier({ configFile: missing.configFile }),
      { status: "missing", serviceTier: null, retainedKeys: ["service_tier"] },
    );
    // A directory in place of the file, and a nonsense path, are both refused
    // without guessing a default.
    assert.equal(
      (await readCodexConfigServiceTier({ configFile: missing.root })).status,
      "unreadable",
    );
    assert.equal(
      (await readCodexConfigServiceTier({ configFile: "" })).status,
      "unreadable",
    );
  } finally {
    await rm(missing.root, { recursive: true, force: true });
  }

  for (const [label, contents] of [
    ["no key at all", 'model = "gpt-5.6"\n'],
    ["key only inside a table", '[profile]\nservice_tier = "priority"\n'],
    ["unquoted value", "service_tier = priority\n"],
    ["non-scalar value", 'service_tier = { name = "priority" }\n'],
    ["empty file", ""],
  ]) {
    const fixture = await configRoot(contents);
    try {
      const declaration = await readCodexConfigServiceTier({
        configFile: fixture.configFile,
      });
      assert.equal(declaration.status, "absent", label);
      assert.equal(declaration.serviceTier, null, label);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  // An unrecognised token is never coerced into a mode, so a renamed or new
  // provider tier can never be silently read as Standard.
  const renamed = await configRoot('service_tier = "turbo"\n');
  try {
    const controller = createCodexSpeedBaselineController({
      ledgerFile: renamed.ledgerFile,
      configFile: renamed.configFile,
      now: () => new Date("2026-08-01T10:00:00.000Z"),
    });
    const recorded = await controller.record();
    assert.equal(recorded.status, "undeclared");
    assert.deepEqual([...recorded.windows], []);
    assert.equal(await readFile(renamed.ledgerFile, "utf8").catch(() => null), null);
  } finally {
    await rm(renamed.root, { recursive: true, force: true });
  }
});

test("a declared baseline never applies to turns before it was read", async () => {
  const { configFile, ledgerFile, root } = await configRoot(CONFIG_WITH_SECRETS);
  try {
    let clock = new Date("2026-08-01T12:00:00.000Z");
    const controller = createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => clock,
    });

    const first = await controller.record();
    assert.equal(first.status, "opened");
    assert.equal(first.declaredMode, "fast");
    assert.equal(first.appliesTo, "turns_at_or_after_the_moment_the_key_was_read");
    assert.equal(first.neverBackfillsHistory, true);
    assert.deepEqual([...first.windows], [{
      firstSeenAt: "2026-08-01T12:00:00.000Z",
      lastSeenAt: "2026-08-01T12:00:00.000Z",
      mode: "fast",
    }]);

    // The reading proves nothing about any earlier turn, however close.
    assert.equal(
      declaredSpeedModeAt(first.windows, Date.parse("2026-08-01T11:59:59.999Z")),
      null,
    );
    assert.equal(
      declaredSpeedModeAt(first.windows, Date.parse("2026-08-01T12:00:00.000Z")),
      "fast",
    );
    // Nor about a turn after the reading but before the next one confirms it.
    assert.equal(
      declaredSpeedModeAt(first.windows, Date.parse("2026-08-01T12:00:00.001Z")),
      null,
    );

    clock = new Date("2026-08-01T13:00:00.000Z");
    const extended = await controller.record();
    assert.equal(extended.status, "extended");
    assert.equal(extended.windows.length, 1);
    // The value held at both ends, and any change between them would itself be
    // in the rollout log, so the whole interval is now covered.
    assert.equal(
      declaredSpeedModeAt(extended.windows, Date.parse("2026-08-01T12:30:00.000Z")),
      "fast",
    );
    assert.equal(
      declaredSpeedModeAt(extended.windows, Date.parse("2026-08-01T13:00:00.001Z")),
      null,
    );

    // A changed value opens a new window; the gap in which it might have
    // changed is left uncovered rather than assigned to either side.
    await writeFile(configFile, 'service_tier = "default"\n', { mode: 0o600 });
    clock = new Date("2026-08-01T14:00:00.000Z");
    const opened = await controller.record();
    assert.equal(opened.status, "opened");
    assert.deepEqual([...opened.windows], [
      {
        firstSeenAt: "2026-08-01T12:00:00.000Z",
        lastSeenAt: "2026-08-01T13:00:00.000Z",
        mode: "fast",
      },
      {
        firstSeenAt: "2026-08-01T14:00:00.000Z",
        lastSeenAt: "2026-08-01T14:00:00.000Z",
        mode: "standard",
      },
    ]);
    assert.equal(
      declaredSpeedModeAt(opened.windows, Date.parse("2026-08-01T13:30:00.000Z")),
      null,
    );
    assert.equal(
      declaredSpeedModeAt(opened.windows, Date.parse("2026-08-01T14:00:00.000Z")),
      "standard",
    );

    // Only the mode and the two instants are ever stored.
    const stored = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(stored.schemaVersion, CODEX_SPEED_BASELINE_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(stored).sort(), ["schemaVersion", "windows"]);
    for (const window of stored.windows) {
      assert.deepEqual(Object.keys(window).sort(), [
        "firstSeenAt",
        "lastSeenAt",
        "mode",
      ]);
    }
    assert.equal(JSON.stringify(stored).includes("priority"), false);

    // A malformed ledger is an explicit failure, and the non-throwing reader
    // degrades to no coverage rather than inventing one.
    await writeFile(ledgerFile, "{\"windows\":[]}\n", { mode: 0o600 });
    await assert.rejects(
      () => controller.inspect(),
      (error) => error.code === "codex_speed_baseline_unavailable",
    );
    assert.deepEqual(await controller.readWindows(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an observation always beats a declared baseline", () => {
  // Resolution order, one step at a time.
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "standard",
      declaredMode: "fast",
      unresolvedScenario: "unresolved_as_fast",
    }) },
    { mode: "standard", provenance: "observed" },
  );
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "fast",
    }) },
    { mode: "fast", provenance: "declared_codex_config" },
  );
  assert.deepEqual(
    { ...resolveEffectiveSpeedMode({
      observedMode: "unknown",
      declaredMode: "unknown",
    }) },
    { mode: "standard", provenance: "assumed_standard_default" },
  );
  assert.equal(CODEX_SPEED_MODE_DECLARATION.neverBackfillsHistory, true);
  assert.deepEqual(
    [...CODEX_SPEED_MODE_DECLARATION.retainedKeys],
    ["service_tier"],
  );

  // The same precedence holds through the aggregate. Four observed-Fast events
  // stay Fast, and the six unobserved events are attributed by the declaration
  // instead of by the assumed-Standard default.
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([
      ["fast", "gpt-5.6", 4, 8],
      ["unknown", "gpt-5.6", 6, 12],
    ]),
    declaredSpeedWeighting: crossing([["fast", "gpt-5.6", 6, 12]]),
  });
  assert.equal(summary.coverage.observedEvents, 4);
  assert.equal(summary.coverage.declaredFromConfigEvents, 6);
  assert.equal(summary.coverage.assumedEvents, 0);
  assert.equal(summary.coverage.unknownEvents, 0);
  assert.equal(summary.weightingStatus, "complete");
  // Every one of the 20 Standard-priced dollars is weighted at the published
  // 2x, because observation and declaration both say Fast.
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 40);

  // A declaration covering only part of the unobserved remainder leaves the
  // rest to the scenario default; nothing is silently extended to it.
  const partial = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([["unknown", "gpt-5.4", 10, 20]]),
    declaredSpeedWeighting: crossing([["fast", "gpt-5.4", 4, 8]]),
  });
  assert.equal(partial.coverage.declaredFromConfigEvents, 4);
  assert.equal(partial.coverage.assumedEvents, 6);
  assert.equal(partial.coverage.unknownEvents, 0);
  // 8 USD at the published 2.0x plus the uncovered 12 USD assumed Standard.
  assert.equal(partial.quotaWeightedApiPriceEquivalentUsd, 28);
  assert.equal(partial.unweightedUnknownApiPriceEquivalentUsd, 0);
  assert.equal(partial.weightingStatus, "complete");

  // A declared crossing claiming more than the log left unobserved is
  // inconsistent, so it is discarded whole rather than trusted in part.
  const overclaimed = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([["unknown", "gpt-5.6", 2, 4]]),
    declaredSpeedWeighting: crossing([["fast", "gpt-5.6", 5, 10]]),
  });
  assert.equal(overclaimed.coverage.declaredFromConfigEvents, 0);
  assert.equal(overclaimed.coverage.assumedEvents, 2);
  // The discarded declaration degrades to exactly the pre-declaration
  // behaviour: the residual is assumed Standard at 1x.
  assert.equal(overclaimed.quotaWeightedApiPriceEquivalentUsd, 4);
});
