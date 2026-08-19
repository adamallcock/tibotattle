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

function zeroContinuityBreakdown() {
  return {
    sameConfigurationReturns: 0,
    comparableReturns: 0,
    compactionConfoundedReturns: 0,
    contextContractedReturns: 0,
    insufficientEvidenceReturns: 0,
    uncoveredReturns: 0,
    coverageStatus: "complete",
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    pricedDrops: 0,
    unpricedDrops: 0,
    estimatedPremiumUsd: 0,
  };
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
  assert.equal(result.sameConfigurationReturns, 1);
  assert.equal(result.comparableReturns, 1);
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
});

test("cache-continuity normalization fails closed on methodology and partitions", () => {
  assert.equal(normalizedContinuityImpact({}).status, "unavailable");
  assert.equal(normalizedContinuityImpact(continuityImpact({
    minimumGapSeconds: 1_800,
  })).status, "unavailable");

  const invalidPartition = continuityPeriod({
    sameConfigurationReturns: 2,
  });
  assert.equal(normalizedContinuityImpact(continuityImpact({
    ...invalidPartition,
    periods: [invalidPartition],
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

test("cache-switch money rendering distinguishes unavailable from evaluated zero", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function cacheSwitchMetricValue(impact) {");
  const end = source.indexOf("\nfunction appendCacheSwitchMetricNote", start);
  assert.ok(start >= 0 && end > start, "cache-switch metric helper is available");
  const metricValue = Function(
    "finite",
    "formatApiMoney",
    `${source.slice(start, end)}\nreturn cacheSwitchMetricValue;`,
  )(
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    (value) => value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`,
  );
  assert.equal(metricValue({ status: "unavailable", estimatedPremiumUsd: 0 }), "—");
  assert.equal(metricValue({ status: "available", allowanceWeighting: null }), "—");
  assert.equal(metricValue({
    status: "available",
    allowanceWeighting: { status: "complete", selectedPremiumUsd: 0 },
  }), "$0.00");
  assert.equal(metricValue({
    status: "available",
    allowanceWeighting: { status: "complete", selectedPremiumUsd: 0.005 },
  }), "<$0.01");
  assert.equal(metricValue({
    status: "available",
    allowanceWeighting: {
      status: "range",
      rangePremiumUsd: { lower: 0.01, upper: 0.025 },
    },
  }), "$0.01–$0.03");
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
    `${source.slice(start, end)}\nreturn appendCacheContinuityMetricNote;`,
  )(
    (_tag, _className, key) => key,
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    String,
    documentRef,
    (container) => container.append("allowance"),
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

test("cache-continuity time bands render all seven summaries and fail closed", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const CACHE_CONTINUITY_GAP_BAND_UI = Object.freeze([");
  const end = source.indexOf(
    "\nfunction renderAccountingCacheContinuityDetails",
    start,
  );
  assert.ok(start >= 0 && end > start, "cache-continuity gap renderer is available");
  const element = (tagName, className = "", textContent = "") => ({
    tagName,
    className,
    textContent,
    children: [],
    append(...items) { this.children.push(...items); },
  });
  const renderRows = Function(
    "clear",
    "node",
    "localizedNode",
    "rawNode",
    "formatCount",
    "formatApiMoney",
    "paginateCacheImpactRows",
    "cacheContinuityGapTablePagination",
    "cacheImpactTableSignature",
    "renderCacheImpactPagination",
    `${source.slice(start, end)}\nreturn renderAccountingCacheContinuityGapRows;`,
  )(
    (target) => { target.children.length = 0; },
    element,
    (tagName, className, key) => element(tagName, className, key),
    element,
    String,
    (value) => `$${value.toFixed(2)}`,
    (values) => ({
      rows: values,
      start: 0,
      end: values.length,
      total: values.length,
      pageCount: 1,
    }),
    { page: 0, signature: "" },
    () => "test",
    () => {},
  );

  const rows = element("tbody");
  renderRows(continuityImpact(), rows);
  assert.equal(rows.children.length, 7);
  assert.deepEqual(
    rows.children.map((row) => row.children[0].textContent),
    [
      "accounting.cacheContinuity.gapBand.underOneMinute",
      "accounting.cacheContinuity.gapBand.oneToFiveMinutes",
      "accounting.cacheContinuity.gapBand.fiveToThirtyMinutes",
      "accounting.cacheContinuity.gapBand.thirtyMinutesToOneHour",
      "accounting.cacheContinuity.gapBand.oneToSixHours",
      "accounting.cacheContinuity.gapBand.sixToTwentyFourHours",
      "accounting.cacheContinuity.gapBand.overTwentyFourHours",
    ],
  );
  assert.equal(rows.children[0].children[1].textContent, "1 / 1");
  assert.equal(rows.children[0].children[2].textContent, "8000");
  assert.equal(rows.children[0].children[3].textContent, "$0.01");
  assert.equal(rows.children[1].children[3].textContent, "$0.00");

  const unpriced = continuityImpact();
  unpriced.byGapBand.under_one_minute = {
    ...unpriced.byGapBand.under_one_minute,
    pricedDrops: 0,
    unpricedDrops: 1,
    estimatedPremiumUsd: null,
  };
  renderRows(unpriced, rows);
  assert.equal(
    rows.children[0].children[3].textContent,
    "accounting.cacheContinuity.premiumUnavailable",
  );

  const orderingIncomplete = continuityImpact();
  orderingIncomplete.coverageStatus = "incomplete";
  orderingIncomplete.orderingCoverageGaps = 1;
  orderingIncomplete.estimatedPremiumUsd = null;
  renderRows(orderingIncomplete, rows);
  assert.equal(rows.children.length, 7);
  assert.ok(rows.children.every((row) => (
    row.children[3].textContent
      === "accounting.cacheContinuity.premiumUnavailable"
  )));

  const incomplete = continuityImpact();
  delete incomplete.byGapBand.over_twenty_four_hours;
  renderRows(incomplete, rows);
  assert.equal(rows.children.length, 1);
  assert.equal(
    rows.children[0].children[0].textContent,
    "accounting.cacheContinuity.gapBreakdownUnavailable",
  );
  assert.equal(rows.children[0].children[0].colSpan, 4);
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

  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<details[^>]+id="cache-switch-details"[^>]+hidden>/u);
  assert.doesNotMatch(
    html.match(/<details[^>]+id="cache-switch-details"[^>]*>/u)?.[0] ?? "",
    /\sopen(?:\s|>)/u,
  );
  assert.match(html, /<tbody id="cache-switch-rows"><\/tbody>/u);
  assert.match(html, /id="cache-switch-pagination"/u);
  assert.match(html, /id="cache-switch-page-prev"/u);
  assert.match(html, /id="cache-switch-page-next"/u);
  assert.match(html, /Estimated lost reuse/u);

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
  const continuityBandKeys = [
    "underOneMinute",
    "oneToFiveMinutes",
    "fiveToThirtyMinutes",
    "thirtyMinutesToOneHour",
    "oneToSixHours",
    "sixToTwentyFourHours",
    "overTwentyFourHours",
  ];
  assert.deepEqual(
    continuityBandKeys.map((key) => (
      translate(`accounting.cacheContinuity.gapBand.${key}`, {}, "en")
    )),
    [
      "Under 1 minute",
      "1–5 minutes",
      "5–30 minutes",
      "30 minutes–1 hour",
      "1–6 hours",
      "6–24 hours",
      "Over 24 hours",
    ],
  );
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of continuityBandKeys) {
      assert.doesNotMatch(
        translate(`accounting.cacheContinuity.gapBand.${key}`, {}, locale),
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
  assert.match(continuityDetails, /<tbody id="cache-continuity-gap-rows"><\/tbody>/u);
  assert.match(continuityDetails, /id="cache-continuity-gap-pagination"/u);
  assert.match(continuityDetails, /id="cache-continuity-gap-page-prev"/u);
  assert.match(continuityDetails, /id="cache-continuity-gap-page-next"/u);
  assert.match(html, /<tbody id="cache-continuity-rows"><\/tbody>/u);
  assert.match(continuityDetails, /id="cache-continuity-pagination"/u);
  assert.match(continuityDetails, /id="cache-continuity-page-prev"/u);
  assert.match(continuityDetails, /id="cache-continuity-page-next"/u);
  assert.ok(
    continuityDetails.indexOf('id="cache-continuity-gap-rows"')
      < continuityDetails.indexOf('id="cache-continuity-rows"'),
    "aggregate gap rows precede recent evidence rows",
  );
  assert.match(html, /Time between turns/u);
});
