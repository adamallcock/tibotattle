import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeDashboardPayload } from "../public/data-client.js";
import {
  SUPPORTED_LOCALES,
  translate,
} from "../public/localization.js";

const ALLOWANCE_INTERPRETATION =
  "conditional_historical_estimate_not_provider_allowance";
const ALLOWANCE_BASIS_FAMILY_ID =
  "codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30:event_time:observed_declared_scenario";

function allowanceBasisId(scenario) {
  return `${ALLOWANCE_BASIS_FAMILY_ID}:${scenario}`;
}

function premiumScenario(scenario, premium, drops) {
  return {
    basisId: allowanceBasisId(scenario),
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    quotaWeightedPremiumUsd: premium,
    pricedDrops: drops,
    observedSpeedDrops: 0,
    declaredSpeedDrops: 0,
    assumedSpeedDrops: drops,
    unknownSpeedDrops: 0,
  };
}

function premiumWeighting(standardPremium, fastPremium, drops) {
  return {
    status: "complete",
    reasonCode: null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: "unresolved_as_standard",
    selectedPremiumUsd: standardPremium,
    scenarios: {
      unresolved_as_standard: premiumScenario(
        "unresolved_as_standard",
        standardPremium,
        drops,
      ),
      unresolved_as_fast: premiumScenario(
        "unresolved_as_fast",
        fastPremium,
        drops,
      ),
    },
    rangePremiumUsd: null,
  };
}

function unavailablePremiumWeighting(reasonCode = "weighting_evidence_incomplete") {
  return {
    status: "unavailable",
    reasonCode,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: null,
    selectedPremiumUsd: null,
    scenarios: {
      unresolved_as_standard: null,
      unresolved_as_fast: null,
    },
    rangePremiumUsd: null,
  };
}

function coveredSubtotal(standardPremium, pricedDrops, overrides = {}) {
  return {
    scope: "covered_priced_drops",
    pricedDrops,
    standardApiPremiumUsd: standardPremium,
    standardApiPremiumUsdExact: String(standardPremium),
    allowanceWeighting: premiumWeighting(standardPremium, standardPremium * 2, pricedDrops),
    ...overrides,
  };
}

function unavailableAllowanceImpact(reason = "weighting_evidence_incomplete") {
  return {
    status: "unavailable",
    reason,
    basisFamilyId: null,
    selectedScenario: null,
    medianPercentagePoints: null,
    percentagePointRange: null,
    plausibleRangePercentagePoints: null,
    scenarios: {
      unresolved_as_standard: null,
      unresolved_as_fast: null,
    },
    interpretation: ALLOWANCE_INTERPRETATION,
  };
}

function allowanceImpact(
  standardPremium,
  fastPremium,
  medianPercentagePoints,
  plausibleRangePercentagePoints,
) {
  const standardCapacity = standardPremium * 100 / medianPercentagePoints;
  const fastCapacity = fastPremium * 100 / medianPercentagePoints;
  return {
    status: "complete",
    reason: null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: "unresolved_as_standard",
    medianPercentagePoints,
    percentagePointRange: null,
    plausibleRangePercentagePoints,
    scenarios: {
      unresolved_as_standard: {
        basisId: allowanceBasisId("unresolved_as_standard"),
        quotaWeightedPremiumUsd: standardPremium,
        medianCapacityUsd: standardCapacity,
        medianPercentagePoints,
        plausibleRangePercentagePoints,
      },
      unresolved_as_fast: {
        basisId: allowanceBasisId("unresolved_as_fast"),
        quotaWeightedPremiumUsd: fastPremium,
        medianCapacityUsd: fastCapacity,
        medianPercentagePoints,
        plausibleRangePercentagePoints,
      },
    },
    interpretation: ALLOWANCE_INTERPRETATION,
  };
}

function zeroBreakdown() {
  return {
    configurationChanges: 0,
    proximateConfigurationChanges: 0,
    uncoveredConfigurationChanges: 0,
    coverageStatus: "complete",
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    pricedDrops: 0,
    unpricedDrops: 0,
    estimatedPremiumUsd: 0,
  };
}

function recentRow(index = 0, overrides = {}) {
  return {
    observedAt: new Date(Date.UTC(2026, 7, 8, 12, index % 60)).toISOString(),
    gapSeconds: 45,
    changeType: "model_only",
    previous: { model: "gpt-5.5", reasoningEffort: "high" },
    current: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    previousCacheReadTokens: 10_000,
    currentCacheReadTokens: 2_000,
    lostCacheTokens: 8_000,
    estimatedPremiumUsd: 0.01,
    // Deliberately hostile extras: none may survive the browser boundary.
    sessionLocal: "secret-session",
    eventKey: "secret-event",
    rolloutPath: "/private/rollout.jsonl",
    ...overrides,
  };
}

function period(overrides = {}) {
  return {
    periodId: "7d",
    periodLabel: "Last 7 days",
    configurationChanges: 25,
    proximateConfigurationChanges: 25,
    uncoveredConfigurationChanges: 0,
    orderingCoverageGaps: 0,
    coverageStatus: "complete",
    cacheReadDrops: 25,
    lostCacheTokens: 200_000,
    pricedDrops: 25,
    unpricedDrops: 0,
    estimatedPremiumUsd: 0.25,
    estimatedPremiumUsdExact: "0.250000000",
    standardApiPremiumUsd: 0.25,
    allowanceWeighting: premiumWeighting(0.25, 0.625, 25),
    byChangeType: {
      reasoning_only: zeroBreakdown(),
      model_only: {
        configurationChanges: 25,
        proximateConfigurationChanges: 25,
        uncoveredConfigurationChanges: 0,
        coverageStatus: "complete",
        cacheReadDrops: 25,
        lostCacheTokens: 200_000,
        pricedDrops: 25,
        unpricedDrops: 0,
        estimatedPremiumUsd: 0.25,
      },
      model_and_reasoning: zeroBreakdown(),
    },
    recent: Array.from({ length: 40 }, (_, index) => recentRow(index)),
    allowanceImpact: allowanceImpact(
      0.25,
      0.625,
      0.2,
      { lower: 0.1, upper: 0.3 },
    ),
    ...overrides,
  };
}

function impact(overrides = {}) {
  const selected = period();
  return {
    status: "available",
    errorCode: null,
    periodId: selected.periodId,
    periodLabel: selected.periodLabel,
    proximityCeilingSeconds: 300,
    maximumRetainedCacheRatio: 0.5,
    recentDetailLimit: 20,
    ...selected,
    periods: [selected],
    ...overrides,
  };
}

function normalizedImpact(value) {
  return normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      periodId: "7d",
      cacheSwitchImpact: value,
    },
  }).accounting.cacheSwitchImpact;
}

const CONTINUITY_GAP_BANDS = [
  "under_one_minute",
  "one_to_five_minutes",
  "five_to_thirty_minutes",
  "thirty_minutes_to_one_hour",
  "one_to_six_hours",
  "six_to_twenty_four_hours",
  "over_twenty_four_hours",
];
const CONTINUITY_OUTCOME_BUCKETS = [
  ["under_one_minute", 0, 60],
  ["one_to_two_minutes", 60, 120],
  ["two_to_five_minutes", 120, 300],
  ["five_to_ten_minutes", 300, 600],
  ["ten_to_thirty_minutes", 600, 1_800],
  ["thirty_minutes_to_one_hour", 1_800, 3_600],
  ["one_to_six_hours", 3_600, 21_600],
  ["six_to_twenty_four_hours", 21_600, 86_400],
  ["one_to_three_days", 86_400, 259_200],
  ["over_three_days", 259_200, null],
];

function zeroContinuityBreakdown() {
  return {
    sameConfigurationReturns: 0,
    comparableReturns: 0,
    compactionConfoundedReturns: 0,
    contextContractedReturns: 0,
    insufficientEvidenceReturns: 0,
    uncoveredReturns: 0,
    reusedMoreThanHalfReturns: 0,
    reusedHalfOrLessReturns: 0,
    matchedOrExceededReturns: 0,
    reusedBetweenHalfAndPreviousReturns: 0,
    coverageStatus: "complete",
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    pricedDrops: 0,
    unpricedDrops: 0,
    estimatedPremiumUsd: 0,
  };
}

function continuityOutcomeBuckets(active) {
  return Object.fromEntries(CONTINUITY_OUTCOME_BUCKETS.map(
    ([key, startSeconds, endSeconds]) => [
      key,
      {
        startSeconds,
        endSeconds,
        ...(key === "under_one_minute"
          ? active
          : zeroContinuityBreakdown()),
      },
    ],
  ));
}

function continuityRecentRow(overrides = {}) {
  return {
    observedAt: "2026-08-08T12:00:00.000Z",
    gapSeconds: 30,
    gapBand: "under_one_minute",
    configuration: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    previousCacheReadTokens: 10_000,
    currentCacheReadTokens: 2_000,
    lostCacheTokens: 8_000,
    estimatedPremiumUsd: 0.01,
    sessionLocal: "secret-session",
    eventKey: "secret-event",
    rolloutPath: "/private/rollout.jsonl",
    ...overrides,
  };
}

function continuityPeriod(overrides = {}) {
  const active = {
    ...zeroContinuityBreakdown(),
    sameConfigurationReturns: 1,
    comparableReturns: 1,
    reusedHalfOrLessReturns: 1,
    cacheReadDrops: 1,
    lostCacheTokens: 8_000,
    pricedDrops: 1,
    estimatedPremiumUsd: 0.01,
  };
  return {
    periodId: "7d",
    periodLabel: "Last 7 days",
    ...active,
    standardApiPremiumUsd: 0.01,
    allowanceWeighting: premiumWeighting(0.01, 0.025, 1),
    orderingCoverageGaps: 0,
    postCompactionRequests: 5,
    postCompactionCacheReadDrops: 4,
    byGapBand: Object.fromEntries(CONTINUITY_GAP_BANDS.map((key) => [
      key,
      key === "under_one_minute" ? active : zeroContinuityBreakdown(),
    ])),
    byOutcomeBucket: continuityOutcomeBuckets(active),
    recent: [continuityRecentRow()],
    allowanceImpact: allowanceImpact(
      0.01,
      0.025,
      0.01,
      { lower: 0.005, upper: 0.02 },
    ),
    ...overrides,
  };
}

function continuityImpact(overrides = {}) {
  const selected = continuityPeriod();
  return {
    status: "available",
    errorCode: null,
    periodId: selected.periodId,
    periodLabel: selected.periodLabel,
    minimumGapSeconds: 0,
    maximumRetainedCacheRatio: 0.5,
    outcomeDisplayMaximumGapSeconds: 604_800,
    recentDetailLimit: 20,
    ...selected,
    periods: [selected],
    ...overrides,
  };
}

function normalizedContinuityImpact(value) {
  return normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      periodId: "7d",
      cacheContinuityImpact: value,
    },
  }).accounting.cacheContinuityImpact;
}

function switchSubtotalPeriod({ ordering = 1, unpriced = 0 } = {}) {
  const selected = period();
  const pricedDrops = selected.cacheReadDrops - unpriced;
  const amount = Number((pricedDrops * 0.01).toFixed(9));
  const subtotal = pricedDrops > 0 ? coveredSubtotal(amount, pricedDrops) : null;
  const incompleteTotal = ordering > 0 || unpriced > 0;
  return {
    ...selected,
    orderingCoverageGaps: ordering,
    coverageStatus: ordering > 0 ? "incomplete" : "complete",
    pricedDrops,
    unpricedDrops: unpriced,
    estimatedPremiumUsd: incompleteTotal ? null : amount,
    standardApiPremiumUsd: incompleteTotal ? null : amount,
    coveredSubtotal: subtotal,
    allowanceWeighting: incompleteTotal
      ? unavailablePremiumWeighting() : premiumWeighting(amount, amount * 2, pricedDrops),
    allowanceImpact: incompleteTotal ? unavailableAllowanceImpact() : selected.allowanceImpact,
    byChangeType: {
      ...selected.byChangeType,
      model_only: {
        ...selected.byChangeType.model_only,
        pricedDrops,
        unpricedDrops: unpriced,
        estimatedPremiumUsd: unpriced > 0 ? null : amount,
        coveredSubtotal: structuredClone(subtotal),
      },
    },
  };
}

function continuitySubtotalPeriod({ ordering = 1, unpriced = 0 } = {}) {
  const selected = continuityPeriod();
  const active = {
    ...zeroContinuityBreakdown(),
    sameConfigurationReturns: 1 + unpriced,
    comparableReturns: 1 + unpriced,
    reusedHalfOrLessReturns: 1 + unpriced,
    cacheReadDrops: 1 + unpriced,
    lostCacheTokens: 8_000 * (1 + unpriced),
    pricedDrops: 1,
    unpricedDrops: unpriced,
    estimatedPremiumUsd: unpriced > 0 ? null : 0.01,
    coveredSubtotal: coveredSubtotal(0.01, 1),
  };
  const incompleteTotal = ordering > 0 || unpriced > 0;
  return {
    ...selected,
    ...active,
    orderingCoverageGaps: ordering,
    coverageStatus: ordering > 0 ? "incomplete" : "complete",
    estimatedPremiumUsd: incompleteTotal ? null : 0.01,
    standardApiPremiumUsd: incompleteTotal ? null : 0.01,
    allowanceWeighting: incompleteTotal
      ? unavailablePremiumWeighting() : premiumWeighting(0.01, 0.02, 1),
    allowanceImpact: incompleteTotal ? unavailableAllowanceImpact() : selected.allowanceImpact,
    byGapBand: Object.fromEntries(CONTINUITY_GAP_BANDS.map((key) => [
      key,
      key === "under_one_minute" ? structuredClone(active) : zeroContinuityBreakdown(),
    ])),
    byOutcomeBucket: continuityOutcomeBuckets(structuredClone(active)),
  };
}

test("cache-switch evidence is bounded and projects no local identifiers", () => {
  const result = normalizedImpact(impact());
  assert.equal(result.status, "available");
  assert.equal(result.maximumRetainedCacheRatio, 0.5);
  assert.equal(result.proximityCeilingSeconds, 300);
  assert.equal(result.orderingCoverageGaps, 0);
  assert.equal(result.recent.length, 20);
  assert.deepEqual(Object.keys(result.recent[0]).sort(), [
    "changeType",
    "current",
    "currentCacheReadTokens",
    "estimatedPremiumUsd",
    "gapSeconds",
    "lostCacheTokens",
    "observedAt",
    "previous",
    "previousCacheReadTokens",
  ]);
  assert.equal(result.recent[0].gapSeconds, 45);
  assert.deepEqual(Object.keys(result.recent[0].previous).sort(), [
    "model",
    "reasoningEffort",
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-session|secret-event|private\/rollout|sessionLocal|eventKey|rolloutPath/u,
  );
  assert.deepEqual(result.allowanceImpact.plausibleRangePercentagePoints, {
    lower: 0.1,
    upper: 0.3,
  });
});

test("cache-continuity evidence has no timing floor and drops local identifiers", () => {
  const result = normalizedContinuityImpact(continuityImpact());
  assert.equal(result.status, "available");
  assert.equal(result.minimumGapSeconds, 0);
  assert.equal(result.outcomeDisplayMaximumGapSeconds, 604_800);
  assert.equal(result.sameConfigurationReturns, 1);
  assert.equal(result.comparableReturns, 1);
  assert.equal(result.reusedMoreThanHalfReturns, 0);
  assert.equal(result.reusedHalfOrLessReturns, 1);
  assert.equal(result.matchedOrExceededReturns, 0);
  assert.equal(result.reusedBetweenHalfAndPreviousReturns, 0);
  assert.equal(result.orderingCoverageGaps, 0);
  assert.equal(result.cacheReadDrops, 1);
  assert.equal(result.postCompactionRequests, 5);
  assert.equal(result.postCompactionCacheReadDrops, 4);
  assert.equal(result.recent[0].gapBand, "under_one_minute");
  assert.equal(result.recent[0].gapSeconds, 30);
  assert.deepEqual(Object.keys(result.recent[0]).sort(), [
    "configuration",
    "currentCacheReadTokens",
    "estimatedPremiumUsd",
    "gapBand",
    "gapSeconds",
    "lostCacheTokens",
    "observedAt",
    "previousCacheReadTokens",
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-session|secret-event|private\/rollout|sessionLocal|eventKey|rolloutPath/u,
  );
  assert.deepEqual(Object.keys(result.byOutcomeBucket),
    CONTINUITY_OUTCOME_BUCKETS.map(([key]) => key));
  assert.deepEqual(
    [
      result.byOutcomeBucket.under_one_minute.startSeconds,
      result.byOutcomeBucket.under_one_minute.endSeconds,
      result.byOutcomeBucket.over_three_days.startSeconds,
      result.byOutcomeBucket.over_three_days.endSeconds,
    ],
    [0, 60, 259_200, null],
  );
});

test("cache-continuity normalization fails closed on methodology and partitions", () => {
  assert.equal(normalizedContinuityImpact({}).status, "unavailable");
  assert.equal(normalizedContinuityImpact(continuityImpact({
    minimumGapSeconds: 1_800,
  })).status, "unavailable");
  assert.equal(normalizedContinuityImpact(continuityImpact({
    outcomeDisplayMaximumGapSeconds: 259_200,
  })).status, "unavailable");

  const invalidPartition = continuityPeriod({
    sameConfigurationReturns: 2,
  });
  assert.equal(normalizedContinuityImpact(continuityImpact({
    ...invalidPartition,
    periods: [invalidPartition],
  })).status, "unavailable");

  const invalidOutcomeBoundary = continuityPeriod();
  invalidOutcomeBoundary.byOutcomeBucket.two_to_five_minutes.startSeconds = 121;
  assert.equal(normalizedContinuityImpact(continuityImpact({
    ...invalidOutcomeBoundary,
    periods: [invalidOutcomeBoundary],
  })).status, "unavailable");

  const invalidRecent = continuityPeriod({
    recent: [continuityRecentRow({
      gapSeconds: 600,
      gapBand: "under_one_minute",
    })],
  });
  const normalized = normalizedContinuityImpact(continuityImpact({
    ...invalidRecent,
    periods: [invalidRecent],
  }));
  assert.equal(normalized.status, "available");
  assert.deepEqual(normalized.recent, []);
});

test("incomplete compaction coverage withholds a continuity premium", () => {
  const uncovered = {
    ...zeroContinuityBreakdown(),
    sameConfigurationReturns: 1,
    uncoveredReturns: 1,
    coverageStatus: "incomplete",
    estimatedPremiumUsd: null,
  };
  const selected = continuityPeriod({
    ...uncovered,
    standardApiPremiumUsd: null,
    allowanceWeighting: unavailablePremiumWeighting(),
    allowanceImpact: unavailableAllowanceImpact(),
    byGapBand: Object.fromEntries(CONTINUITY_GAP_BANDS.map((key) => [
      key,
      key === "under_one_minute" ? uncovered : zeroContinuityBreakdown(),
    ])),
    byOutcomeBucket: continuityOutcomeBuckets(uncovered),
    recent: [],
  });
  const result = normalizedContinuityImpact(continuityImpact({
    ...selected,
    periods: [selected],
  }));
  assert.equal(result.status, "available");
  assert.equal(result.coverageStatus, "incomplete");
  assert.equal(result.estimatedPremiumUsd, null);

  const contaminated = {
    ...selected,
    estimatedPremiumUsd: 0.01,
  };
  assert.equal(normalizedContinuityImpact(continuityImpact({
    ...contaminated,
    periods: [contaminated],
  })).status, "unavailable");
});

test("cache-switch normalization fails closed on methodology and semantic mismatches", () => {
  assert.equal(normalizedImpact({}).status, "unavailable");
  assert.equal(
    normalizedImpact(impact({ maximumRetainedCacheRatio: 0.75 })).status,
    "unavailable",
  );

  const invalid = period({
    recent: [
      recentRow(0, {
        changeType: "model_only",
        current: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      }),
      recentRow(1, {
        changeType: "reasoning_only",
        previous: { model: "gpt-5.5", reasoningEffort: "max" },
        current: { model: "gpt-5.5", reasoningEffort: "ultra" },
      }),
      recentRow(2, { currentCacheReadTokens: 6_000, lostCacheTokens: 4_000 }),
    ],
  });
  const normalized = normalizedImpact(impact({
    ...invalid,
    periods: [invalid],
  }));
  assert.equal(normalized.status, "available");
  assert.deepEqual(normalized.recent, []);

  const zeroTokenDrop = period({
    cacheReadDrops: 1,
    lostCacheTokens: 0,
    pricedDrops: 1,
    estimatedPremiumUsd: 0.01,
    byChangeType: {
      reasoning_only: zeroBreakdown(),
      model_only: {
        configurationChanges: 25,
        proximateConfigurationChanges: 25,
        uncoveredConfigurationChanges: 0,
        coverageStatus: "complete",
        cacheReadDrops: 1,
        lostCacheTokens: 0,
        pricedDrops: 1,
        unpricedDrops: 0,
        estimatedPremiumUsd: 0.01,
      },
      model_and_reasoning: zeroBreakdown(),
    },
    recent: [],
  });
  assert.equal(normalizedImpact(impact({
    ...zeroTokenDrop,
    periods: [zeroTokenDrop],
  })).status, "unavailable");

  const inconsistentPremium = period({
    estimatedPremiumUsd: 0.3,
  });
  assert.equal(normalizedImpact(impact({
    ...inconsistentPremium,
    periods: [inconsistentPremium],
  })).status, "unavailable");
});

test("a mixed-price cache-switch sum stays unavailable instead of looking complete", () => {
  const mixed = period({
    cacheReadDrops: 2,
    lostCacheTokens: 16_000,
    pricedDrops: 1,
    unpricedDrops: 1,
    estimatedPremiumUsd: null,
    standardApiPremiumUsd: null,
    allowanceWeighting: unavailablePremiumWeighting(
      "price_coverage_incomplete",
    ),
    allowanceImpact: unavailableAllowanceImpact("price_coverage_incomplete"),
    byChangeType: {
      reasoning_only: zeroBreakdown(),
      model_only: {
        configurationChanges: 25,
        proximateConfigurationChanges: 25,
        uncoveredConfigurationChanges: 0,
        coverageStatus: "complete",
        cacheReadDrops: 2,
        lostCacheTokens: 16_000,
        pricedDrops: 1,
        unpricedDrops: 1,
        estimatedPremiumUsd: null,
      },
      model_and_reasoning: zeroBreakdown(),
    },
    recent: [recentRow(0), recentRow(1, { estimatedPremiumUsd: null })],
  });
  const result = normalizedImpact(impact({ ...mixed, periods: [mixed] }));
  assert.equal(result.status, "available");
  assert.equal(result.estimatedPremiumUsd, null);
  assert.equal(result.pricedDrops, 1);
  assert.equal(result.unpricedDrops, 1);
});

for (const [name, makePeriod, makeImpact, normalize, partitions] of [
  ["switch", switchSubtotalPeriod, impact, normalizedImpact, ["byChangeType"]],
  ["continuity", continuitySubtotalPeriod, continuityImpact, normalizedContinuityImpact,
    ["byGapBand", "byOutcomeBucket"]],
]) {
  test(`${name} normalization retains scoped covered subtotals and keeps whole-period allowance unavailable`, () => {
    for (const selection of [
      { ordering: 1, unpriced: 0 },
      { ordering: 0, unpriced: 1 },
      { ordering: 1, unpriced: 1 },
    ]) {
      const selected = makePeriod(selection);
      selected.coveredSubtotal.sessionLocal = "must-not-project";
      selected.coveredSubtotal.allowanceWeighting.accountIdentifier = "must-not-project";
      // Even a forged whole-period conversion must not reuse the subtotal.
      selected.allowanceImpact = allowanceImpact(1, 2, 1, { lower: 0.5, upper: 2 });
      const result = normalize(makeImpact({ ...selected, periods: [selected] }));
      assert.equal(result.status, "available");
      assert.equal(result.estimatedPremiumUsd, null);
      assert.equal(result.standardApiPremiumUsd, null);
      assert.equal(result.allowanceWeighting.status, "unavailable");
      assert.equal(result.allowanceImpact.status, "unavailable");
      assert.equal(result.allowanceImpact.medianPercentagePoints, null);
      assert.equal(result.coveredSubtotal.scope, "covered_priced_drops");
      assert.equal(result.coveredSubtotal.pricedDrops, result.pricedDrops);
      assert.equal(result.coveredSubtotal.standardApiPremiumUsd,
        selected.coveredSubtotal.standardApiPremiumUsd);
      assert.equal(result.coveredSubtotal.allowanceWeighting.status, "complete");
      assert.doesNotMatch(JSON.stringify(result), /must-not-project|sessionLocal|accountIdentifier/u);
      for (const partition of partitions) {
        const children = Object.values(result[partition]);
        assert.equal(children.reduce((sum, child) => sum + (child.coveredSubtotal?.pricedDrops ?? 0), 0),
          result.pricedDrops);
        assert.equal(children.filter((child) => child.pricedDrops === 0).every(
          (child) => child.coveredSubtotal === null,
        ), true);
      }
      assert.deepEqual(result.periods[0].coveredSubtotal, result.coveredSubtotal);
    }
  });

  test(`${name} normalization rejects malformed or inconsistent subtotal evidence`, () => {
    const mutations = [
      (selected) => { selected.coveredSubtotal.scope = "whole_period"; },
      (selected) => { selected.coveredSubtotal.pricedDrops = 0; },
      (selected) => { selected.coveredSubtotal.pricedDrops += 1; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsd = -1; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsd = Infinity; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsd = "0.01"; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "-0.01"; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "0.0000000001"; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "00.01"; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "1e-2"; },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "9".repeat(65); },
      (selected) => { selected.coveredSubtotal.standardApiPremiumUsdExact = "0.99"; },
      (selected) => { selected.coveredSubtotal.allowanceWeighting.selectedPremiumUsd = -1; },
      (selected) => { selected.coveredSubtotal.allowanceWeighting.scenarios.unresolved_as_standard.pricedDrops += 1; },
      (selected) => { selected.allowanceWeighting = selected.coveredSubtotal.allowanceWeighting; },
      (selected) => {
        for (const partition of partitions) {
          const child = Object.values(selected[partition]).find((part) => part.pricedDrops > 0);
          child.coveredSubtotal = null;
        }
      },
      (selected) => {
        // A one-nanodollar disagreement is still not an exact subtotal.
        selected.coveredSubtotal.standardApiPremiumUsd = Number(
          (selected.coveredSubtotal.standardApiPremiumUsd + 1e-9).toFixed(9),
        );
        selected.coveredSubtotal.standardApiPremiumUsdExact = String(
          selected.coveredSubtotal.standardApiPremiumUsd,
        );
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const selected = makePeriod();
      mutate(selected);
      const result = normalize(makeImpact({ ...selected, periods: [selected] }));
      assert.equal(result.status, "unavailable", `mutation ${index}`);
      assert.equal(result.coveredSubtotal, null, `mutation ${index}`);
    }
  });
}

test("a fully unpriced switch period cannot advertise a zero-dollar covered subtotal", () => {
  const selected = switchSubtotalPeriod({ ordering: 1, unpriced: 25 });
  const result = normalizedImpact(impact({ ...selected, periods: [selected] }));
  assert.equal(result.status, "available");
  assert.equal(result.coveredSubtotal, null);
  assert.equal(result.estimatedPremiumUsd, null);
  selected.coveredSubtotal = coveredSubtotal(0, 0);
  assert.equal(normalizedImpact(impact({ ...selected, periods: [selected] })).status, "unavailable");
});

test("non-weekly periods cannot carry a weekly allowance conversion", () => {
  for (const periodId of ["24h", "30d", "all", "history"]) {
    const selected = period({ periodId });
    const result = normalizedImpact(impact({
      ...selected,
      periods: [selected],
    }));
    assert.equal(result.status, "available");
    assert.equal(result.allowanceImpact.status, "unavailable");
    assert.equal(result.periods[0].allowanceImpact.status, "unavailable");
  }
});

test("cache-impact money rendering keeps Standard continuity evidence visible", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function cacheSwitchMetricValue(impact) {");
  const end = source.indexOf("\nfunction appendCacheSwitchMetricNote", start);
  assert.ok(start >= 0 && end > start, "cache-switch metric helper is available");
  const metricValues = Function(
    "finite",
    "formatApiMoney",
    "t",
    `${source.slice(start, end)}\nreturn {`
      + " cacheSwitchMetricValue, cacheContinuityStandardMetricValue,"
      + " cacheContinuityMetricValue,"
      + " cacheContinuityUsesStandardFallback };",
  )(
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    (value) => value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`,
    (key, values) => translate(key, values, "en"),
  );
  assert.equal(metricValues.cacheSwitchMetricValue({
    status: "unavailable",
    estimatedPremiumUsd: 0,
  }), "—");
  assert.equal(metricValues.cacheSwitchMetricValue({
    status: "available",
    allowanceWeighting: null,
  }), "—");
  assert.equal(metricValues.cacheSwitchMetricValue({
    status: "available",
    allowanceWeighting: { status: "complete", selectedPremiumUsd: 0 },
  }), "$0.00");
  assert.equal(metricValues.cacheSwitchMetricValue({
    status: "available",
    allowanceWeighting: { status: "complete", selectedPremiumUsd: 0.005 },
  }), "<$0.01");
  assert.equal(metricValues.cacheSwitchMetricValue({
    status: "available",
    allowanceWeighting: {
      status: "range",
      rangePremiumUsd: { lower: 0.01, upper: 0.025 },
    },
  }), "$0.01–$0.03");
  const standardFallback = {
    status: "available",
    standardApiPremiumUsd: 231.44,
    allowanceWeighting: { status: "unavailable" },
  };
  assert.equal(
    metricValues.cacheContinuityMetricValue(standardFallback),
    "$231.44",
  );
  assert.equal(
    metricValues.cacheContinuityUsesStandardFallback(standardFallback),
    true,
  );
  const weightedContinuity = {
    ...standardFallback,
    allowanceWeighting: { status: "complete", selectedPremiumUsd: 300 },
  };
  assert.equal(
    metricValues.cacheContinuityMetricValue(weightedContinuity),
    "$300.00",
  );
  assert.equal(
    metricValues.cacheContinuityStandardMetricValue(weightedContinuity),
    "$231.44",
  );
  assert.equal(
    metricValues.cacheContinuityUsesStandardFallback(weightedContinuity),
    false,
  );
  const subtotal = {
    ...weightedContinuity,
    coverageStatus: "incomplete",
    orderingCoverageGaps: 1,
    cacheReadDrops: 4,
    comparableReturns: 10,
    pricedDrops: 3,
    unpricedDrops: 1,
    estimatedPremiumUsd: null,
    standardApiPremiumUsd: null,
    allowanceWeighting: unavailablePremiumWeighting(),
    coveredSubtotal: coveredSubtotal(10, 3, {
      allowanceWeighting: premiumWeighting(15, 20, 3),
    }),
  };
  assert.equal(metricValues.cacheSwitchMetricValue(subtotal), "Subtotal $15.00");
  assert.equal(metricValues.cacheContinuityMetricValue(subtotal), "Subtotal $15.00");
  assert.equal(metricValues.cacheContinuityStandardMetricValue(subtotal), "Subtotal $10.00");
  assert.equal(metricValues.cacheContinuityUsesStandardFallback(subtotal), false);
  const standardOnlySubtotal = {
    ...subtotal,
    coveredSubtotal: coveredSubtotal(10, 3, {
      allowanceWeighting: unavailablePremiumWeighting(),
    }),
  };
  assert.equal(metricValues.cacheSwitchMetricValue(standardOnlySubtotal), "Subtotal $10.00");
  assert.equal(metricValues.cacheContinuityUsesStandardFallback(standardOnlySubtotal), true);
  for (const unavailable of [
    { ...subtotal, coveredSubtotal: null, pricedDrops: 0, unpricedDrops: 4 },
    { ...subtotal, coveredSubtotal: coveredSubtotal(10, 3, { scope: "full_period" }) },
    { ...weightedContinuity, comparableReturns: 0, cacheReadDrops: 0 },
  ]) {
    assert.equal(metricValues.cacheSwitchMetricValue(unavailable), "—");
    assert.equal(metricValues.cacheContinuityMetricValue(unavailable), "—");
    assert.equal(metricValues.cacheContinuityStandardMetricValue(unavailable), "—");
  }
});

test("a pager is drawn only when there is more than one page to reach", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderCacheImpactPagination(prefix, state, page) {");
  const end = source.indexOf("\nfunction renderAccountingCacheSwitchDetails(", start);
  assert.ok(start >= 0 && end > start, "the pagination renderer is available");

  const build = () => {
    const nodes = {
      "#t-pagination": { hidden: null },
      "#t-page-status": { textContent: "" },
      "#t-page-prev": { disabled: null },
      "#t-page-next": { disabled: null },
    };
    const render = Function(
      "$",
      "setLocalizedText",
      "formatNumber",
      `${source.slice(start, end)}\nreturn renderCacheImpactPagination;`,
    )(
      (selector) => nodes[selector] ?? null,
      (element, _key, values) => {
        if (element) element.textContent = `${values.start}–${values.end} of ${values.total}`;
      },
      (value) => String(value),
    );
    return { nodes, render };
  };

  // Every row already visible: the control would say only what the rows say.
  const single = build();
  single.render("t", { page: 0 }, { start: 0, end: 6, total: 6, pageCount: 1 });
  assert.equal(single.nodes["#t-pagination"].hidden, true);

  // Nothing at all is likewise nothing to page through.
  const empty = build();
  empty.render("t", { page: 0 }, { start: 0, end: 0, total: 0, pageCount: 1 });
  assert.equal(empty.nodes["#t-pagination"].hidden, true);

  // More rows than fit: the pager appears and reports the real span, with the
  // buttons reflecting which end of the set the reader is standing on.
  const many = build();
  many.render("t", { page: 0 }, { start: 0, end: 10, total: 25, pageCount: 3 });
  assert.equal(many.nodes["#t-pagination"].hidden, false);
  assert.equal(many.nodes["#t-page-status"].textContent, "1–10 of 25");
  assert.equal(many.nodes["#t-page-prev"].disabled, true);
  assert.equal(many.nodes["#t-page-next"].disabled, false);

  const last = build();
  last.render("t", { page: 2 }, { start: 20, end: 25, total: 25, pageCount: 3 });
  assert.equal(last.nodes["#t-pagination"].hidden, false);
  assert.equal(last.nodes["#t-page-prev"].disabled, false);
  assert.equal(last.nodes["#t-page-next"].disabled, true);
});

test("cache-switch mobile cards carry their translated column labels", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const helperStart = source.indexOf("function cacheSwitchDataCell(");
  const helperEnd = source.indexOf("\nfunction renderAccountingCacheSwitchDetails", helperStart);
  const renderStart = helperEnd + 1;
  const renderEnd = source.indexOf("\nfunction appendCacheContinuityAllowance", renderStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "the mobile label helper is available");
  assert.ok(renderEnd > renderStart, "the cache-switch renderer is available");

  const element = (tagName, className = "", textContent = "") => ({
    tagName,
    className,
    textContent,
    children: [],
    attributes: new Map(),
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
  });
  const cacheSwitchDataCell = Function(
    "rawNode",
    "t",
    `${source.slice(helperStart, helperEnd)}\nreturn cacheSwitchDataCell;`,
  )(
    element,
    (key) => `translated:${key}`,
  );
  const disclosure = { hidden: true, open: false };
  const rows = element("tbody");
  const render = Function(
    "$",
    "clear",
    "node",
    "localizedNode",
    "cacheSwitchDataCell",
    "cacheDropThreadLinks",
    "cacheDropThreadCell",
    "formatCount",
    "formatApiMoney",
    "formatLocal",
    "cacheSwitchChangeDescription",
    "paginateCacheImpactRows",
    "cacheSwitchTablePagination",
    "cacheImpactTableSignature",
    "renderCacheImpactPagination",
    `${source.slice(renderStart, renderEnd)}\nreturn renderAccountingCacheSwitchDetails;`,
  )(
    (selector) => ({
      "#cache-switch-details": disclosure,
      "#cache-switch-rows": rows,
    })[selector] ?? null,
    (target) => { target.children.length = 0; },
    element,
    (tagName, className, key) => element(tagName, className, key),
    cacheSwitchDataCell,
    { cells: { switch: [] } },
    () => cacheSwitchDataCell("cache-drop-thread-cell", "Thread unavailable", "accounting.cacheDropThread.column"),
    String,
    (value) => `$${value.toFixed(2)}`,
    (value) => value,
    () => "Model: GPT-5.6 Terra → GPT-5.6 Sol",
    (values) => ({ rows: values, start: 0, end: values.length, total: values.length, pageCount: 1 }),
    { page: 0, signature: "" },
    () => "test",
    () => {},
  );

  render({
    status: "available",
    recent: [{
      observedAt: "Aug 16, 11:33 AM EDT",
      previousCacheReadTokens: 207_616,
      currentCacheReadTokens: 6_912,
      lostCacheTokens: 200_704,
      estimatedPremiumUsd: 0.9,
    }],
  });

  assert.equal(disclosure.hidden, false);
  assert.deepEqual(
    rows.children[0].children.map((cell) => cell.getAttribute("data-label")),
    [
      "translated:accounting.cacheDropThread.column",
      "translated:accounting.cacheSwitch.column.change",
      "translated:accounting.cacheSwitch.column.cacheRead",
      "translated:accounting.cacheSwitch.column.lostTokens",
      "translated:accounting.cacheSwitch.column.apiEquivalent",
    ],
  );
});

test("accounting tables page ten rows and reset for a changed set", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const CACHE_IMPACT_TABLE_PAGE_SIZE = 10;");
  const end = source.indexOf("\nlet localCompanionHealth", start);
  assert.ok(start >= 0 && end > start, "cache-impact pagination helper is available");
  const paginate = Function(
    `${source.slice(start, end)}\nreturn paginateCacheImpactRows;`,
  )();
  const rows = Array.from({ length: 25 }, (_, index) => index);
  const state = { page: 0, signature: "" };

  const first = paginate(rows, state, "set-a");
  assert.deepEqual(first.rows, rows.slice(0, 10));
  assert.deepEqual(
    { start: first.start, end: first.end, total: first.total, pageCount: first.pageCount },
    { start: 0, end: 10, total: 25, pageCount: 3 },
  );

  state.page = 2;
  const third = paginate(rows, state, "set-a");
  assert.deepEqual(third.rows, rows.slice(20));
  assert.equal(third.start, 20);
  assert.equal(third.end, 25);

  const changed = paginate(rows.slice(0, 12), state, "set-b");
  assert.equal(state.page, 0);
  assert.deepEqual(changed.rows, rows.slice(0, 10));

  const empty = paginate([], state, "empty");
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(
    { start: empty.start, end: empty.end, total: empty.total, pageCount: empty.pageCount },
    { start: 0, end: 0, total: 0, pageCount: 1 },
  );
});

test("cache-switch incomplete notes distinguish boundary and exact-order gaps", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function appendCacheSwitchMetricNote(container, impact) {");
  const end = source.indexOf("\nfunction cacheSwitchChangeDescription", start);
  assert.ok(start >= 0 && end > start, "cache-switch note helper is available");
  const appendNote = Function(
    "localizedNode",
    "finite",
    "formatCount",
    "document",
    "formatCacheSwitchPercentagePoints",
    "appendCacheImpactSubtotalNote",
    "cacheImpactCostView",
    `${source.slice(start, end)}\nreturn appendCacheSwitchMetricNote;`,
  )(
    (_tag, _className, key) => key,
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    String,
    { createTextNode: (value) => value },
    String,
    () => false,
    () => ({}),
  );
  const keyFor = (impact) => {
    const children = [];
    appendNote({ append: (...items) => children.push(...items) }, impact);
    return children[0];
  };

  assert.equal(keyFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredConfigurationChanges: 2,
    orderingCoverageGaps: 0,
  }), "accounting.cacheSwitch.noteIncomplete");
  assert.equal(keyFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredConfigurationChanges: 0,
    orderingCoverageGaps: 2,
  }), "accounting.cacheSwitch.noteIncompleteOrdering");
  assert.equal(keyFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredConfigurationChanges: 1,
    orderingCoverageGaps: 2,
  }), "accounting.cacheSwitch.noteIncompleteCombined");
});

test("cache-continuity notes distinguish unavailable, incomplete, zero, and observed states", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function appendCacheContinuityMetricNote(container, impact) {");
  const end = source.indexOf("\nfunction formatCacheContinuityGap", start);
  assert.ok(start >= 0 && end > start, "cache-continuity note helper is available");
  const documentRef = { createTextNode: (value) => value };
  const appendNote = Function(
    "localizedNode",
    "finite",
    "formatCount",
    "document",
    "appendCacheContinuityAllowance",
    "cacheContinuityUsesStandardFallback",
    "appendCacheImpactSubtotalNote",
    "cacheImpactCostView",
    `${source.slice(start, end)}\nreturn appendCacheContinuityMetricNote;`,
  )(
    (_tag, _className, key) => key,
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    String,
    documentRef,
    (container) => container.append("allowance"),
    () => false,
    () => false,
    () => ({}),
  );
  const keysFor = (impact) => {
    const children = [];
    appendNote({ append: (...items) => children.push(...items) }, impact);
    return children.filter((item) => item !== " ");
  };

  assert.deepEqual(keysFor({ status: "unavailable" }), [
    "accounting.cacheContinuity.noteUnavailable",
  ]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredReturns: 2,
    orderingCoverageGaps: 0,
  }), ["accounting.cacheContinuity.noteIncomplete"]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredReturns: 0,
    orderingCoverageGaps: 2,
  }), ["accounting.cacheContinuity.noteIncompleteOrdering"]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "incomplete",
    uncoveredReturns: 1,
    orderingCoverageGaps: 2,
  }), ["accounting.cacheContinuity.noteIncompleteCombined"]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "complete",
    cacheReadDrops: 0,
    comparableReturns: 3,
    unpricedDrops: 0,
  }), ["accounting.cacheContinuity.noteZero", "allowance"]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "complete",
    cacheReadDrops: 2,
    comparableReturns: 4,
    pricedDrops: 1,
    unpricedDrops: 1,
  }), [
    "accounting.cacheContinuity.noteObserved",
    "accounting.cacheContinuity.noteUnpriced",
  ]);
  assert.deepEqual(keysFor({
    status: "available",
    coverageStatus: "complete",
    cacheReadDrops: 2,
    comparableReturns: 4,
    pricedDrops: 2,
    unpricedDrops: 0,
    postCompactionRequests: 3,
    postCompactionCacheReadDrops: 2,
  }), [
    "accounting.cacheContinuity.noteObserved",
    "accounting.cacheContinuity.noteCompaction",
    "allowance",
  ]);
});

test("subtotal notes explain the ordering gap, Standard counterfactual and excluded prices without allowance claims", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const helpersStart = source.indexOf("function cacheSwitchMetricValue(impact) {");
  const switchEnd = source.indexOf("\nfunction cacheSwitchChangeDescription", helpersStart);
  const continuityStart = source.indexOf("function appendCacheContinuityMetricNote(container, impact) {");
  const continuityEnd = source.indexOf("\nfunction formatCacheContinuityGap", continuityStart);
  assert.ok(helpersStart >= 0 && switchEnd > helpersStart && continuityEnd > continuityStart);
  const appendNotes = Function(
    "finite", "formatApiMoney", "formatCount", "document", "localizedNode", "t",
    "appendCacheContinuityAllowance",
    `${source.slice(helpersStart, switchEnd)}\n${source.slice(continuityStart, continuityEnd)}`
      + "\nreturn { appendCacheSwitchMetricNote, appendCacheContinuityMetricNote };",
  )(
    (value, fallback = null) => typeof value === "number" && Number.isFinite(value) ? value : fallback,
    (value) => `$${value.toFixed(2)}`,
    String,
    { createTextNode: (value) => value },
    (_tag, _className, key, values) => translate(key, values, "en"),
    (key, values) => translate(key, values, "en"),
    () => assert.fail("a subset must not be translated into whole-period allowance"),
  );
  for (const [append, selected] of [
    [appendNotes.appendCacheSwitchMetricNote, switchSubtotalPeriod({ ordering: 1, unpriced: 1 })],
    [appendNotes.appendCacheContinuityMetricNote, continuitySubtotalPeriod({ ordering: 1, unpriced: 1 })],
  ]) {
    const children = [];
    append({ append: (...items) => children.push(...items) }, { status: "available", ...selected });
    const text = children.join("");
    assert.match(text, /Whole-period total unavailable/u);
    assert.match(text, /Sessions without exact local event order: 1/u);
    assert.match(text, /Covered\/priced subtotal; included drops: \d+\. Not a whole-period total/u);
    assert.match(text, /Standard API equivalent for the same covered\/priced drops: \$/u);
    assert.match(text, /Drops excluded for incomplete prices: 1/u);
    assert.doesNotMatch(text, /estimate is withheld|1 sessions|1 drops|percentage points|accounting\./u);
    const standardOnly = [];
    append({ append: (...items) => standardOnly.push(...items) }, {
      status: "available",
      ...selected,
      coveredSubtotal: {
        ...selected.coveredSubtotal,
        allowanceWeighting: unavailablePremiumWeighting(),
      },
    });
    assert.match(standardOnly.join(""), /Subtotal shown at Standard API rates/u);
    assert.match(standardOnly.join(""), /speed-priced accounting is unavailable/u);
  }
  for (const [append, empty] of [
    [appendNotes.appendCacheSwitchMetricNote, zeroBreakdown()],
    [appendNotes.appendCacheContinuityMetricNote, zeroContinuityBreakdown()],
  ]) {
    const children = [];
    append({ append: (...items) => children.push(...items) }, {
      status: "available",
      ...empty,
      standardApiPremiumUsd: 0,
      allowanceWeighting: premiumWeighting(0, 0, 0),
      allowanceImpact: {
        status: "complete",
        medianPercentagePoints: 0,
        plausibleRangePercentagePoints: null,
      },
    });
    const text = children.join("");
    assert.match(text, /no material cache-read drop observed/u);
    assert.doesNotMatch(text, /\$|API equivalent|allowance|percentage|subtotal/iu);
  }
});

test("cache chart readout shows valid bucket subtotals despite a global gap and never fabricates an unpriced zero", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderCacheReuseReadout(bucket, width, selectedRange,");
  const end = source.indexOf("\nfunction setCacheReuseReadoutVisible", start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const render = Function(
    "$", "cacheReusePercent", "setLocalizedText", "formatCount", "t", "formatApiMoney",
    `${source.slice(start, end)}\nreturn renderCacheReuseReadout;`,
  )(
    (selector) => {
      if (selector === "#cache-reuse-raster-stage") return null;
      if (!nodes.has(selector)) nodes.set(selector, { textContent: "" });
      return nodes.get(selector);
    },
    (count, total) => total === 0 ? "0%" : `${count / total * 100}%`,
    (element, key, values) => { element.textContent = translate(key, values, "en"); },
    String,
    (key, values) => translate(key, values, "en"),
    (value) => `$${value.toFixed(2)}`,
  );
  const moneyText = (bucket, completeCoverage) => {
    render({
      labelKey: "accounting.cacheContinuity.outcome.bucket.underOneMinute",
      ...bucket,
    }, 600, { start: 100, end: 150 }, completeCoverage);
    return nodes.get("#cache-reuse-readout-api").textContent;
  };
  const good = continuitySubtotalPeriod().byOutcomeBucket.under_one_minute;
  assert.equal(moneyText(good, true), "Standard API equivalent: $0.01");
  assert.match(moneyText(good, false), /Covered\/priced subtotal at Standard rates: \$0\.01/u);
  assert.match(moneyText(good, false), /Whole-period total unavailable/u);
  const partial = continuitySubtotalPeriod({ ordering: 1, unpriced: 1 })
    .byOutcomeBucket.under_one_minute;
  assert.equal(partial.estimatedPremiumUsd, null);
  assert.match(moneyText(partial, false), /\$0\.01\. Priced drops: 1; unpriced excluded: 1/u);
  // Exact admitted comparisons in legacy DTO buckets also remain useful;
  // global ordering gaps are never guessed into a particular time bucket.
  assert.match(moneyText({ ...good, coveredSubtotal: null }, false), /subtotal.*\$0\.01/u);
  for (const noPrice of [
    { ...partial, pricedDrops: 0, unpricedDrops: 2, coveredSubtotal: null },
    zeroContinuityBreakdown(),
  ]) {
    const text = moneyText(noPrice, false);
    assert.match(text, /Unavailable/u);
    assert.doesNotMatch(text, /\$0\.00/u);
  }
});

test("the history selector reads the analyzer's all-indexed period", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function accountingPeriod(data) {");
  const end = source.indexOf("\nfunction syncAccountingPeriodControls", start);
  assert.ok(start >= 0 && end > start, "accounting period selector is available");
  const select = Function(
    `${source.slice(start, end)}\nlet activeAccountingPeriod = "history";`
      + "\nreturn accountingPeriod;",
  )();
  const selected = select({
    accounting: {
      accountingSource: "test",
      replayExclusionDiagnostics: {},
      cacheSwitchImpact: {
        status: "available",
        periodId: "7d",
        coveredSubtotal: coveredSubtotal(2, 1),
        periods: [{
          status: "available", periodId: "all", marker: "all-indexed",
          coveredSubtotal: coveredSubtotal(25, 4),
        }],
      },
      cacheContinuityImpact: {
        status: "available",
        periodId: "7d",
        coveredSubtotal: coveredSubtotal(3, 1),
        periods: [{
          status: "available", periodId: "all",
          coveredSubtotal: coveredSubtotal(40, 5),
        }],
      },
      periods: [{ periodId: "history", cacheSwitchImpact: { status: "unavailable" } }],
    },
  });
  assert.equal(selected.cacheSwitchImpact.periodId, "all");
  assert.equal(selected.cacheSwitchImpact.marker, "all-indexed");
  assert.equal(selected.cacheSwitchImpact.allowanceImpact.status, "unavailable");
  assert.equal(selected.cacheSwitchImpact.coveredSubtotal.standardApiPremiumUsd, 25);
  assert.equal(selected.cacheSwitchImpact.coveredSubtotal.pricedDrops, 4);
  assert.equal(selected.cacheContinuityImpact.coveredSubtotal.standardApiPremiumUsd, 40);
  assert.equal(selected.cacheContinuityImpact.coveredSubtotal.pricedDrops, 5);
});

test("cache-impact UI copy has three-locale parity and collapsed evidence tables", async () => {
  const expectedLabels = [
    "Possible switch overhead",
    "可能的切换开销",
    "Posible coste adicional al cambiar",
  ];
  assert.deepEqual(
    SUPPORTED_LOCALES.map((locale) => (
      translate("accounting.cacheSwitch.metricLabel", {}, locale)
    )),
    expectedLabels,
  );
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "accounting.cacheImpact.subtotalValue",
      "accounting.cacheImpact.subtotalScope",
      "accounting.cacheImpact.subtotalStandard",
      "accounting.cacheImpact.subtotalStandardOnly",
      "accounting.cacheImpact.subtotalUnpriced",
      "accounting.cacheContinuity.outcome.readoutSubtotal",
    ]) {
      assert.doesNotMatch(translate(key, {
        amount: "$1.23", priced: "2", unpriced: "1",
      }, locale), /accounting\.|\{(?:amount|priced|unpriced)\}/u);
    }
    for (const key of [
      "table.pagination.previous",
      "table.pagination.next",
      "table.pagination.page",
    ]) {
      assert.doesNotMatch(
        translate(key, { start: "1", end: "10", total: "20" }, locale),
        /table\.pagination|\{(?:start|end|total)\}/u,
      );
    }
    assert.doesNotMatch(
      translate("accounting.cacheSwitch.metricExplanation", {}, locale),
      /accounting\.cacheSwitch/u,
    );
    assert.doesNotMatch(
      translate("accounting.cacheSwitch.column.lostTokens", {}, locale),
      /accounting\.cacheSwitch/u,
    );
  }
  assert.match(
    translate("accounting.cacheSwitch.allowanceRange", {
      lower: "1",
      upper: "2",
    }, "en"),
    /may combine accounts/u,
  );
  for (const locale of SUPPORTED_LOCALES) {
    assert.doesNotMatch(
      translate("accounting.cacheSwitch.noteIncompleteOrdering", {
        ordering: "2",
      }, locale),
      /accounting\.cacheSwitch|\{ordering\}/u,
    );
  }
  assert.match(
    translate("accounting.cacheSwitch.noteIncompleteOrdering", {
      ordering: "2",
    }, "en"),
    /exact local event order/u,
  );

  const [html, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<details[^>]+id="cache-switch-details"[^>]+hidden>/u);
  assert.doesNotMatch(
    html.match(/<details[^>]+id="cache-switch-details"[^>]*>/u)?.[0] ?? "",
    /\sopen(?:\s|>)/u,
  );
  assert.match(html, /<tbody id="cache-switch-rows"><\/tbody>/u);
  assert.match(html, /id="cache-switch-pagination"/u);
  assert.match(html, /id="cache-switch-page-prev"/u);
  assert.match(html, /id="cache-switch-page-next"/u);
  assert.match(html, /Est\. lost reuse/u);
  assert.match(html, /API equivalent/u);
  assert.equal(
    translate("accounting.cacheSwitch.column.lostTokens", {}, "en"),
    "Est. lost reuse",
  );
  assert.equal(
    translate("accounting.cacheSwitch.column.apiEquivalent", {}, "en"),
    "Standard API equivalent",
  );

  const expectedContinuityLabels = [
    "Possible cache-continuity overhead",
    "可能的缓存连续性开销",
    "Posible coste adicional de continuidad de caché",
  ];
  assert.deepEqual(
    SUPPORTED_LOCALES.map((locale) => (
      translate("accounting.cacheContinuity.metricLabel", {}, locale)
    )),
    expectedContinuityLabels,
  );
  assert.deepEqual(
    SUPPORTED_LOCALES.map((locale) => (
      translate("accounting.cacheContinuity.detailsSummary", {}, locale)
    )),
    [
      "See recent large cache drops",
      "查看近期缓存大幅下降",
      "Ver las caídas grandes de caché recientes",
    ],
  );
  for (const locale of SUPPORTED_LOCALES) {
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.metricExplanation", {}, locale),
      /accounting\.cacheContinuity/u,
    );
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.column.gap", {}, locale),
      /accounting\.cacheContinuity/u,
    );
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.noteIncompleteOrdering", {
        ordering: "2",
      }, locale),
      /accounting\.cacheContinuity|\{ordering\}/u,
    );
  }
  const outcomeBucketKeys = [
    "underOneMinute",
    "oneToTwoMinutes",
    "twoToFiveMinutes",
    "fiveToTenMinutes",
    "tenToThirtyMinutes",
    "thirtyMinutesToOneHour",
    "oneToSixHours",
    "sixToTwentyFourHours",
    "oneToThreeDays",
    "overThreeDays",
  ];
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "heading",
      "subtitle",
      "howToRead",
      "canvasLabel",
      "readoutLost",
      "readoutApi",
      "legendInline",
    ]) {
      assert.doesNotMatch(
        translate(`accounting.cacheContinuity.outcome.${key}`, {
          percent: "80%",
          matched: "8",
          between: "1",
          count: "10",
          more: "8",
          less: "2",
          unit: "20",
          tokens: "1,024",
          amount: "$0.01",
        }, locale),
        /accounting\.cacheContinuity|\{(?:percent|matched|between|count|more|less|unit|tokens|amount)\}/u,
      );
    }
    for (const key of ["overheadLabel", "overheadBasis"]) {
      assert.doesNotMatch(
        translate(`accounting.cacheContinuity.outcome.${key}`, {}, locale),
        /accounting\.cacheContinuity/u,
      );
    }
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.noteStandardFallback", {}, locale),
      /accounting\.cacheContinuity/u,
    );
    for (const key of outcomeBucketKeys) {
      assert.doesNotMatch(
        translate(`accounting.cacheContinuity.outcome.bucket.${key}`, {}, locale),
        /accounting\.cacheContinuity/u,
      );
    }
  }
  assert.equal(
    translate("accounting.cacheContinuity.column.gap", {}, "en"),
    "Time between turns",
  );
  assert.match(html, /<details[^>]+id="cache-continuity-details"[^>]+hidden>/u);
  assert.doesNotMatch(
    html.match(/<details[^>]+id="cache-continuity-details"[^>]*>/u)?.[0] ?? "",
    /\sopen(?:\s|>)/u,
  );
  const continuityDetails = html.slice(
    html.indexOf('id="cache-continuity-details"'),
    html.indexOf("</details>", html.indexOf('id="cache-continuity-details"')),
  );
  const continuityOutcome = html.slice(
    html.indexOf('id="cache-reuse-outcome"'),
    html.indexOf("</section>", html.indexOf('id="cache-reuse-outcome"')),
  );
  assert.match(
    html.match(/<section[^>]+id="cache-reuse-outcome"[^>]*>/u)?.[0] ?? "",
    /\shidden(?:\s|>)/u,
  );
  assert.ok(
    html.indexOf('id="cache-reuse-outcome"')
      < html.indexOf('id="cache-continuity-details"'),
    "cache outcome is a first-class section before the recent-evidence disclosure",
  );
  assert.doesNotMatch(continuityDetails, /id="cache-reuse-outcome"/u);
  assert.match(continuityDetails, /See recent large cache drops/u);
  assert.match(continuityOutcome, /<canvas id="cache-reuse-canvas"/u);
  assert.match(continuityOutcome, /id="cache-reuse-readout"/u);
  assert.match(
    continuityOutcome,
    /id="cache-reuse-readout-rail"[^>]+hidden/u,
  );
  assert.match(continuityOutcome, /id="cache-reuse-readout-lost"/u);
  assert.match(continuityOutcome, /id="cache-reuse-readout-api"/u);
  assert.match(continuityOutcome, /id="cache-reuse-overhead"/u);
  assert.doesNotMatch(continuityOutcome, /id="cache-reuse-checked"/u);
  assert.doesNotMatch(continuityOutcome, /id="cache-reuse-mark-unit"/u);
  assert.doesNotMatch(continuityOutcome, /cache-reuse-(?:privacy|timeout-note|detail)/u);
  assert.doesNotMatch(
    continuityDetails,
    /accounting\.cacheContinuity\.detailsExplanation/u,
  );
  assert.match(
    styles,
    /\.cache-reuse-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(3,/u,
  );
  assert.match(
    styles,
    /\.cache-reuse-raster-scroll\s*\{[^}]*overflow:\s*visible/u,
  );
  assert.match(
    styles,
    /\.cache-reuse-raster-stage\s*\{[^}]*min-width:\s*0/u,
  );
  assert.doesNotMatch(continuityOutcome, /cache-continuity-gap-(?:rows|pagination|page)/u);
  assert.doesNotMatch(continuityOutcome, /cache-continuity-gap-table/u);
  assert.match(html, /<tbody id="cache-continuity-rows"><\/tbody>/u);
  assert.match(continuityDetails, /id="cache-continuity-pagination"/u);
  assert.match(continuityDetails, /id="cache-continuity-page-prev"/u);
  assert.match(continuityDetails, /id="cache-continuity-page-next"/u);
  assert.match(html, /Time between turns/u);
});
