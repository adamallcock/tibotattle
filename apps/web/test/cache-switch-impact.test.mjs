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
  "codex_primary:quota_weighted_api_equivalent:v1:fast_rates_2026_08_01:event_time:observed_declared_scenario";

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
    "lostCacheTokens",
    "observedAt",
    "previous",
    "previousCacheReadTokens",
  ]);
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
    `${source.slice(start, end)}\nreturn {`
      + " cacheSwitchMetricValue, cacheContinuityStandardMetricValue,"
      + " cacheContinuityMetricValue,"
      + " cacheContinuityUsesStandardFallback };",
  )(
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    (value) => value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`,
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
      "translated:accounting.cacheSwitch.column.localTime",
      "translated:accounting.cacheSwitch.column.change",
      "translated:accounting.cacheSwitch.column.cacheRead",
      "translated:accounting.cacheSwitch.column.lostTokens",
      "translated:accounting.cacheSwitch.column.apiEquivalent",
    ],
  );
});

test("single-turn evidence keeps every advanced cache module visible without figures", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const element = (tagName, className = "", textContent = "") => ({
    tagName,
    className,
    textContent,
    children: [],
    hidden: true,
    open: true,
    append(...items) { this.children.push(...items); },
  });
  const clear = (target) => { target.children.length = 0; };
  const localizedNode = (tagName, className, key) => element(tagName, className, key);
  const paginate = (rows) => ({
    rows,
    start: 0,
    end: rows.length,
    total: rows.length,
    pageCount: 1,
  });

  const switchDisclosure = element("details");
  const switchRows = element("tbody");
  const switchStart = source.indexOf("function renderAccountingCacheSwitchDetails(impact) {");
  const switchEnd = source.indexOf("\nfunction appendCacheContinuityAllowance", switchStart);
  assert.ok(switchStart >= 0 && switchEnd > switchStart, "switch renderer is available");
  const renderSwitch = Function(
    "$",
    "clear",
    "node",
    "localizedNode",
    "paginateCacheImpactRows",
    "cacheSwitchTablePagination",
    "renderCacheImpactPagination",
    `${source.slice(switchStart, switchEnd)}\nreturn renderAccountingCacheSwitchDetails;`,
  )(
    (selector) => ({
      "#cache-switch-details": switchDisclosure,
      "#cache-switch-rows": switchRows,
    })[selector] ?? null,
    clear,
    element,
    localizedNode,
    paginate,
    { page: 0, signature: "" },
    () => {},
  );

  const reuseOutcome = element("section");
  const reuseSummary = element("div");
  const reuseBadge = element("div");
  reuseOutcome.querySelector = (selector) => ({
    ".cache-reuse-summary": reuseSummary,
    ".cache-reuse-real-data": reuseBadge,
  })[selector] ?? null;
  const reuseRaster = element("div");
  const reuseEmpty = element("p");
  const reuseStart = source.indexOf("function renderAccountingCacheReuseOutcome(impact) {");
  const reuseEnd = source.indexOf("\nfunction selectCacheReuseBucketFromPointer", reuseStart);
  assert.ok(reuseStart >= 0 && reuseEnd > reuseStart, "reuse renderer is available");
  const renderReuse = Function(
    "$",
    "cacheReuseOutcomeBuckets",
    "setLocalizedText",
    `let cacheReuseCurrentImpact = null;
     let cacheReuseRenderedPeriodId = null;
     let cacheReuseSelectedBucketIndex = 2;
     ${source.slice(reuseStart, reuseEnd)}
     return renderAccountingCacheReuseOutcome;`,
  )(
    (selector) => ({
      "#cache-reuse-outcome": reuseOutcome,
      "#cache-reuse-raster": reuseRaster,
      "#cache-reuse-empty": reuseEmpty,
    })[selector] ?? null,
    () => null,
    (target, key) => { target.textContent = key; },
  );

  const continuityDisclosure = element("details");
  const continuityRows = element("tbody");
  const continuityStart = source.indexOf("function renderAccountingCacheContinuityDetails(impact) {");
  const continuityEnd = source.indexOf("\nfunction sideChatConfigurationDescription", continuityStart);
  assert.ok(
    continuityStart >= 0 && continuityEnd > continuityStart,
    "continuity renderer is available",
  );
  const renderContinuity = Function(
    "$",
    "clear",
    "node",
    "localizedNode",
    "renderAccountingCacheReuseOutcome",
    "paginateCacheImpactRows",
    "cacheContinuityTablePagination",
    "renderCacheImpactPagination",
    `${source.slice(continuityStart, continuityEnd)}\nreturn renderAccountingCacheContinuityDetails;`,
  )(
    (selector) => ({
      "#cache-continuity-details": continuityDisclosure,
      "#cache-continuity-rows": continuityRows,
    })[selector] ?? null,
    clear,
    element,
    localizedNode,
    renderReuse,
    paginate,
    { page: 0, signature: "" },
    () => {},
  );

  // This is the same evidence shape a one-turn synthetic profile produces:
  // no adjacent configuration change or follow-up return can qualify.
  renderSwitch(null);
  renderContinuity(null);

  assert.equal(switchDisclosure.hidden, false);
  assert.equal(switchRows.children.length, 1);
  assert.equal(
    switchRows.children[0].children[0].textContent,
    "accounting.cacheSwitch.detailsUnavailable",
  );
  assert.equal(switchRows.children[0].children[0].colSpan, 5);
  assert.equal(continuityDisclosure.hidden, false);
  assert.equal(continuityRows.children.length, 1);
  assert.equal(
    continuityRows.children[0].children[0].textContent,
    "accounting.cacheContinuity.detailsUnavailable",
  );
  assert.equal(continuityRows.children[0].children[0].colSpan, 6);
  assert.equal(reuseOutcome.hidden, false);
  assert.equal(reuseSummary.hidden, true);
  assert.equal(reuseBadge.hidden, true);
  assert.equal(reuseRaster.hidden, true);
  assert.equal(reuseEmpty.hidden, false);
  assert.equal(
    reuseEmpty.textContent,
    "accounting.cacheContinuity.outcome.insufficientEvidence",
  );
  assert.doesNotMatch(reuseEmpty.textContent, /0(?:%|\.|,|\b)/u);
});

test("available advanced cache evidence continues to render its real rows and reuse values", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const element = (tagName, className = "", textContent = "") => ({
    tagName,
    className,
    textContent,
    children: [],
    hidden: true,
    open: false,
    append(...items) { this.children.push(...items); },
  });
  const clear = (target) => { target.children.length = 0; };
  const paginate = (rows) => ({
    rows,
    start: 0,
    end: rows.length,
    total: rows.length,
    pageCount: 1,
  });

  const continuityDisclosure = element("details");
  const continuityRows = element("tbody");
  const continuityStart = source.indexOf("function renderAccountingCacheContinuityDetails(impact) {");
  const continuityEnd = source.indexOf("\nfunction sideChatConfigurationDescription", continuityStart);
  const reuseCalls = [];
  const renderContinuity = Function(
    "$",
    "clear",
    "node",
    "rawNode",
    "localizedNode",
    "renderAccountingCacheReuseOutcome",
    "paginateCacheImpactRows",
    "cacheContinuityTablePagination",
    "cacheImpactTableSignature",
    "renderCacheImpactPagination",
    "formatLocal",
    "formatCacheContinuityGap",
    "cacheContinuityConfigurationDescription",
    "formatCount",
    "formatApiMoney",
    `${source.slice(continuityStart, continuityEnd)}\nreturn renderAccountingCacheContinuityDetails;`,
  )(
    (selector) => ({
      "#cache-continuity-details": continuityDisclosure,
      "#cache-continuity-rows": continuityRows,
    })[selector] ?? null,
    clear,
    element,
    element,
    (tagName, className, key) => element(tagName, className, key),
    (impact) => reuseCalls.push(impact),
    paginate,
    { page: 0, signature: "" },
    () => "continuity",
    () => {},
    (value) => value,
    (seconds) => `${seconds}s`,
    () => "GPT-5.6 Sol · high",
    String,
    (value) => `$${value.toFixed(2)}`,
  );
  const impact = {
    status: "available",
    periodId: "7d",
    recent: [{
      observedAt: "Aug 16, 11:33 AM EDT",
      gapSeconds: 45,
      configuration: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      previousCacheReadTokens: 8_000,
      currentCacheReadTokens: 1_000,
      lostCacheTokens: 7_000,
      estimatedPremiumUsd: 0.5,
    }],
  };
  renderContinuity(impact);
  assert.equal(continuityDisclosure.hidden, false);
  assert.equal(reuseCalls[0], impact);
  assert.equal(continuityRows.children.length, 1);
  assert.deepEqual(
    continuityRows.children[0].children.map((cell) => cell.textContent),
    ["Aug 16, 11:33 AM EDT", "45s", "GPT-5.6 Sol · high", "8000 → 1000", "7000", "$0.50"],
  );

  const reuseOutcome = element("section");
  const reuseSummary = element("div");
  const reuseBadge = element("div");
  reuseOutcome.querySelector = (selector) => ({
    ".cache-reuse-summary": reuseSummary,
    ".cache-reuse-real-data": reuseBadge,
  })[selector] ?? null;
  const reuseRaster = element("div");
  const reuseEmpty = element("p");
  const values = {};
  const reuseStart = source.indexOf("function renderAccountingCacheReuseOutcome(impact) {");
  const reuseEnd = source.indexOf("\nfunction selectCacheReuseBucketFromPointer", reuseStart);
  const renderReuse = Function(
    "$",
    "cacheReuseOutcomeBuckets",
    "cacheReusePercent",
    "setRawText",
    "cacheContinuityStandardMetricValue",
    "setLocalizedText",
    "formatCount",
    "chooseCacheReuseMarkUnit",
    "drawCacheReuseRaster",
    "ensureCacheReuseResizeObserver",
    `const CACHE_REUSE_DEFAULT_BUCKET_INDEX = 2;
     let cacheReuseCurrentImpact = null;
     let cacheReuseRenderedPeriodId = null;
     let cacheReuseSelectedBucketIndex = 2;
     ${source.slice(reuseStart, reuseEnd)}
     return renderAccountingCacheReuseOutcome;`,
  )(
    (selector) => ({
      "#cache-reuse-outcome": reuseOutcome,
      "#cache-reuse-raster": reuseRaster,
      "#cache-reuse-empty": reuseEmpty,
      "#cache-reuse-more-percent": { id: "more" },
      "#cache-reuse-less-percent": { id: "less" },
      "#cache-reuse-overhead": { id: "overhead" },
      "#cache-reuse-more-count": { id: "more-count" },
      "#cache-reuse-less-count": { id: "less-count" },
      "#cache-reuse-explanation": { id: "explanation" },
    })[selector] ?? null,
    () => [{ id: "two_to_five_minutes" }],
    (part, whole) => `${part}/${whole}`,
    (target, value) => { values[target.id] = value; },
    () => "$0.50",
    (target, key, args = {}) => { values[target.id ?? "empty"] = { key, args }; },
    String,
    () => 100,
    () => {},
    () => {},
  );
  renderReuse({
    periodId: "7d",
    comparableReturns: 2,
    reusedMoreThanHalfReturns: 1,
    reusedHalfOrLessReturns: 1,
    matchedOrExceededReturns: 1,
    reusedBetweenHalfAndPreviousReturns: 0,
  });
  assert.equal(reuseOutcome.hidden, false);
  assert.equal(reuseSummary.hidden, false);
  assert.equal(reuseBadge.hidden, false);
  assert.equal(reuseRaster.hidden, false);
  assert.equal(reuseEmpty.hidden, true);
  assert.deepEqual(values, {
    more: "1/2",
    less: "1/2",
    overhead: "$0.50",
    "more-count": {
      key: "accounting.cacheContinuity.outcome.followUps",
      args: { count: "1" },
    },
    "less-count": {
      key: "accounting.cacheContinuity.outcome.followUps",
      args: { count: "1" },
    },
    explanation: {
      key: "accounting.cacheContinuity.outcome.howToRead",
      args: { percent: "1/2", matched: "1", between: "0" },
    },
    empty: { key: "accounting.cacheContinuity.outcome.noData", args: {} },
  });
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
    `${source.slice(start, end)}\nreturn appendCacheSwitchMetricNote;`,
  )(
    (_tag, _className, key) => key,
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    String,
    { createTextNode: (value) => value },
    String,
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
        periods: [{ status: "available", periodId: "all", marker: "all-indexed" }],
      },
      periods: [{ periodId: "history", cacheSwitchImpact: { status: "unavailable" } }],
    },
  });
  assert.equal(selected.cacheSwitchImpact.periodId, "all");
  assert.equal(selected.cacheSwitchImpact.marker, "all-indexed");
  assert.equal(selected.cacheSwitchImpact.allowanceImpact.status, "unavailable");
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
      translate("accounting.cacheSwitch.detailsUnavailable", {}, locale),
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
  assert.match(
    translate("accounting.cacheSwitch.detailsUnavailable", {}, "en"),
    /Not enough eligible local evidence/u,
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
    "API equivalent",
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
  assert.match(
    translate("accounting.cacheContinuity.detailsUnavailable", {}, "en"),
    /Not enough eligible local evidence/u,
  );
  assert.match(
    translate("accounting.cacheContinuity.outcome.insufficientEvidence", {}, "en"),
    /No percentages or estimates are shown/u,
  );
  for (const locale of SUPPORTED_LOCALES) {
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.metricExplanation", {}, locale),
      /accounting\.cacheContinuity/u,
    );
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.detailsUnavailable", {}, locale),
      /accounting\.cacheContinuity/u,
    );
    assert.doesNotMatch(
      translate("accounting.cacheContinuity.outcome.insufficientEvidence", {}, locale),
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
