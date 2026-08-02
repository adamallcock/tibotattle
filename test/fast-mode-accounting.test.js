import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CODEX_SPEED_MODE_OBSERVABILITY,
  DEFAULT_FAST_MODE_PREFERENCE,
  FAST_MODE_MULTIPLIER_SOURCE,
  FAST_MODE_PREFERENCE_VALUES,
  FAST_MODE_QUOTA_MULTIPLIERS,
  FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS,
  QUOTA_WEIGHTED_API_PRICE_METRIC,
  emptySpeedWeightingCrossing,
  fastModeModelFamily,
  fastModeQuotaMultiplier,
  inferFastModeFromCalibrationWindows,
  quotaWeightedApiPriceEquivalent,
  resolveEffectiveSpeedMode,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";

import {
  FAST_MODE_PREFERENCE_SCHEMA_VERSION,
  FastModePreferenceError,
  createFastModePreferenceController,
} from "../src/fast-mode-preference.js";

function crossing(cells) {
  const value = emptySpeedWeightingCrossing();
  for (const [speed, family, events, usd] of cells) {
    value[speed][family] = { events, apiPriceEquivalentUsd: usd };
  }
  return value;
}

test("published Fast credit rates are frozen, sourced, and dated", () => {
  assert.deepEqual({ ...FAST_MODE_QUOTA_MULTIPLIERS }, {
    "gpt-5.6": 2.5,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
  });
  assert.equal(Object.isFrozen(FAST_MODE_QUOTA_MULTIPLIERS), true);
  assert.equal(FAST_MODE_MULTIPLIER_SOURCE.publisher, "openai");
  assert.equal(FAST_MODE_MULTIPLIER_SOURCE.recordedAt, "2026-08-01");
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
  assert.match(FAST_MODE_MULTIPLIER_SOURCE.statement, /2\.5x .*2x/u);
  assert.deepEqual([...FAST_MODE_PREFERENCE_VALUES], [
    "standard",
    "fast",
    "mixed_unknown",
  ]);
  assert.equal(DEFAULT_FAST_MODE_PREFERENCE, "standard");
});

test("model families match exactly and unsupported models stay an explicit unknown", () => {
  assert.equal(fastModeModelFamily("gpt-5.6-sol"), "gpt-5.6");
  assert.equal(fastModeQuotaMultiplier("gpt-5.6"), 2.5);
  assert.equal(fastModeQuotaMultiplier("gpt-5.5-codex"), 2.5);
  assert.equal(fastModeQuotaMultiplier("gpt-5.4-codex"), 2);
  // Never a silent 1.0: a model outside the published Fast families and a
  // near-miss name both resolve to null.
  for (const model of ["gpt-5.60", "gpt-5.4future", "gpt-4.1", "gpt-5", null]) {
    assert.equal(fastModeQuotaMultiplier(model), null);
  }
});

test("effective mode resolves observed, then preference, then inference, then unknown", () => {
  // An observed mode beats every stated preference and any inference.
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "standard",
      preference: "fast",
      inferredMode: "fast",
    }),
    { mode: "standard", provenance: "observed" },
  );
  // An explicit preference beats inference, so inference can never override it.
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "unknown",
      preference: "standard",
      inferredMode: "fast",
    }),
    { mode: "standard", provenance: "assumed_from_preference" },
  );
  // Only "mixed_unknown" leaves room for inference.
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "unknown",
      preference: "mixed_unknown",
      inferredMode: "fast",
    }),
    { mode: "fast", provenance: "inferred" },
  );
  assert.deepEqual(
    resolveEffectiveSpeedMode({
      observedMode: "unknown",
      preference: "mixed_unknown",
    }),
    { mode: "unknown", provenance: "unknown" },
  );
});

test("weighting multiplies only Fast events and refuses unknown multipliers", () => {
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-5.6-sol",
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
  assert.deepEqual(
    quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4,
      model: "gpt-4.1",
      mode: "fast",
    }),
    { usd: null, multiplier: null, status: "unknown_multiplier" },
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

test("observed Fast is weighted even when the owner states Standard", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([
      ["fast", "gpt-5.6", 4, 10],
      ["standard", "gpt-5.4", 2, 5],
    ]),
    preference: "standard",
  });
  assert.equal(summary.standardApiPriceEquivalentUsd, 15);
  // 10 x 2.5 observed Fast + 5 observed Standard.
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 30);
  assert.equal(summary.weightingStatus, "complete");
  assert.deepEqual({ ...summary.appliedMultipliers }, { "gpt-5.6": 2.5 });
  assert.equal(summary.coverage.observedEvents, 6);
  assert.equal(summary.coverage.assumedFromPreferenceEvents, 0);
  assert.equal(summary.coverage.unknownEvents, 0);
  assert.equal(summary.metric.key, "quotaWeightedApiPriceEquivalentUsd");
  assert.equal(
    summary.metric.label,
    QUOTA_WEIGHTED_API_PRICE_METRIC.label,
  );
});

test("an unrecorded mode is weighted from the preference and never defaults to one times", () => {
  const cells = crossing([
    ["unknown", "gpt-5.5", 3, 8],
    ["unknown", "unsupported", 1, 2],
  ]);
  const standard = summarizeQuotaWeightedAccounting({
    speedWeighting: cells,
    preference: "standard",
  });
  assert.equal(standard.quotaWeightedApiPriceEquivalentUsd, 10);
  assert.equal(standard.coverage.assumedFromPreferenceEvents, 4);
  assert.equal(standard.weightingStatus, "complete");

  const fast = summarizeQuotaWeightedAccounting({
    speedWeighting: cells,
    preference: "fast",
  });
  // 8 x 2.5 is weighted; the unsupported model's $2 is excluded rather than
  // being silently counted at the Standard rate.
  assert.equal(fast.quotaWeightedApiPriceEquivalentUsd, 20);
  assert.equal(fast.unweightedUnknownApiPriceEquivalentUsd, 2);
  assert.equal(fast.weightingStatus, "partial");

  const mixed = summarizeQuotaWeightedAccounting({
    speedWeighting: cells,
    preference: "mixed_unknown",
  });
  assert.equal(mixed.quotaWeightedApiPriceEquivalentUsd, null);
  assert.equal(mixed.weightingStatus, "unknown");
  assert.equal(mixed.coverage.unknownEvents, 4);
  assert.equal(mixed.coverage.unknownSharePercent, 100);
});

test("coverage reports observed, assumed, inferred and remaining unknown shares", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([
      ["fast", "gpt-5.6", 2, 4],
      ["standard", "gpt-5.6", 2, 4],
      ["unknown", "gpt-5.6", 6, 12],
    ]),
    preference: "mixed_unknown",
    inferredFastEvents: 4,
    inference: { status: "inferred", inferredFastWindowCount: 2 },
  });
  assert.deepEqual({ ...summary.coverage }, {
    totalEvents: 10,
    observedEvents: 4,
    assumedFromPreferenceEvents: 0,
    inferredEvents: 4,
    unknownEvents: 2,
    observedSharePercent: 40,
    unknownSharePercent: 20,
  });
  // Inference labels windows, so it never moves the weighted total.
  assert.equal(summary.inference.appliedToWeighting, false);
  assert.equal(summary.inference.inferredFastWindows, 2);
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 14);
});

test("inferred event counts can never exceed the unknown events they reclassify", () => {
  const summary = summarizeQuotaWeightedAccounting({
    speedWeighting: crossing([["unknown", "gpt-5.6", 3, 6]]),
    preference: "mixed_unknown",
    inferredFastEvents: 99,
  });
  assert.equal(summary.coverage.inferredEvents, 3);
  assert.equal(summary.coverage.unknownEvents, 0);
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

test("the owner-only preference round-trips and refuses unknown values", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-mode-preference-"));
  try {
    const settingsFile = join(root, "private", "fast-mode-preference-v0.1.json");
    const controller = createFastModePreferenceController({ settingsFile });
    const initial = await controller.inspect();
    assert.equal(initial.mode, "standard");
    assert.equal(initial.source, "default");
    assert.equal(initial.appliesTo, "turns_with_no_observed_tier_only");
    assert.equal(initial.logObservability.sessionBaselineRecorded, false);
    assert.deepEqual(initial.multipliers, { ...FAST_MODE_QUOTA_MULTIPLIERS });

    const selected = await controller.select("fast");
    assert.equal(selected.mode, "fast");
    assert.equal(selected.source, "stated");
    assert.equal(selected.schemaVersion, FAST_MODE_PREFERENCE_SCHEMA_VERSION);
    assert.equal(await controller.readMode(), "fast");

    const stored = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), [
      "mode",
      "recordedAt",
      "schemaVersion",
    ]);
    assert.equal(stored.schemaVersion, FAST_MODE_PREFERENCE_SCHEMA_VERSION);

    await assert.rejects(
      () => controller.select("turbo"),
      (error) => error instanceof FastModePreferenceError
        && error.code === "fast_mode_preference_invalid",
    );
    // The rejected write left the stored statement untouched.
    assert.equal(await controller.readMode(), "fast");

    // A malformed document is an explicit failure, and the mode reader
    // degrades to Standard rather than inventing a Fast attribution.
    await writeFile(settingsFile, "{\"mode\":\"fast\"}\n", { mode: 0o600 });
    await assert.rejects(
      () => controller.inspect(),
      (error) => error.code === "fast_mode_preference_unavailable",
    );
    assert.equal(await controller.readMode(), "standard");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
