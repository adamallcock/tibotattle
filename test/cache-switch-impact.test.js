import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codexPrimaryAllowanceBasis,
} from "../src/codex-primary-allowance-basis.js";

import {
  analyzeCacheContinuityRows,
  analyzeCacheSwitchRows,
  CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS,
  CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
  MAX_CACHE_SWITCH_RECENT_DETAILS,
} from "../src/cache-switch-impact.js";
import {
  cacheSwitchAllowanceImpact,
} from "../src/local-companion-data.js";
import {
  readLocalUnifiedCompanionProjection,
} from "../src/local-unified-companion-source.js";
import {
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  reasoningEffortOrdinal,
} from "../src/local-unified-index.js";

const NOW_MS = Date.parse("2026-08-08T12:00:00.000Z");

function usdFromNanos(value) {
  const whole = Math.floor(value / 1_000_000_000);
  const fraction = String(value % 1_000_000_000)
    .padStart(9, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

function fullyPriced(_event, components) {
  const nanos = components.input_uncached_tokens * 10
    + components.input_cache_read_tokens
    + components.input_cache_write_tokens * 12
    + components.output_text_tokens * 20
    + components.output_reasoning_tokens * 20
    + components.output_combined_tokens * 20;
  return {
    coverageStatus: "fully_priced",
    totalUsd: usdFromNanos(nanos),
  };
}

function row(overrides = {}) {
  return {
    observed_at_ms: NOW_MS - 60_000,
    previous_observed_at_ms: NOW_MS - 120_000,
    model_id: "gpt-5.6-sol",
    model_recognition: "recognized",
    previous_model_id: "gpt-5.6-sol",
    previous_model_recognition: "recognized",
    reasoning_effort: reasoningEffortOrdinal("max"),
    previous_reasoning_effort: reasoningEffortOrdinal("high"),
    tokens_in_uncached: 800,
    tokens_in_cache_read: 0,
    tokens_in_cache_write: 300,
    previous_tokens_in_cache_read: 1_000,
    parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    previous_parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    tier_id: 1,
    previous_tier_id: 1,
    surface_id: 1,
    previous_surface_id: 1,
    compaction_between: 0,
    turn_context_between: 1,
    tokens_out_text: 0,
    tokens_out_reasoning: 0,
    tokens_out_combined: 0,
    ...overrides,
  };
}

function continuityRow(overrides = {}) {
  return row({
    observed_at_ms: NOW_MS - 60_000,
    previous_observed_at_ms:
      NOW_MS - 60_000 - 30 * 60_000,
    previous_reasoning_effort: reasoningEffortOrdinal("max"),
    reasoning_effort: reasoningEffortOrdinal("ultra"),
    tokens_in_uncached: 1_000,
    tokens_in_cache_read: 0,
    tokens_in_cache_write: 0,
    previous_tokens_in_cache_read: 1_000,
    ...overrides,
  });
}

function premiumScenario(scenario, premium, overrides = {}) {
  const basis = codexPrimaryAllowanceBasis(scenario);
  return {
    basisId: basis.basisId,
    basisFamilyId: basis.basisFamilyId,
    quotaWeightedPremiumUsd: premium,
    pricedDrops: 1,
    observedSpeedDrops: 0,
    declaredSpeedDrops: 0,
    assumedSpeedDrops: 1,
    unknownSpeedDrops: 0,
    ...overrides,
  };
}

function capacityScenario(scenario, median, lower, upper) {
  return {
    basisId: codexPrimaryAllowanceBasis(scenario).basisId,
    medianCapacityUsd: median,
    plausibleRangeUsd: { lower, upper },
  };
}

function allowanceCapacity(selectedScenario = "unresolved_as_standard") {
  return {
    status: selectedScenario === null ? "range" : "available",
    reason: null,
    basisFamilyId: codexPrimaryAllowanceBasis(
      "unresolved_as_standard",
    ).basisFamilyId,
    selectedScenario,
    scenarios: {
      unresolved_as_standard: capacityScenario(
        "unresolved_as_standard",
        100,
        80,
        125,
      ),
      unresolved_as_fast: capacityScenario(
        "unresolved_as_fast",
        200,
        160,
        250,
      ),
    },
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  };
}

test("analyzer classifies effective changes and prices the conservative warm counterfactual", () => {
  const calls = [];
  const projection = analyzeCacheSwitchRows([row()], {
    nowMs: NOW_MS,
    pricer(event, components) {
      calls.push({ event, components: { ...components } });
      return fullyPriced(event, components);
    },
  });
  const period = projection.periods.find((candidate) => candidate.periodId === "7d");

  assert.equal(projection.maximumRetainedCacheRatio, 0.5);
  assert.equal(period.configurationChanges, 1);
  assert.equal(period.proximateConfigurationChanges, 1);
  assert.equal(period.cacheReadDrops, 1);
  assert.equal(period.lostCacheTokens, 1_000);
  assert.equal(period.estimatedPremiumUsdExact, "0.0000094");
  assert.equal(period.standardApiPremiumUsd, 0.0000094);
  assert.equal(
    period.allowanceWeighting.scenarios.unresolved_as_standard
      .quotaWeightedPremiumUsd,
    0.0000094,
  );
  assert.equal(
    period.allowanceWeighting.scenarios.unresolved_as_fast
      .quotaWeightedPremiumUsd,
    0.0000188,
  );
  assert.equal(
    period.allowanceWeighting.scenarios.unresolved_as_standard
      .assumedSpeedDrops,
    1,
  );
  assert.equal(period.byChangeType.reasoning_only.cacheReadDrops, 1);
  assert.equal(period.byChangeType.model_only.cacheReadDrops, 0);
  assert.deepEqual(calls[1].components, {
    input_uncached_tokens: 0,
    input_cache_read_tokens: 1_000,
    input_cache_write_tokens: 100,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
    output_combined_tokens: 0,
  });
  assert.deepEqual(Object.keys(period.recent[0]).sort(), [
    "changeType",
    "current",
    "currentCacheReadTokens",
    "estimatedPremiumUsd",
    "estimatedPremiumUsdExact",
    "gapSeconds",
    "lostCacheTokens",
    "observedAt",
    "previous",
    "previousCacheReadTokens",
  ]);
});

test("cache premiums preserve observed speed, then declarations, then scenario fallback", () => {
  const rows = [
    row({
      observed_at_ms: NOW_MS - 80_000,
      previous_observed_at_ms: NOW_MS - 90_000,
      codex_speed_mode: "standard",
    }),
    row({
      observed_at_ms: NOW_MS - 60_000,
      previous_observed_at_ms: NOW_MS - 70_000,
      codex_speed_mode: "fast",
    }),
    row({
      observed_at_ms: NOW_MS - 40_000,
      previous_observed_at_ms: NOW_MS - 50_000,
      codex_speed_mode: "unknown",
    }),
    row({
      observed_at_ms: NOW_MS - 20_000,
      previous_observed_at_ms: NOW_MS - 30_000,
      codex_speed_mode: "unknown",
    }),
  ];
  const period = analyzeCacheSwitchRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
    declaredSpeedBaselines: [{
      firstSeenAt: new Date(NOW_MS - 45_000).toISOString(),
      lastSeenAt: new Date(NOW_MS - 35_000).toISOString(),
      mode: "fast",
    }],
  }).periods.find((candidate) => candidate.periodId === "7d");
  const standard = period.allowanceWeighting
    .scenarios.unresolved_as_standard;
  const fast = period.allowanceWeighting.scenarios.unresolved_as_fast;

  assert.equal(period.standardApiPremiumUsd, 0.0000376);
  // 1x observed Standard + 2x observed Fast + 2x declared Fast + the
  // scenario-attributed drop: x6 of one drop under the Standard scenario and
  // x7 under the Fast scenario, at the published GPT-5.6 ratio of 2.
  assert.equal(standard.quotaWeightedPremiumUsd, 0.0000564);
  assert.equal(fast.quotaWeightedPremiumUsd, 0.0000658);
  assert.deepEqual([
    standard.observedSpeedDrops,
    standard.declaredSpeedDrops,
    standard.assumedSpeedDrops,
    standard.unknownSpeedDrops,
  ], [2, 1, 1, 0]);
  assert.deepEqual([
    fast.observedSpeedDrops,
    fast.declaredSpeedDrops,
    fast.assumedSpeedDrops,
    fast.unknownSpeedDrops,
  ], [2, 1, 1, 0]);
});

test("material-collapse gate excludes a near-warm switch-back and includes exactly half retained", () => {
  const nearWarm = row({
    previous_tokens_in_cache_read: 115_456,
    tokens_in_cache_read: 114_432,
    tokens_in_uncached: 1_024,
    tokens_in_cache_write: 0,
  });
  const halfRetained = row({
    observed_at_ms: NOW_MS - 30_000,
    previous_observed_at_ms: NOW_MS - 60_000,
    previous_tokens_in_cache_read: 1_000,
    tokens_in_cache_read: 500,
    tokens_in_uncached: 500,
    tokens_in_cache_write: 0,
  });
  const period = analyzeCacheSwitchRows([nearWarm, halfRetained], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");

  assert.equal(CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO, 0.5);
  assert.equal(period.configurationChanges, 2);
  assert.equal(period.proximateConfigurationChanges, 2);
  assert.equal(period.cacheReadDrops, 1);
  assert.equal(period.lostCacheTokens, 500);
  assert.equal(period.recent.length, 1);
  assert.equal(period.recent[0].currentCacheReadTokens, 500);
});

test("Max and Ultra share one effective effort while model and combined changes stay distinct", () => {
  const maxUltra = row({
    previous_reasoning_effort: reasoningEffortOrdinal("max"),
    reasoning_effort: reasoningEffortOrdinal("ultra"),
  });
  const modelOnly = row({
    observed_at_ms: NOW_MS - 40_000,
    previous_observed_at_ms: NOW_MS - 50_000,
    previous_model_id: "gpt-5.6-terra",
    previous_reasoning_effort: reasoningEffortOrdinal("ultra"),
    reasoning_effort: reasoningEffortOrdinal("max"),
  });
  const combined = row({
    observed_at_ms: NOW_MS - 20_000,
    previous_observed_at_ms: NOW_MS - 30_000,
    previous_model_id: "gpt-5.6-terra",
    previous_reasoning_effort: reasoningEffortOrdinal("high"),
    reasoning_effort: reasoningEffortOrdinal("max"),
  });
  const period = analyzeCacheSwitchRows([maxUltra, modelOnly, combined], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "all");

  assert.equal(period.configurationChanges, 2);
  assert.equal(period.byChangeType.model_only.configurationChanges, 1);
  assert.equal(period.byChangeType.model_and_reasoning.configurationChanges, 1);
  assert.equal(period.byChangeType.reasoning_only.configurationChanges, 0);
});

test("long gaps, missing prior cache, malformed dimensions, and unpriced drops fail closed", () => {
  const longGap = row({
    previous_observed_at_ms: NOW_MS - 10 * 60_000,
  });
  const noPriorCache = row({
    observed_at_ms: NOW_MS - 40_000,
    previous_observed_at_ms: NOW_MS - 50_000,
    previous_tokens_in_cache_read: 0,
  });
  const unknownEffort = row({
    observed_at_ms: NOW_MS - 30_000,
    previous_observed_at_ms: NOW_MS - 40_000,
    previous_reasoning_effort: reasoningEffortOrdinal("unknown"),
  });
  const unpriced = row({
    observed_at_ms: NOW_MS - 20_000,
    previous_observed_at_ms: NOW_MS - 30_000,
  });
  const malformed = row({
    observed_at_ms: String(NOW_MS - 10_000),
    previous_reasoning_effort: null,
  });
  const period = analyzeCacheSwitchRows(
    [longGap, noPriorCache, unknownEffort, null, malformed, unpriced],
    {
      nowMs: NOW_MS,
      pricer() {
        return { coverageStatus: "unpriced", totalUsd: "0" };
      },
    },
  ).periods.find((candidate) => candidate.periodId === "all");

  assert.equal(period.configurationChanges, 3);
  assert.equal(period.proximateConfigurationChanges, 2);
  assert.equal(period.cacheReadDrops, 1);
  assert.equal(period.pricedDrops, 0);
  assert.equal(period.unpricedDrops, 1);
  assert.equal(period.estimatedPremiumUsd, null);
  assert.equal(period.estimatedPremiumUsdExact, null);
});

test("unobserved or malformed input components never become observed cache drops", () => {
  const rows = [
    row({ tokens_in_cache_read: null }),
    row({ previous_tokens_in_cache_read: null }),
    row({ tokens_in_uncached: null }),
    row({ tokens_in_cache_write: null }),
    row({ tokens_in_cache_read: -1 }),
    row({ tokens_in_uncached: 0.5 }),
  ].map((candidate, index) => ({
    ...candidate,
    observed_at_ms: NOW_MS - (index + 1) * 10_000,
    previous_observed_at_ms: NOW_MS - (index + 1) * 10_000 - 1_000,
  }));
  const period = analyzeCacheSwitchRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");

  assert.equal(period.configurationChanges, rows.length);
  assert.equal(period.proximateConfigurationChanges, rows.length);
  assert.equal(period.cacheReadDrops, 0);
  assert.equal(period.lostCacheTokens, 0);
  assert.deepEqual(period.recent, []);
});

test("recent evidence is newest-first, bounded, and carries no index identifiers", () => {
  const rows = Array.from(
    { length: MAX_CACHE_SWITCH_RECENT_DETAILS + 7 },
    (_, index) => row({
      observed_at_ms: NOW_MS - (MAX_CACHE_SWITCH_RECENT_DETAILS + 7 - index) * 1_000,
      previous_observed_at_ms:
        NOW_MS - (MAX_CACHE_SWITCH_RECENT_DETAILS + 8 - index) * 1_000,
    }),
  );
  const period = analyzeCacheSwitchRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "all");
  const serialized = JSON.stringify(period.recent);

  assert.equal(period.recent.length, MAX_CACHE_SWITCH_RECENT_DETAILS);
  assert.ok(period.recent[0].observedAt > period.recent.at(-1).observedAt);
  assert.doesNotMatch(serialized, /session|event_key|eventKey|session_local/u);
});

test("continuity lens prices a same-configuration new-turn return and bands its age", () => {
  const projection = analyzeCacheContinuityRows([continuityRow()], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  });
  const period = projection.periods.find((candidate) => candidate.periodId === "7d");

  assert.equal(projection.minimumGapSeconds, 0);
  assert.equal(period.coverageStatus, "complete");
  assert.equal(period.sameConfigurationReturns, 1);
  assert.equal(period.comparableReturns, 1);
  assert.equal(period.cacheReadDrops, 1);
  assert.equal(period.lostCacheTokens, 1_000);
  assert.equal(period.estimatedPremiumUsdExact, "0.000009");
  assert.equal(
    period.byGapBand.thirty_minutes_to_one_hour.cacheReadDrops,
    1,
  );
  assert.equal(period.postCompactionRequests, 0);
  assert.deepEqual(Object.keys(period.recent[0]).sort(), [
    "configuration",
    "currentCacheReadTokens",
    "estimatedPremiumUsd",
    "estimatedPremiumUsdExact",
    "gapBand",
    "gapSeconds",
    "lostCacheTokens",
    "observedAt",
    "previousCacheReadTokens",
  ]);
  assert.equal(period.recent[0].configuration.reasoningEffort, "ultra");
  assert.doesNotMatch(JSON.stringify(period.recent), /session|event_key|tier_id/u);
});

test("continuity gap bands use exact half-open boundaries without an age floor", () => {
  const boundaries = [
    ["under_one_minute", 0],
    ["one_to_five_minutes", 60_000],
    ["five_to_thirty_minutes", 5 * 60_000],
    ["thirty_minutes_to_one_hour", 30 * 60_000],
    ["one_to_six_hours", 60 * 60_000],
    ["six_to_twenty_four_hours", 6 * 60 * 60_000],
    ["over_twenty_four_hours", 24 * 60 * 60_000],
  ];
  const rows = boundaries.map(([, gapMs], index) => {
    const observedAt = NOW_MS - index * 1_000;
    return continuityRow({
      observed_at_ms: observedAt,
      previous_observed_at_ms: observedAt - gapMs,
    });
  });
  const period = analyzeCacheContinuityRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");

  assert.equal(period.cacheReadDrops, boundaries.length);
  for (const [gapBand] of boundaries) {
    assert.equal(period.byGapBand[gapBand].cacheReadDrops, 1, gapBand);
  }
});

test("continuity outcome raster uses ten fixed human time buckets", () => {
  const boundaries = [
    ["under_one_minute", 0, 0, 60],
    ["one_to_two_minutes", 60_000, 60, 120],
    ["two_to_five_minutes", 2 * 60_000, 120, 300],
    ["five_to_ten_minutes", 5 * 60_000, 300, 600],
    ["ten_to_thirty_minutes", 10 * 60_000, 600, 1_800],
    ["thirty_minutes_to_one_hour", 30 * 60_000, 1_800, 3_600],
    ["one_to_six_hours", 60 * 60_000, 3_600, 21_600],
    ["six_to_twenty_four_hours", 6 * 60 * 60_000, 21_600, 86_400],
    ["one_to_three_days", 24 * 60 * 60_000, 86_400, 259_200],
    ["over_three_days", 3 * 24 * 60 * 60_000, 259_200, null],
  ];
  const rows = boundaries.map(([, gapMs], index) => {
    const observedAt = NOW_MS - index * 1_000;
    return continuityRow({
      observed_at_ms: observedAt,
      previous_observed_at_ms: observedAt - gapMs,
    });
  });
  const projection = analyzeCacheContinuityRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  });
  const period = projection.periods.find(
    (candidate) => candidate.periodId === "24h",
  );

  assert.equal(
    projection.outcomeDisplayMaximumGapSeconds,
    CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS / 1_000,
  );
  assert.deepEqual(Object.keys(period.byOutcomeBucket), boundaries.map(
    ([id]) => id,
  ));
  for (const [id, , startSeconds, endSeconds] of boundaries) {
    assert.equal(period.byOutcomeBucket[id].startSeconds, startSeconds, id);
    assert.equal(period.byOutcomeBucket[id].endSeconds, endSeconds, id);
    assert.equal(period.byOutcomeBucket[id].comparableReturns, 1, id);
    assert.equal(period.byOutcomeBucket[id].reusedHalfOrLessReturns, 1, id);
  }
});

test("continuity outcomes partition checked follow-ups at the exact half boundary", () => {
  const outcomes = [
    { cacheRead: 1_200, uncached: 0 },
    { cacheRead: 1_000, uncached: 0 },
    { cacheRead: 750, uncached: 250 },
    { cacheRead: 500, uncached: 500 },
    { cacheRead: 0, uncached: 1_000 },
  ];
  const rows = outcomes.map(({ cacheRead, uncached }, index) => {
    const observedAt = NOW_MS - index * 1_000;
    return continuityRow({
      observed_at_ms: observedAt,
      previous_observed_at_ms: observedAt - 2 * 60_000,
      tokens_in_cache_read: cacheRead,
      tokens_in_uncached: uncached,
    });
  });
  const period = analyzeCacheContinuityRows(rows, {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");
  const bucket = period.byOutcomeBucket.two_to_five_minutes;

  assert.equal(period.comparableReturns, 5);
  assert.equal(period.reusedMoreThanHalfReturns, 3);
  assert.equal(period.reusedHalfOrLessReturns, 2);
  assert.equal(period.matchedOrExceededReturns, 2);
  assert.equal(period.reusedBetweenHalfAndPreviousReturns, 1);
  assert.equal(period.cacheReadDrops, 2);
  assert.equal(bucket.comparableReturns, 5);
  assert.equal(bucket.reusedMoreThanHalfReturns, 3);
  assert.equal(bucket.reusedHalfOrLessReturns, 2);
});

test("continuity lens has no timing floor, requires a turn boundary, and separates confounders", () => {
  const shortGap = continuityRow({
    observed_at_ms: NOW_MS - 10_000,
    previous_observed_at_ms: NOW_MS - 40_000,
  });
  const sameAgentTurn = continuityRow({
    observed_at_ms: NOW_MS - 20_000,
    previous_observed_at_ms: NOW_MS - 40 * 60_000,
    turn_context_between: 0,
  });
  const routingChanged = continuityRow({
    observed_at_ms: NOW_MS - 30_000,
    previous_observed_at_ms: NOW_MS - 50 * 60_000,
    previous_tier_id: 2,
  });
  const compacted = continuityRow({
    observed_at_ms: NOW_MS - 40_000,
    previous_observed_at_ms: NOW_MS - 60 * 60_000,
    compaction_between: 1,
  });
  const contracted = continuityRow({
    observed_at_ms: NOW_MS - 50_000,
    previous_observed_at_ms: NOW_MS - 70 * 60_000,
    tokens_in_uncached: 500,
  });
  const insufficient = continuityRow({
    observed_at_ms: NOW_MS - 60_000,
    previous_observed_at_ms: NOW_MS - 80 * 60_000,
    previous_tokens_in_cache_read: 0,
  });
  const warm = continuityRow({
    observed_at_ms: NOW_MS - 70_000,
    previous_observed_at_ms: NOW_MS - 90 * 60_000,
    tokens_in_uncached: 200,
    tokens_in_cache_read: 800,
  });
  const period = analyzeCacheContinuityRows([
    shortGap,
    sameAgentTurn,
    routingChanged,
    compacted,
    contracted,
    insufficient,
    warm,
  ], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");

  assert.equal(period.sameConfigurationReturns, 5);
  assert.equal(period.comparableReturns, 2);
  assert.equal(period.compactionConfoundedReturns, 1);
  assert.equal(period.contextContractedReturns, 1);
  assert.equal(period.insufficientEvidenceReturns, 1);
  assert.equal(period.uncoveredReturns, 0);
  assert.equal(period.cacheReadDrops, 1);
  assert.ok(period.estimatedPremiumUsd > 0);
  assert.equal(period.byGapBand.under_one_minute.cacheReadDrops, 1);
  assert.equal(period.postCompactionRequests, 1);
  assert.equal(period.postCompactionCacheReadDrops, 1);
});

test("older parser coverage withholds both continuity and switch premiums", () => {
  const oldContinuity = continuityRow({
    parser_version: "unified-rollout-typed-v2",
    previous_parser_version: "unified-rollout-typed-v2",
  });
  const continuity = analyzeCacheContinuityRows([oldContinuity], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "all");
  assert.equal(continuity.coverageStatus, "incomplete");
  assert.equal(continuity.uncoveredReturns, 1);
  assert.equal(continuity.cacheReadDrops, 0);
  assert.equal(continuity.estimatedPremiumUsd, null);
  assert.equal(continuity.coveredSubtotal, null);

  const oldSwitch = row({
    parser_version: "unified-rollout-typed-v2",
    previous_parser_version: "unified-rollout-typed-v2",
  });
  const switched = analyzeCacheSwitchRows([oldSwitch], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "all");
  assert.equal(switched.coverageStatus, "incomplete");
  assert.equal(switched.uncoveredConfigurationChanges, 1);
  assert.equal(switched.cacheReadDrops, 0);
  assert.equal(switched.estimatedPremiumUsd, null);
  assert.equal(switched.coveredSubtotal, null);
});

for (const [name, analyze, makeRow, premiumNanos] of [
  ["switch", analyzeCacheSwitchRows, row, 9_400],
  ["continuity", analyzeCacheContinuityRows, continuityRow, 9_000],
]) {
  test(`${name} covered subtotal survives an excluded comparison without becoming the period total`, () => {
    const period = analyze([
      makeRow({ codex_speed_mode: "fast" }),
      makeRow({ parser_version: "unified-rollout-typed-v2" }),
    ], { nowMs: NOW_MS, pricer: fullyPriced }).periods.find(
      (candidate) => candidate.periodId === "7d",
    );
    assert.equal(period.coverageStatus, "incomplete");
    assert.equal(period.cacheReadDrops, 1);
    assert.equal(period.estimatedPremiumUsd, null);
    assert.equal(period.standardApiPremiumUsd, null);
    assert.equal(period.allowanceWeighting.status, "unavailable");
    assert.equal(period.coveredSubtotal.scope, "covered_priced_drops");
    assert.equal(period.coveredSubtotal.pricedDrops, 1);
    assert.equal(period.coveredSubtotal.standardApiPremiumUsdExact, usdFromNanos(premiumNanos));
    for (const scenario of Object.values(period.coveredSubtotal.allowanceWeighting.scenarios)) {
      assert.equal(scenario.status, "complete");
      assert.equal(scenario.quotaWeightedPremiumUsd, premiumNanos * 2 / 1_000_000_000);
      assert.equal(scenario.observedSpeedDrops, 1);
      assert.equal(scenario.pricedDrops, 1);
    }
    const partitions = name === "switch"
      ? [period.byChangeType]
      : [period.byGapBand, period.byOutcomeBucket];
    for (const partition of partitions) {
      const covered = Object.values(partition).filter((part) => part.coveredSubtotal !== null);
      assert.equal(covered.length, 1);
      assert.deepEqual(covered[0].coveredSubtotal, period.coveredSubtotal);
      assert.equal(covered[0].estimatedPremiumUsd, null);
    }
    assert.equal(period.recent.length, 1);
  });

  test(`${name} subtotal excludes partial prices on either side and never invents an unpriced zero`, () => {
    for (const unpricedSide of ["actual", "counterfactual", "both"]) {
      const unpricedAt = NOW_MS - 30_000;
      const pricer = (event, components) => {
        const omit = event.timestamp === new Date(unpricedAt).toISOString()
          && (unpricedSide === "both"
            || (unpricedSide === "actual" && components.input_cache_read_tokens === 0)
            || (unpricedSide === "counterfactual" && components.input_cache_read_tokens > 0));
        return omit
          ? { coverageStatus: "partially_priced", totalUsd: "0" }
          : fullyPriced(event, components);
      };
      const good = makeRow({ codex_speed_mode: "standard" });
      const unknownPrice = makeRow({ observed_at_ms: unpricedAt, codex_speed_mode: "fast" });
      const period = analyze([good, unknownPrice], { nowMs: NOW_MS, pricer }).periods.find(
        (candidate) => candidate.periodId === "7d",
      );
      assert.equal(period.coverageStatus, "complete", unpricedSide);
      assert.equal(period.cacheReadDrops, 2, unpricedSide);
      assert.equal(period.pricedDrops, 1, unpricedSide);
      assert.equal(period.unpricedDrops, 1, unpricedSide);
      assert.equal(period.estimatedPremiumUsd, null, unpricedSide);
      assert.equal(period.allowanceWeighting.status, "unavailable", unpricedSide);
      assert.equal(period.coveredSubtotal.standardApiPremiumUsdExact, usdFromNanos(premiumNanos));
      for (const scenario of Object.values(period.coveredSubtotal.allowanceWeighting.scenarios)) {
        assert.equal(scenario.pricedDrops, 1, unpricedSide);
        assert.equal(scenario.observedSpeedDrops, 1, unpricedSide);
        assert.equal(scenario.quotaWeightedPremiumUsd, premiumNanos / 1_000_000_000, unpricedSide);
      }
      const allUnpriced = analyze([unknownPrice], { nowMs: NOW_MS, pricer }).periods.find(
        (candidate) => candidate.periodId === "7d",
      );
      assert.equal(allUnpriced.coveredSubtotal, null, unpricedSide);
      assert.equal(allUnpriced.estimatedPremiumUsd, null, unpricedSide);
    }
    for (const rows of [[], [makeRow({ previous_tokens_in_cache_read: 0 })]]) {
      const period = analyze(rows, { nowMs: NOW_MS, pricer: fullyPriced }).periods[0];
      assert.equal(period.cacheReadDrops, 0);
      assert.equal(period.coveredSubtotal, null);
    }
    // A fully priced zero is different from absent or partial pricing.
    const free = analyze([makeRow()], {
      nowMs: NOW_MS,
      pricer: () => ({ coverageStatus: "fully_priced", totalUsd: "0" }),
    }).periods[0];
    assert.equal(free.coveredSubtotal.pricedDrops, 1);
    assert.equal(free.coveredSubtotal.standardApiPremiumUsd, 0);
    assert.equal(free.coveredSubtotal.standardApiPremiumUsdExact, "0");
  });

  test(`${name} subtotal uses all exact admitted drops, not the capped recent rows or another period`, () => {
    const numberOfDrops = MAX_CACHE_SWITCH_RECENT_DETAILS + 7;
    const rows = Array.from({ length: numberOfDrops }, (_, index) => makeRow({
      observed_at_ms: NOW_MS - (index + 1) * 60_000,
      previous_observed_at_ms: NOW_MS - (index + 2) * 60_000,
    }));
    const oldAt = NOW_MS - 20 * 24 * 60 * 60_000;
    rows.push(makeRow({
      observed_at_ms: oldAt,
      previous_observed_at_ms: oldAt - 60_000,
    }));
    rows.push(makeRow({ parser_version: "unified-rollout-typed-v2" }));
    const result = analyze(rows, { nowMs: NOW_MS, pricer: fullyPriced });
    for (const period of result.periods) {
      const expectedDrops = ["24h", "7d"].includes(period.periodId)
        ? numberOfDrops : numberOfDrops + 1;
      assert.equal(period.estimatedPremiumUsd, null, period.periodId);
      assert.equal(period.recent.length, MAX_CACHE_SWITCH_RECENT_DETAILS, period.periodId);
      assert.equal(period.coveredSubtotal.pricedDrops, expectedDrops, period.periodId);
      assert.equal(
        period.coveredSubtotal.standardApiPremiumUsdExact,
        usdFromNanos(premiumNanos * expectedDrops),
        period.periodId,
      );
      assert.equal(
        period.coveredSubtotal.allowanceWeighting.scenarios.unresolved_as_standard.pricedDrops,
        expectedDrops,
        period.periodId,
      );
      assert.ok(period.coveredSubtotal.standardApiPremiumUsd > period.recent.reduce(
        (sum, detail) => sum + detail.estimatedPremiumUsd, 0,
      ));
    }
  });
}

test("context contraction and compaction prevent a switch premium", () => {
  const compacted = row({ compaction_between: 1 });
  const contracted = row({ tokens_in_uncached: 400, tokens_in_cache_write: 0 });
  const period = analyzeCacheSwitchRows([compacted, contracted], {
    nowMs: NOW_MS,
    pricer: fullyPriced,
  }).periods.find((candidate) => candidate.periodId === "24h");
  assert.equal(period.configurationChanges, 2);
  assert.equal(period.proximateConfigurationChanges, 2);
  assert.equal(period.cacheReadDrops, 0);
  assert.equal(period.estimatedPremiumUsd, 0);
});

test("allowance translation couples each weighted premium to its matching capacity", () => {
  const standard = premiumScenario("unresolved_as_standard", 5);
  const fast = premiumScenario("unresolved_as_fast", 12.5);
  const fixedWeighting = {
    status: "complete",
    reasonCode: null,
    basisFamilyId: standard.basisFamilyId,
    selectedScenario: "unresolved_as_standard",
    selectedPremiumUsd: 5,
    scenarios: {
      unresolved_as_standard: standard,
      unresolved_as_fast: fast,
    },
    rangePremiumUsd: null,
  };
  const fixed = cacheSwitchAllowanceImpact(
    { periodId: "7d", allowanceWeighting: fixedWeighting },
    allowanceCapacity(),
  );
  assert.equal(fixed.status, "complete");
  for (const [coverageStatus, unpricedDrops, reason] of [
    ["incomplete", 0, "weighting_evidence_incomplete"],
    ["complete", 1, "price_coverage_incomplete"],
  ]) {
    const subsetPromotedToTotal = cacheSwitchAllowanceImpact({
      periodId: "7d",
      coverageStatus,
      unpricedDrops,
      allowanceWeighting: fixedWeighting,
      coveredSubtotal: {
        scope: "covered_priced_drops",
        allowanceWeighting: fixedWeighting,
      },
    }, allowanceCapacity());
    assert.equal(subsetPromotedToTotal.status, "unavailable");
    assert.equal(subsetPromotedToTotal.reason, reason);
    assert.equal(subsetPromotedToTotal.medianPercentagePoints, null);
  }
  assert.equal(fixed.selectedScenario, "unresolved_as_standard");
  assert.equal(fixed.medianPercentagePoints, 5);
  assert.deepEqual(
    fixed.plausibleRangePercentagePoints,
    { lower: 4, upper: 6.25 },
  );
  assert.equal(
    fixed.scenarios.unresolved_as_standard.basisId,
    standard.basisId,
  );

  const mixed = cacheSwitchAllowanceImpact({
    periodId: "7d",
    allowanceWeighting: {
      ...fixedWeighting,
      status: "range",
      selectedScenario: null,
      selectedPremiumUsd: null,
      rangePremiumUsd: { lower: 5, upper: 12.5 },
    },
  }, allowanceCapacity(null));
  assert.equal(mixed.status, "range");
  assert.deepEqual(mixed.percentagePointRange, { lower: 5, upper: 6.25 });
  assert.deepEqual(
    mixed.plausibleRangePercentagePoints,
    { lower: 4, upper: 7.8125 },
  );

  const mismatched = allowanceCapacity();
  mismatched.scenarios.unresolved_as_standard = {
    ...mismatched.scenarios.unresolved_as_standard,
    basisId: fast.basisId,
  };
  assert.equal(cacheSwitchAllowanceImpact(
    { periodId: "7d", allowanceWeighting: fixedWeighting },
    mismatched,
  ).reason, "basis_mismatch");
  for (const periodId of ["24h", "30d", "all"]) {
    assert.equal(cacheSwitchAllowanceImpact(
      { periodId, allowanceWeighting: fixedWeighting },
      allowanceCapacity(),
    ).reason, "period_denominator_mismatch");
  }
  assert.equal(cacheSwitchAllowanceImpact(
    { periodId: "7d", allowanceWeighting: fixedWeighting },
    { ...allowanceCapacity(), accountAttribution: null },
  ).reason, "weekly_calibration_account_scope_unverified");
});

function sessionMeta(sessionId) {
  return JSON.stringify({
    timestamp: "2026-08-08T11:50:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      thread_source: "user",
      originator: "codex_cli_rs",
      cwd: "/private/project",
    },
  });
}

function turnContext(timestamp, turnId, effort) {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: turnId,
      model: "gpt-5.6-sol",
      effort,
      cwd: "/private/project",
    },
  });
}

function usage(input, cached) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input,
  };
}

function tokenCount(timestamp, total, last) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  });
}

function quotaOnlyTokenCount(timestamp, total) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: null,
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: {
          used_percent: 20,
          window_minutes: 10_080,
          resets_at: 1_786_307_200,
        },
      },
    },
  });
}

test("raw rollout facts flow through the existing index into the read-only impact projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-switch-index-"));
  const sessions = join(root, "sessions", "2026", "08", "08");
  const indexFile = join(root, "index.sqlite");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, "rollout-2026-08-08T11-50-00-main.jsonl"),
    `${[
      sessionMeta(sessionId),
      turnContext("2026-08-08T11:51:00.000Z", "turn-high", "high"),
      tokenCount(
        "2026-08-08T11:51:10.000Z",
        usage(1_200, 1_000),
        usage(1_200, 1_000),
      ),
      turnContext("2026-08-08T11:52:00.000Z", "turn-max", "max"),
      // A quota-only record has the new setting but no charged usage. It must
      // not consume adjacency before the actual Max request below.
      quotaOnlyTokenCount("2026-08-08T11:52:05.000Z", usage(1_200, 1_000)),
      tokenCount(
        "2026-08-08T11:52:10.000Z",
        usage(2_400, 1_000),
        usage(1_200, 0),
      ),
      turnContext("2026-08-08T11:53:00.000Z", "turn-high-again", "high"),
      tokenCount(
        "2026-08-08T11:53:10.000Z",
        usage(3_600, 2_100),
        usage(1_200, 1_100),
      ),
      turnContext("2026-08-08T11:54:00.000Z", "turn-high-return", "high"),
      tokenCount(
        "2026-08-08T11:54:10.000Z",
        usage(4_800, 2_100),
        usage(1_200, 0),
      ),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(sessions, "rollout-2026-08-08T11-51-00-interleaved.jsonl"),
    `${[
      sessionMeta("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
      turnContext("2026-08-08T11:51:30.000Z", "other-high", "high"),
      tokenCount(
        "2026-08-08T11:51:40.000Z",
        usage(400, 100),
        usage(400, 100),
      ),
    ].join("\n")}\n`,
  );
  try {
    const build = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: "usage-event-v0.2",
    });
    assert.equal(build.usageEvents, 6);
    const projection = await readLocalUnifiedCompanionProjection({
      indexFile,
      nowMs: NOW_MS,
    });
    const period = projection.cacheSwitchImpact.periods.find(
      (candidate) => candidate.periodId === "24h",
    );
    const serialized = JSON.stringify(projection.cacheSwitchImpact);

    assert.equal(projection.status, "available");
    assert.equal(period.configurationChanges, 2);
    assert.equal(period.proximateConfigurationChanges, 2);
    assert.equal(period.orderingCoverageGaps, 0);
    assert.equal(period.cacheReadDrops, 1);
    assert.equal(period.lostCacheTokens, 1_000);
    assert.ok(period.estimatedPremiumUsd > 0);
    const continuity = projection.cacheContinuityImpact.periods.find(
      (candidate) => candidate.periodId === "24h",
    );
    assert.equal(continuity.coverageStatus, "complete");
    assert.equal(continuity.orderingCoverageGaps, 0);
    assert.equal(continuity.sameConfigurationReturns, 1);
    assert.equal(continuity.comparableReturns, 1);
    assert.equal(continuity.reusedMoreThanHalfReturns, 0);
    assert.equal(continuity.reusedHalfOrLessReturns, 1);
    assert.equal(continuity.cacheReadDrops, 1);
    assert.equal(continuity.lostCacheTokens, 1_100);
    assert.equal(
      Object.values(continuity.byOutcomeBucket).reduce(
        (sum, bucket) => sum + bucket.comparableReturns,
        0,
      ),
      continuity.comparableReturns,
    );
    assert.ok(continuity.estimatedPremiumUsd > 0);
    assert.doesNotMatch(serialized, new RegExp(sessionId, "u"));
    assert.doesNotMatch(serialized, /turn-high|event_key|session_local/u);
    assert.doesNotMatch(
      JSON.stringify(projection.cacheContinuityImpact),
      /turn-high|event_key|session_local/u,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a missing unified index reports impact unavailable rather than zero", async () => {
  const projection = await readLocalUnifiedCompanionProjection({
    indexFile: join(tmpdir(), `missing-cache-switch-${process.pid}.sqlite`),
    nowMs: NOW_MS,
  });
  assert.equal(projection.status, "missing");
  assert.equal(projection.cacheSwitchImpact.status, "unavailable");
  assert.deepEqual(projection.cacheSwitchImpact.periods, []);
});
