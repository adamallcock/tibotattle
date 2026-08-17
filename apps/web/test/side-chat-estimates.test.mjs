import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeDashboardPayload } from "../public/data-client.js";

const ALLOWANCE_BASIS_FAMILY =
  "codex_primary:quota_weighted_api_equivalent:v1:fast_rates_2026_08_01:event_time:observed_declared_scenario";
const allowanceBasisId = (scenario) =>
  `${ALLOWANCE_BASIS_FAMILY}:${scenario}`;
const MATCHED_COHORT_ID =
  "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8";

function allowanceScenario(scenario, quotaWeightedUsd) {
  return {
    basisId: allowanceBasisId(scenario),
    sourceWeightingStatus: "complete",
    quotaWeightedUsd,
    coveredSubtotalUsd: quotaWeightedUsd,
    coverage: {
      totalEvents: 1,
      observedEvents: 0,
      declaredFromConfigEvents: 0,
      assumedFromPreferenceEvents: 1,
      inferredEvents: 0,
      unknownEvents: 0,
    },
  };
}

function allowanceCapacity(cohortIds = [MATCHED_COHORT_ID, MATCHED_COHORT_ID]) {
  const scenario = (name, medianCapacityUsd, cohortId) => ({
    basisId: allowanceBasisId(name),
    medianCapacityUsd,
    plausibleRangeUsd: {
      lower: medianCapacityUsd * 0.8,
      upper: medianCapacityUsd * 1.2,
    },
    qualifyingResets: 10,
    cohortId,
    validation: {
      sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 2,
      priorResetMeanAbsoluteErrorPercentagePoints: 3,
      priorResetAbsoluteBiasPercentagePoints: 1,
      forecastErrorP80PercentagePoints: 5,
      scoredPriorResets: 8,
      scoredPriorPoints: 40,
    },
  });
  return {
    status: "range",
    reason: null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY,
    selectedScenario: null,
    scenarios: {
      unresolved_as_standard: scenario(
        "unresolved_as_standard",
        100,
        cohortIds[0],
      ),
      unresolved_as_fast: scenario(
        "unresolved_as_fast",
        250,
        cohortIds[1],
      ),
    },
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  };
}

const ASSUMPTIONS = {
  activeToProviderTotal: {
    lowerCost: 1.1137,
    point: 1.0172,
    upperCost: 1.0007,
  },
  outputToInput: {
    lowerCost: 0.00071,
    point: 0.0024,
    upperCost: 0.00953,
  },
  ordinaryCacheReadShare: {
    lowerCost: 0.9954,
    point: 0.9857,
    upperCost: 0,
  },
  postCompactionCacheReadShare: {
    lowerCost: 0,
    point: 0,
    upperCost: 0,
  },
  uncachedRemainderCacheWriteShare: {
    lowerCost: 0,
    point: 0,
    upperCost: 1,
  },
  warmEligibilitySeconds: {
    gpt56: 1800,
    other: 300,
  },
};

function period(periodId) {
  return {
    periodId,
    periodLabel: periodId === "all" ? "All retained" : periodId,
    startAt: periodId === "all" ? null : "2026-08-10T12:00:00.000Z",
    endAt: "2026-08-17T12:00:00.000Z",
    detectedSessions: 2,
    retainedSessions: 1,
    visibleTurns: 1,
    samplingCalls: 1,
    activeContextTokens: 100_000,
    postCompactionCalls: 0,
    pricedCalls: 1,
    unpricedCalls: 0,
    estimatedApiPriceEquivalentUsd: 0.1,
    estimatedRangeUsd: { lower: 0.08, upper: 0.2 },
  };
}

function estimate(overrides = {}) {
  return {
    schemaVersion: "development-side-chat-estimate-v0.4",
    status: "available",
    errorCode: null,
    generatedAt: "2026-08-17T12:00:00.000Z",
    methodology: {
      parserVersion: "desktop-fork-logs2-active-context-v0.3",
      ordinaryAssumption: "warm_prefix",
      postCompactionAssumption: "cold_first_request",
      elapsedRetentionAssumption: "warm_to_cold_sensitivity",
      coldUpperInputTreatment: "cache_write_when_reviewed_else_uncached",
      parentCacheStateObserved: false,
      compactionCostIncluded: false,
      componentEvidence: "reconstructed_from_active_context",
      retentionScope: "active_logs2_approximately_ten_days",
      approximateRetentionDays: 10,
      includedInExactUsage: false,
      includedInCalibrationTimeline: true,
      calibrationStatus: "eligible_active_retention",
      calibrationCohort: {
        model: "gpt-5.6-sol",
        reasoningEfforts: ["high", "max", "ultra"],
        matchedDurableCalls: 818,
        calibratedAt: "2026-08-17T02:20:00.000Z",
        freshForSeconds: 2_592_000,
        maximumActiveContextTokens: 271_999,
      },
      assumptions: ASSUMPTIONS,
    },
    coverage: {
      desktop: {
        filesScanned: 2,
        bytesScanned: 1_000,
        oversizedLinesSkipped: 0,
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: "2026-08-17T12:00:00.000Z",
      },
      logs2: {
        startAt: "2026-08-16T00:00:00.000Z",
        endAt: "2026-08-17T12:00:00.000Z",
        sourceScope: "active_logs2_retention_only",
      },
      detectedSessions: 2,
      retainedNumericSessions: 1,
      completeNumericSessions: 1,
      sessionsAtRetentionLimit: 0,
      sessionsWithoutNumericEvidence: 1,
      duplicateSamplingMarkers: 0,
      ambiguousDuplicateMarkers: 0,
      rejectedSamplingMarkers: 0,
      rejectedCompactionMarkers: 0,
      compactionMarkers: 0,
      status: "partial_diagnostic_retention",
    },
    periods: ["24h", "7d", "30d", "all"].map(period),
    recent: Array.from({ length: 510 }, (_, index) => ({
      observedAt: new Date(Date.UTC(2026, 7, 17, 11, index % 60)).toISOString(),
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      turnOrdinal: 1,
      activeContextTokens: 100_000 + index,
      cacheAssumption: "warm_prefix",
      compactionBefore: false,
      estimatedApiPriceEquivalentUsd: 0.1,
      estimatedRangeUsd: { lower: 0.08, upper: 0.2 },
      pricingBasis: "reviewed_model_card",
      threadId: "private-child",
      prompt: "private prompt",
      sourcePath: "/private/log",
    })),
    recentDetailLimit: 500,
    recentTruncated: true,
    ...overrides,
  };
}

function historicalGapProbe(overrides = {}) {
  const historicalCoverage = {
    totalEvents: 3,
    observedEvents: 2,
    declaredFromConfigEvents: 0,
    assumedFromPreferenceEvents: 1,
    inferredEvents: 0,
    unknownEvents: 0,
  };
  return {
    schemaVersion: "development-side-chat-historical-gap-v0.2",
    status: "available",
    errorCode: null,
    date: "2026-07-13",
    timeZone: "America/New_York",
    startAt: "2026-07-13T04:00:00.000Z",
    endAt: "2026-07-14T04:00:00.000Z",
    basis: "quota_residual_backcast_not_observed_side_chat_usage",
    quota: {
      limitId: "codex",
      slot: "primary",
      durationMinutes: 10_080,
      resetAt: "2026-07-19T19:00:50.000Z",
      startBefore: {
        observedAt: "2026-07-13T03:55:00.000Z",
        usedPercent: 10,
      },
      startAfter: {
        observedAt: "2026-07-13T04:05:00.000Z",
        usedPercent: 10,
      },
      endBefore: {
        observedAt: "2026-07-14T03:55:00.000Z",
        usedPercent: 30,
      },
      endAfter: {
        observedAt: "2026-07-14T04:05:00.000Z",
        usedPercent: 30,
      },
      minimumMovementPercentagePoints: 20,
      maximumMovementPercentagePoints: 20,
      observationPrecision: "whole_percentage_points",
    },
    exactUsage: {
      events: 3,
      sessions: 3,
      totalTokens: 303_000,
      observedModels: ["gpt-5.6-terra"],
      standardApiPriceEquivalentUsd: 3,
      allowanceWeighting: {
        status: "complete",
        basisFamilyId: ALLOWANCE_BASIS_FAMILY,
        selectedScenario: "unresolved_as_standard",
        selectedUsd: 4.5,
        scenarios: {
          unresolved_as_standard: {
            basisId: allowanceBasisId("unresolved_as_standard"),
            sourceWeightingStatus: "complete",
            quotaWeightedUsd: 4.5,
            coveredSubtotalUsd: 4.5,
            coverage: historicalCoverage,
          },
          unresolved_as_fast: {
            basisId: allowanceBasisId("unresolved_as_fast"),
            sourceWeightingStatus: "complete",
            quotaWeightedUsd: 6,
            coveredSubtotalUsd: 6,
            coverage: historicalCoverage,
          },
        },
        rangeUsd: null,
      },
      quotaWeightedApiPriceEquivalentRangeUsd: {
        lower: 4.5,
        upper: 6,
      },
      pricingCoverage: { pricedEvents: 3, unpricedEvents: 0 },
      speedWeightingCoverage: {
        unsupportedEvents: 0,
        unknownSpeedEvents: 1,
      },
      bySpeed: {
        fast: {
          events: 1,
          totalTokens: 101_000,
          standardApiPriceEquivalentUsd: 1,
        },
        standard: {
          events: 1,
          totalTokens: 101_000,
          standardApiPriceEquivalentUsd: 1,
        },
        unknown: {
          events: 1,
          totalTokens: 101_000,
          standardApiPriceEquivalentUsd: 1,
        },
        other: {
          events: 0,
          totalTokens: 0,
          standardApiPriceEquivalentUsd: 0,
        },
      },
    },
    calibration: {
      sourceCacheSchemaVersion: "local-replay-safe-accounting-v0.8",
      sourceCacheRelationship: "validated_newer_schema_subdocument",
      weeklyCalibrationSchemaVersion: "weekly-calibration-summary-v0.1",
      basisFamilyId: ALLOWANCE_BASIS_FAMILY,
      accountAttribution: "historical_unattributed_may_combine_accounts",
      scenarios: {
        unresolved_as_standard: {
          basisId: allowanceBasisId("unresolved_as_standard"),
          generatedAt: "2026-08-17T12:00:00.000Z",
          selectedCostBasis: "speed_lower",
          medianWeeklyCapacityUsd: 100,
          plausibleWeeklyCapacityRangeUsd: { lower: 80, upper: 120 },
          qualifyingResets: 10,
          cohortId: "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
        },
        unresolved_as_fast: {
          basisId: allowanceBasisId("unresolved_as_fast"),
          generatedAt: "2026-08-17T12:00:00.000Z",
          selectedCostBasis: "speed_upper",
          medianWeeklyCapacityUsd: 250,
          plausibleWeeklyCapacityRangeUsd: { lower: 200, upper: 300 },
          qualifyingResets: 10,
          cohortId: "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
        },
      },
      timelineCapacityEligible: true,
    },
    estimate: {
      assumedMissingSpeed: "fast",
      assumedMissingModel: "gpt-5.6-terra",
      modelAssumption: "only_exact_model_observed_that_day",
      fastQuotaMultiplier: 2.5,
      allowanceComparison: {
        status: "complete",
        basisFamilyId: ALLOWANCE_BASIS_FAMILY,
        selectedScenario: "unresolved_as_standard",
        selectedExpectedPercentagePoints: 4.5,
        scenarios: {
          unresolved_as_standard: {
            basisId: allowanceBasisId("unresolved_as_standard"),
            numeratorUsd: 4.5,
            capacityUsd: 100,
            expectedPercentagePoints: 4.5,
          },
          unresolved_as_fast: {
            basisId: allowanceBasisId("unresolved_as_fast"),
            numeratorUsd: 6,
            capacityUsd: 250,
            expectedPercentagePoints: 2.4,
          },
        },
        expectedRangePercentagePoints: null,
      },
      exactCostImpliedMedianRangePercentagePoints: {
        lower: 4.5,
        upper: 4.5,
      },
      unexplainedMedianRangePercentagePoints: {
        lower: 15.5,
        upper: 15.5,
      },
      impliedMissingStandardApiEquivalentUsd: 6.2,
      impliedMissingQuotaWeightedApiEquivalentUsd: 15.5,
      sensitivityRangeUsd: { lower: 4.6, upper: 21.6 },
      quotaWeightedSensitivityRangeUsd: { lower: 11.5, upper: 54 },
      includedInExactUsage: false,
      includedInCalibrationTimeline: false,
      independentlyObserved: false,
    },
    privateSessionIds: ["private-child"],
    ...overrides,
  };
}

function normalize(value, timelineOverrides = {}) {
  return normalizeDashboardPayload({
    mode: "real_local_evidence",
    timeline: {
      usage: [],
      calibrationUsage: [{
        startAt: "2026-08-17T11:00:00.000Z",
        endAt: "2026-08-17T11:15:00.000Z",
        usageEvents: 1,
        totalTokens: 100_000,
        apiPriceEquivalentUsd: 0.1,
        allowanceWeighting: {
          status: "complete",
          basisFamilyId: ALLOWANCE_BASIS_FAMILY,
          selectedScenario: "unresolved_as_fast",
          selectedUsd: 0.25,
          scenarios: {
            unresolved_as_standard: allowanceScenario(
              "unresolved_as_standard",
              0.1,
            ),
            unresolved_as_fast: allowanceScenario(
              "unresolved_as_fast",
              0.25,
            ),
          },
          rangeUsd: null,
        },
        components: { input_cache_read_tokens: 98_000 },
        pricingCoverage: { fullyPricedEvents: 1 },
        sourcePath: "/private/log",
      }],
      quota: [],
      ...timelineOverrides,
    },
    accounting: { periodId: "7d", sideChatEstimates: value },
  });
}

test("browser preserves the pinned side-chat estimate while dropping identifiers and bounding rows", () => {
  const normalized = normalize(estimate());
  const result = normalized.accounting.sideChatEstimates;
  assert.equal(result.status, "available");
  assert.equal(result.periods.length, 4);
  assert.equal(result.recent.length, 500);
  assert.deepEqual(result.recent[0], {
    observedAt: result.recent[0].observedAt,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    turnOrdinal: 1,
    activeContextTokens: result.recent[0].activeContextTokens,
    cacheAssumption: "warm_prefix",
    compactionBefore: false,
    estimatedApiPriceEquivalentUsd: 0.1,
    estimatedRangeUsd: { lower: 0.08, upper: 0.2 },
    pricingBasis: "reviewed_model_card",
  });
  assert.equal(normalized.timeline.calibrationUsage.length, 1);
  assert.equal(
    normalized.timeline.calibrationUsage[0]
      .allowanceWeighting.selectedUsd,
    0.25,
  );
  assert.equal(
    Object.hasOwn(normalized.timeline.calibrationUsage[0], "sourcePath"),
    false,
  );
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("private-child"), false);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("/private/log"), false);
});

test("browser timeline weighting fails closed on missing values, count drift, or arbitrary multipliers", () => {
  const valid = normalize(estimate()).timeline.calibrationUsage[0];
  const normalized = (row) => normalize(estimate(), {
    calibrationUsage: [row],
  }).timeline.calibrationUsage;

  assert.deepEqual(normalized({
    ...valid,
    allowanceWeighting: {
      ...valid.allowanceWeighting,
      selectedUsd: null,
    },
  }), []);
  assert.deepEqual(normalized({
    ...valid,
    allowanceWeighting: {
      ...valid.allowanceWeighting,
      scenarios: {
        ...valid.allowanceWeighting.scenarios,
        unresolved_as_fast: {
          ...valid.allowanceWeighting.scenarios.unresolved_as_fast,
          coverage: {
            ...valid.allowanceWeighting.scenarios.unresolved_as_fast.coverage,
            totalEvents: 2,
          },
        },
      },
    },
  }), []);
  assert.deepEqual(normalized({
    ...valid,
    allowanceWeighting: {
      ...valid.allowanceWeighting,
      scenarios: {
        ...valid.allowanceWeighting.scenarios,
        unresolved_as_fast: {
          ...valid.allowanceWeighting.scenarios.unresolved_as_fast,
          basisId: `${ALLOWANCE_BASIS_FAMILY}:hostile`,
        },
      },
    },
  }), []);
  assert.deepEqual(normalized({
    ...valid,
    allowanceWeighting: {
      ...valid.allowanceWeighting,
      selectedUsd: 0.05,
      scenarios: {
        ...valid.allowanceWeighting.scenarios,
        unresolved_as_fast: {
          ...valid.allowanceWeighting.scenarios.unresolved_as_fast,
          quotaWeightedUsd: 0.05,
          coveredSubtotalUsd: 0.05,
        },
      },
    },
  }), []);
});

test("browser accepts a mixed capacity range only for the same reset cohort", () => {
  const matched = normalize(estimate(), {
    allowanceCapacity: allowanceCapacity(),
  }).timeline.allowanceCapacity;
  assert.equal(matched.status, "range");
  assert.equal(
    matched.scenarios.unresolved_as_standard.cohortId,
    MATCHED_COHORT_ID,
  );

  const mismatched = normalize(estimate(), {
    allowanceCapacity: allowanceCapacity([
      MATCHED_COHORT_ID,
      "a7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
    ]),
  }).timeline.allowanceCapacity;
  assert.equal(mismatched.status, "unavailable");
  assert.equal(mismatched.reason, "allowance_capacity_invalid");
});

test("browser fails closed when side-chat methodology or ranges drift", () => {
  const mismatched = estimate({
    methodology: {
      ...estimate().methodology,
      assumptions: {
        ...ASSUMPTIONS,
        ordinaryCacheReadShare: {
          ...ASSUMPTIONS.ordinaryCacheReadShare,
          point: 0.5,
        },
      },
    },
  });
  assert.equal(
    normalize(mismatched).accounting.sideChatEstimates.errorCode,
    "methodology_mismatch",
  );

  const invalidRange = estimate({
    periods: ["24h", "7d", "30d", "all"].map((id) => period(id)),
  });
  invalidRange.periods[1].estimatedRangeUsd = { lower: 0.2, upper: 0.3 };
  assert.equal(
    normalize(invalidRange).accounting.sideChatEstimates.errorCode,
    "evidence_invalid",
  );
});

test("browser preserves reviewed unpriced side-chat rows as unavailable", () => {
  const value = estimate({
    recent: [{
      observedAt: "2026-08-17T11:00:00.000Z",
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "high",
      turnOrdinal: 1,
      activeContextTokens: 50_000,
      cacheAssumption: "retention_unknown",
      compactionBefore: false,
      estimatedApiPriceEquivalentUsd: null,
      estimatedRangeUsd: null,
      pricingBasis: "unavailable",
    }],
    recentTruncated: false,
  });
  const result = normalize(value).accounting.sideChatEstimates;
  assert.equal(result.status, "available");
  assert.equal(result.recent.length, 1);
  assert.equal(result.recent[0].estimatedApiPriceEquivalentUsd, null);
  assert.equal(result.recent[0].estimatedRangeUsd, null);
  assert.equal(result.recent[0].cacheAssumption, "retention_unknown");
});

test("browser preserves a valid zero-activity snapshot with an empty logs database", () => {
  const zero = estimate({
    methodology: {
      ...estimate().methodology,
      includedInCalibrationTimeline: false,
      calibrationStatus: "withheld_no_retained_calls",
    },
    coverage: {
      ...estimate().coverage,
      logs2: {
        startAt: null,
        endAt: null,
        sourceScope: "active_logs2_retention_only",
      },
      detectedSessions: 0,
      retainedNumericSessions: 0,
      completeNumericSessions: 0,
      sessionsWithoutNumericEvidence: 0,
      status: "retained_for_all_detected_sessions",
    },
    periods: ["24h", "7d", "30d", "all"].map((id) => ({
      ...period(id),
      detectedSessions: 0,
      retainedSessions: 0,
      visibleTurns: 0,
      samplingCalls: 0,
      activeContextTokens: 0,
      postCompactionCalls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      estimatedApiPriceEquivalentUsd: 0,
      estimatedRangeUsd: { lower: 0, upper: 0 },
    })),
    recent: [],
    recentTruncated: false,
  });
  const result = normalize(zero).accounting.sideChatEstimates;
  assert.equal(result.status, "available");
  assert.equal(result.coverage.detectedSessions, 0);
  assert.deepEqual(result.coverage.logs2, {
    startAt: null,
    endAt: null,
    sourceScope: "active_logs2_retention_only",
  });
});

test("browser preserves detected lifecycles when numeric logs are empty", () => {
  const emptyNumericEvidence = estimate({
    methodology: {
      ...estimate().methodology,
      includedInCalibrationTimeline: false,
      calibrationStatus: "withheld_no_retained_calls",
    },
    coverage: {
      ...estimate().coverage,
      logs2: {
        startAt: null,
        endAt: null,
        sourceScope: "active_logs2_retention_only",
      },
      detectedSessions: 2,
      retainedNumericSessions: 0,
      completeNumericSessions: 0,
      sessionsAtRetentionLimit: 0,
      sessionsWithoutNumericEvidence: 2,
      status: "partial_diagnostic_retention",
    },
    periods: ["24h", "7d", "30d", "all"].map((id) => ({
      ...period(id),
      detectedSessions: 2,
      retainedSessions: 0,
      visibleTurns: 0,
      samplingCalls: 0,
      activeContextTokens: 0,
      postCompactionCalls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      estimatedApiPriceEquivalentUsd: 0,
      estimatedRangeUsd: { lower: 0, upper: 0 },
    })),
    recent: [],
    recentTruncated: false,
  });
  const result = normalize(emptyNumericEvidence).accounting.sideChatEstimates;
  assert.equal(result.status, "available");
  assert.equal(result.coverage.detectedSessions, 2);
  assert.equal(result.coverage.retainedNumericSessions, 0);
  assert.equal(result.coverage.sessionsWithoutNumericEvidence, 2);
  assert.deepEqual(result.coverage.logs2, {
    startAt: null,
    endAt: null,
    sourceScope: "active_logs2_retention_only",
  });
});

test("browser preserves the historical quota-gap backcast but strips private fields", () => {
  const value = estimate({ historicalGapProbe: historicalGapProbe() });
  const result = normalize(value).accounting.sideChatEstimates
    .historicalGapProbe;
  assert.equal(result.status, "available");
  assert.equal(result.date, "2026-07-13");
  assert.equal(result.exactUsage.events, 3);
  assert.deepEqual(result.exactUsage.bySpeed.fast, {
    events: 1,
    totalTokens: 101_000,
    standardApiPriceEquivalentUsd: 1,
  });
  assert.equal(result.estimate.impliedMissingStandardApiEquivalentUsd, 6.2);
  assert.equal(result.estimate.includedInExactUsage, false);
  assert.equal(JSON.stringify(result).includes("private-child"), false);

  const invalid = historicalGapProbe({
    estimate: {
      ...historicalGapProbe().estimate,
      unexplainedMedianRangePercentagePoints: { lower: 0, upper: 0 },
    },
  });
  assert.equal(
    normalize(estimate({ historicalGapProbe: invalid })).accounting
      .sideChatEstimates.historicalGapProbe.status,
    "unavailable",
  );
});

test("side-chat UI keeps exact and adjusted calibration visible and paginates evidence", async () => {
  const [app, html, localization] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/localization.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /alignedExactUsage/u);
  assert.match(app, /dashboard\.summary\.sideChatBaseline/u);
  assert.match(app, /dashboard\.summary\.sideChatAdjustment/u);
  assert.match(app, /dashboard\.summary\.sideChatNoMatchedOverlap/u);
  assert.match(app, /sideChatMatchedOverlap > 0/u);
  assert.match(app, /sideChatTablePagination/u);
  assert.match(html, /id="side-chat-details"/u);
  assert.match(html, /id="side-chat-pagination"/u);
  assert.match(html, /id="side-chat-page-prev"/u);
  assert.match(html, /id="side-chat-page-next"/u);
  assert.match(html, /id="side-chat-historical-gap"/u);
  assert.match(html, /id="side-chat-historical-gap-focus"/u);
  assert.match(
    html,
    /input, cache, output, and reasoning components are\s+reconstructed/u,
  );
  assert.match(app, /retained_subset_of_selected_period/u);
  assert.match(app, /historicalGapPeakThreeHourPoint/u);
  assert.match(localization, /cache unobserved/u);
});
