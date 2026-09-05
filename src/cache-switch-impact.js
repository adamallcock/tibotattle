import { codexCacheReasoningConfiguration } from "@app-usagemonitor/telemetry-contract";
import {
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";
import {
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION,
  reasoningEffortName,
} from "./local-unified-index.js";
import {
  createAccountingPricer,
} from "./replay-safe-accounting-cache.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";

export const CACHE_SWITCH_PROXIMITY_MS = 5 * 60_000;
export const CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO = 0.5;
export const MAX_CACHE_SWITCH_RECENT_DETAILS = 20;
// Elapsed time is evidence, not an eligibility gate. A same-configuration
// cache collapse can be observed on the very next user turn; gap bands let the
// product show how the pattern changes with age without asserting a cache TTL.
export const CACHE_CONTINUITY_MINIMUM_GAP_MS = 0;
export const MAX_CACHE_CONTINUITY_RECENT_DETAILS = 20;
export const CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS =
  7 * 24 * 60 * 60_000;

const FUTURE_EVIDENCE_TOLERANCE_MS = 5 * 60_000;
const CHANGE_TYPES = Object.freeze([
  "reasoning_only",
  "model_only",
  "model_and_reasoning",
]);
const CONTINUITY_GAP_BANDS = Object.freeze([
  Object.freeze({
    id: "under_one_minute",
    label: "Under 1 minute",
    startMs: 0,
    endMs: 60_000,
  }),
  Object.freeze({
    id: "one_to_five_minutes",
    label: "1 to 5 minutes",
    startMs: 60_000,
    endMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "five_to_thirty_minutes",
    label: "5 to 30 minutes",
    startMs: 5 * 60_000,
    endMs: 30 * 60_000,
  }),
  Object.freeze({
    id: "thirty_minutes_to_one_hour",
    label: "30 minutes to 1 hour",
    startMs: 30 * 60_000,
    endMs: 60 * 60_000,
  }),
  Object.freeze({
    id: "one_to_six_hours",
    label: "1 to 6 hours",
    startMs: 60 * 60_000,
    endMs: 6 * 60 * 60_000,
  }),
  Object.freeze({
    id: "six_to_twenty_four_hours",
    label: "6 to 24 hours",
    startMs: 6 * 60 * 60_000,
    endMs: 24 * 60 * 60_000,
  }),
  Object.freeze({
    id: "over_twenty_four_hours",
    label: "More than 24 hours",
    startMs: 24 * 60 * 60_000,
    endMs: Number.POSITIVE_INFINITY,
  }),
]);
// The cost table keeps its established seven bands. The outcome raster uses a
// finer, human-readable partition so the dense first few minutes remain
// inspectable without data-derived boundaries such as "11–27 seconds".
const CONTINUITY_OUTCOME_BUCKETS = Object.freeze([
  Object.freeze({
    id: "under_one_minute",
    label: "Under 1 minute",
    startMs: 0,
    endMs: 60_000,
  }),
  Object.freeze({
    id: "one_to_two_minutes",
    label: "1 to 2 minutes",
    startMs: 60_000,
    endMs: 2 * 60_000,
  }),
  Object.freeze({
    id: "two_to_five_minutes",
    label: "2 to 5 minutes",
    startMs: 2 * 60_000,
    endMs: 5 * 60_000,
  }),
  Object.freeze({
    id: "five_to_ten_minutes",
    label: "5 to 10 minutes",
    startMs: 5 * 60_000,
    endMs: 10 * 60_000,
  }),
  Object.freeze({
    id: "ten_to_thirty_minutes",
    label: "10 to 30 minutes",
    startMs: 10 * 60_000,
    endMs: 30 * 60_000,
  }),
  Object.freeze({
    id: "thirty_minutes_to_one_hour",
    label: "30 minutes to 1 hour",
    startMs: 30 * 60_000,
    endMs: 60 * 60_000,
  }),
  Object.freeze({
    id: "one_to_six_hours",
    label: "1 to 6 hours",
    startMs: 60 * 60_000,
    endMs: 6 * 60 * 60_000,
  }),
  Object.freeze({
    id: "six_to_twenty_four_hours",
    label: "6 to 24 hours",
    startMs: 6 * 60 * 60_000,
    endMs: 24 * 60 * 60_000,
  }),
  Object.freeze({
    id: "one_to_three_days",
    label: "1 to 3 days",
    startMs: 24 * 60 * 60_000,
    endMs: 3 * 24 * 60 * 60_000,
  }),
  Object.freeze({
    id: "over_three_days",
    label: "3 days or more",
    startMs: 3 * 24 * 60 * 60_000,
    endMs: Number.POSITIVE_INFINITY,
  }),
]);
const PERIODS = Object.freeze([
  Object.freeze({
    id: "24h",
    label: "Last 24 hours",
    durationMs: 24 * 60 * 60_000,
  }),
  Object.freeze({
    id: "7d",
    label: "Last 7 days",
    durationMs: 7 * 24 * 60 * 60_000,
  }),
  Object.freeze({
    id: "30d",
    label: "Last 30 days",
    durationMs: 30 * 24 * 60 * 60_000,
  }),
  Object.freeze({ id: "all", label: "All indexed local history", durationMs: null }),
]);
const USD_SCALE_DIGITS = 9;
const USD_SCALE = 10n ** BigInt(USD_SCALE_DIGITS);
const ALLOWANCE_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast",
]);

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function observedTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function recognizedModel(model, recognition) {
  return recognition === "recognized"
    && typeof model === "string"
    && model.length > 0
    && model !== "unknown";
}

function knownEffort(effort) {
  return typeof effort === "string" && effort !== "unknown";
}

function effortName(value) {
  return Number.isSafeInteger(value)
    ? reasoningEffortName(value)
    : "unknown";
}

function configurationFor(row) {
  const previousModel = row.previous_model_id;
  const currentModel = row.model_id;
  const previousEffort = effortName(row.previous_reasoning_effort);
  const currentEffort = effortName(row.reasoning_effort);
  if (!recognizedModel(previousModel, row.previous_model_recognition)
      || !recognizedModel(currentModel, row.model_recognition)
      || !knownEffort(previousEffort)
      || !knownEffort(currentEffort)) {
    return null;
  }
  const modelChanged = previousModel !== currentModel;
  // Configuration aliases are model-specific (Astra Ultra also changes mode).
  // This comparison is not proof
  // that a configuration update was applied or that a cache reset occurred;
  // the separate observed-token and compaction gates remain authoritative.
  const reasoningChanged = codexCacheReasoningConfiguration(previousModel, previousEffort)
    !== codexCacheReasoningConfiguration(currentModel, currentEffort);
  return {
    previousModel,
    currentModel,
    previousEffort,
    currentEffort,
    modelChanged,
    reasoningChanged,
  };
}

function changeTypeFor(row) {
  const configuration = configurationFor(row);
  if (configuration === null) return null;
  if (configuration.modelChanged && configuration.reasoningChanged) {
    return "model_and_reasoning";
  }
  if (configuration.modelChanged) return "model_only";
  if (configuration.reasoningChanged) return "reasoning_only";
  return null;
}

function sameEffectiveConfiguration(row) {
  const configuration = configurationFor(row);
  return configuration !== null
    && !configuration.modelChanged
    && !configuration.reasoningChanged;
}

function sameObservedBoundary(left, right) {
  // Pure analyzer fixtures written before the routing guard do not carry
  // dimension ids; two absent values mean "not part of this fixture", not a
  // manufactured mismatch. Rows read from SQLite always carry both ids.
  if (left === undefined && right === undefined) return true;
  return Number.isSafeInteger(left)
    && Number.isSafeInteger(right)
    && left === right;
}

function sameContinuityConfiguration(row) {
  return sameEffectiveConfiguration(row)
    && sameObservedBoundary(row.previous_tier_id, row.tier_id)
    && sameObservedBoundary(row.previous_surface_id, row.surface_id);
}

function compactionAwareParser(value) {
  return value === LOCAL_UNIFIED_INDEX_PARSER_VERSION
    || value === LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION;
}

function componentsFor(row) {
  return {
    input_uncached_tokens: tokenCount(row.tokens_in_uncached),
    input_cache_read_tokens: tokenCount(row.tokens_in_cache_read),
    input_cache_write_tokens: tokenCount(row.tokens_in_cache_write),
    output_text_tokens: tokenCount(row.tokens_out_text),
    output_reasoning_tokens: tokenCount(row.tokens_out_reasoning),
    output_combined_tokens: tokenCount(row.tokens_out_combined),
  };
}

function completeCacheComparison(row) {
  return observedTokenCount(row.previous_tokens_in_cache_read)
    && observedTokenCount(row.tokens_in_cache_read)
    && observedTokenCount(row.tokens_in_uncached)
    && observedTokenCount(row.tokens_in_cache_write);
}

function currentInputTokens(row) {
  return row.tokens_in_uncached
    + row.tokens_in_cache_read
    + row.tokens_in_cache_write;
}

function contextCanRetainPreviousPrefix(row) {
  return completeCacheComparison(row)
    && currentInputTokens(row) >= row.previous_tokens_in_cache_read;
}

function materialDropFor(row) {
  if (!completeCacheComparison(row)) return null;
  const previousCacheReadTokens = row.previous_tokens_in_cache_read;
  const currentCacheReadTokens = row.tokens_in_cache_read;
  if (previousCacheReadTokens === 0
      || currentCacheReadTokens
        > previousCacheReadTokens * CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO) {
    return null;
  }
  const nonCacheReadInput = row.tokens_in_uncached + row.tokens_in_cache_write;
  const lostCacheTokens = Math.min(
    Math.max(previousCacheReadTokens - currentCacheReadTokens, 0),
    nonCacheReadInput,
  );
  if (lostCacheTokens <= 0) return null;
  return {
    previousCacheReadTokens,
    currentCacheReadTokens,
    lostCacheTokens,
  };
}

function usdNanos(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,9})?$/u.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USD_SCALE
    + BigInt(fraction.padEnd(USD_SCALE_DIGITS, "0"));
}

function nanosToUsdString(value) {
  if (typeof value !== "bigint" || value <= 0n) return "0";
  const whole = value / USD_SCALE;
  const fraction = String(value % USD_SCALE)
    .padStart(USD_SCALE_DIGITS, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
}

function observedCodexSpeed(row) {
  return row?.codex_speed_mode === "standard" || row?.codex_speed_mode === "fast"
    ? row.codex_speed_mode
    : "unknown";
}

function declaredCodexSpeed(row, declaredSpeedBaselines) {
  if (row?.declared_speed_mode === "standard"
      || row?.declared_speed_mode === "fast") {
    return row.declared_speed_mode;
  }
  const observedMs = Number(row?.observed_at_ms);
  if (!Number.isSafeInteger(observedMs)) return "unknown";
  return declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown";
}

function premiumCrossingFor(row, premiumNanos, declaredSpeedBaselines) {
  // Unpriced comparisons remain in the coverage counts, never as zero-dollar
  // members of the priced subtotal or its speed-provenance denominator.
  if (premiumNanos === null) return null;
  const observedSpeed = observedCodexSpeed(row);
  const family = fastModeModelFamilyKey(row?.model_id, {
    eventTime: new Date(Number(row.observed_at_ms)).toISOString(),
    totalInputContextTokens: currentInputTokens(row),
  });
  return {
    observedSpeed,
    family,
    premiumUsd: Number(nanosToUsdString(premiumNanos)),
    declaredSpeed: observedSpeed === "unknown"
      ? declaredCodexSpeed(row, declaredSpeedBaselines)
      : "unknown",
  };
}

function addPremiumCrossing(summary, contribution) {
  if (contribution === null) return;
  const { observedSpeed, family, premiumUsd, declaredSpeed } = contribution;
  const observedCell = summary.speedWeighting[observedSpeed][family];
  observedCell.events += 1;
  observedCell.apiPriceEquivalentUsd += premiumUsd;
  if (declaredSpeed === "unknown") return;
  const declaredCell = summary.declaredSpeedWeighting[declaredSpeed][family];
  declaredCell.events += 1;
  declaredCell.apiPriceEquivalentUsd += premiumUsd;
}

function unavailablePremiumScenario(summary, scenario, reasonCode) {
  const basis = codexPrimaryAllowanceBasis(scenario);
  return {
    status: "unavailable",
    reasonCode,
    basisId: basis.basisId,
    basisFamilyId: basis.basisFamilyId,
    quotaWeightedPremiumUsd: null,
    pricedDrops: summary.pricedDrops,
    observedSpeedDrops: 0,
    declaredSpeedDrops: 0,
    assumedSpeedDrops: 0,
    unknownSpeedDrops: 0,
  };
}

function finalizePremiumScenario(summary, scenario, completeCoverage) {
  if (!completeCoverage) {
    return unavailablePremiumScenario(
      summary,
      scenario,
      "weighting_evidence_incomplete",
    );
  }
  if (summary.unpricedDrops > 0) {
    return unavailablePremiumScenario(
      summary,
      scenario,
      "price_coverage_incomplete",
    );
  }
  const weighting = summarizeQuotaWeightedAccounting({
    speedWeighting: summary.speedWeighting,
    declaredSpeedWeighting: summary.declaredSpeedWeighting,
    unresolvedScenario: scenario,
  });
  if (weighting.weightingStatus !== "complete"
      || !Number.isFinite(weighting.quotaWeightedApiPriceEquivalentUsd)) {
    return unavailablePremiumScenario(
      summary,
      scenario,
      "unsupported_fast_multiplier",
    );
  }
  const basis = codexPrimaryAllowanceBasis(scenario);
  return {
    status: "complete",
    reasonCode: null,
    basisId: basis.basisId,
    basisFamilyId: basis.basisFamilyId,
    quotaWeightedPremiumUsd:
      weighting.quotaWeightedApiPriceEquivalentUsd,
    pricedDrops: summary.pricedDrops,
    observedSpeedDrops: weighting.coverage.observedEvents,
    declaredSpeedDrops: weighting.coverage.declaredFromConfigEvents,
    assumedSpeedDrops: weighting.coverage.assumedEvents,
    unknownSpeedDrops: weighting.coverage.unknownEvents,
  };
}

function finalizePremiumWeighting(summary, completeCoverage) {
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    finalizePremiumScenario(summary, scenario, completeCoverage),
  ]));
  const validScenarios = ALLOWANCE_SCENARIOS.filter(
    (scenario) => scenarios[scenario].status === "complete",
  );
  return {
    status: validScenarios.length > 0 ? "available" : "unavailable",
    reasonCode: validScenarios.length > 0
      ? null
      : scenarios.unresolved_as_standard.reasonCode,
    basisFamilyId: codexPrimaryAllowanceBasis(
      "unresolved_as_standard",
    ).basisFamilyId,
    scenarios,
  };
}

function finalizeCoveredSubtotal(summary) {
  if (summary.pricedDrops === 0) return null;
  const exact = nanosToUsdString(summary.premiumNanos);
  return {
    scope: "covered_priced_drops",
    pricedDrops: summary.pricedDrops,
    standardApiPremiumUsd: Number(exact),
    standardApiPremiumUsdExact: exact,
    // Crossings contain only priced drops. This is an explicit subset, not a
    // way to grant complete coverage or an allowance share to the full period.
    allowanceWeighting: finalizePremiumWeighting({
      ...summary,
      unpricedDrops: 0,
    }, true),
  };
}

function premiumFor(row, lostCacheTokens, pricer) {
  const actualComponents = componentsFor(row);
  const movedFromUncached = Math.min(
    actualComponents.input_uncached_tokens,
    lostCacheTokens,
  );
  const movedFromCacheWrite = lostCacheTokens - movedFromUncached;
  if (movedFromCacheWrite > actualComponents.input_cache_write_tokens) {
    return null;
  }
  const counterfactualComponents = {
    ...actualComponents,
    input_uncached_tokens:
      actualComponents.input_uncached_tokens - movedFromUncached,
    input_cache_read_tokens:
      actualComponents.input_cache_read_tokens + lostCacheTokens,
    input_cache_write_tokens:
      actualComponents.input_cache_write_tokens - movedFromCacheWrite,
  };
  const event = {
    timestamp: new Date(Number(row.observed_at_ms)).toISOString(),
    model: row.model_id,
  };
  let actual;
  let counterfactual;
  try {
    actual = pricer(event, actualComponents);
    counterfactual = pricer(event, counterfactualComponents);
  } catch {
    return null;
  }
  // A partial price may omit exactly the cache-write component being moved.
  // Requiring complete coverage on both sides avoids manufacturing a premium
  // from two incomparable partial totals.
  if (actual?.coverageStatus !== "fully_priced"
      || counterfactual?.coverageStatus !== "fully_priced") {
    return null;
  }
  const actualNanos = usdNanos(actual.totalUsd);
  const counterfactualNanos = usdNanos(counterfactual.totalUsd);
  if (actualNanos === null || counterfactualNanos === null
      || actualNanos < counterfactualNanos) {
    return null;
  }
  return actualNanos - counterfactualNanos;
}

function newSummary() {
  return {
    configurationChanges: 0,
    proximateConfigurationChanges: 0,
    uncoveredConfigurationChanges: 0,
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    pricedDrops: 0,
    unpricedDrops: 0,
    premiumNanos: 0n,
    speedWeighting: emptySpeedWeightingCrossing(),
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
  };
}

function newPeriod(period, nowMs) {
  return {
    periodId: period.id,
    periodLabel: period.label,
    startMs: period.durationMs === null ? Number.NEGATIVE_INFINITY : nowMs - period.durationMs,
    summary: newSummary(),
    byChangeType: Object.fromEntries(CHANGE_TYPES.map((type) => [
      type,
      newSummary(),
    ])),
    recent: [],
  };
}

function addConfigurationChange(summary, proximate) {
  summary.configurationChanges += 1;
  if (proximate) summary.proximateConfigurationChanges += 1;
}

function addDrop(summary, lostCacheTokens, premiumNanos) {
  summary.cacheReadDrops += 1;
  summary.lostCacheTokens += lostCacheTokens;
  if (premiumNanos === null) {
    summary.unpricedDrops += 1;
  } else {
    summary.pricedDrops += 1;
    summary.premiumNanos += premiumNanos;
  }
}

function finalizeSummary(summary) {
  const completeCoverage = summary.uncoveredConfigurationChanges === 0;
  const premiumExact = completeCoverage && summary.unpricedDrops === 0
    ? nanosToUsdString(summary.premiumNanos)
    : null;
  return {
    configurationChanges: summary.configurationChanges,
    proximateConfigurationChanges: summary.proximateConfigurationChanges,
    uncoveredConfigurationChanges: summary.uncoveredConfigurationChanges,
    coverageStatus: completeCoverage ? "complete" : "incomplete",
    cacheReadDrops: summary.cacheReadDrops,
    lostCacheTokens: summary.lostCacheTokens,
    pricedDrops: summary.pricedDrops,
    unpricedDrops: summary.unpricedDrops,
    estimatedPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    estimatedPremiumUsdExact: premiumExact,
    standardApiPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    allowanceWeighting: finalizePremiumWeighting(summary, completeCoverage),
    coveredSubtotal: finalizeCoveredSubtotal(summary),
  };
}

function detailFor(row, changeType, gapMs, previousCacheReadTokens,
  currentCacheReadTokens, lostCacheTokens, premiumNanos) {
  const previousReasoningEffort = effortName(row.previous_reasoning_effort);
  const currentReasoningEffort = effortName(row.reasoning_effort);
  const premiumExact = premiumNanos === null
    ? null
    : nanosToUsdString(premiumNanos);
  return {
    observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
    gapSeconds: Number((gapMs / 1_000).toFixed(3)),
    changeType,
    previous: {
      model: row.previous_model_id,
      reasoningEffort: previousReasoningEffort,
    },
    current: {
      model: row.model_id,
      reasoningEffort: currentReasoningEffort,
    },
    previousCacheReadTokens,
    currentCacheReadTokens,
    lostCacheTokens,
    estimatedPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    estimatedPremiumUsdExact: premiumExact,
  };
}

function retainRecent(period, detail) {
  period.recent.push(detail);
  if (period.recent.length > MAX_CACHE_SWITCH_RECENT_DETAILS) {
    period.recent.shift();
  }
}

function newContinuitySummary() {
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
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    pricedDrops: 0,
    unpricedDrops: 0,
    premiumNanos: 0n,
    speedWeighting: emptySpeedWeightingCrossing(),
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
  };
}

function newContinuityPeriod(period, nowMs) {
  return {
    periodId: period.id,
    periodLabel: period.label,
    startMs: period.durationMs === null
      ? Number.NEGATIVE_INFINITY
      : nowMs - period.durationMs,
    summary: newContinuitySummary(),
    byGapBand: Object.fromEntries(CONTINUITY_GAP_BANDS.map((band) => [
      band.id,
      {
        gapBandLabel: band.label,
        summary: newContinuitySummary(),
      },
    ])),
    byOutcomeBucket: Object.fromEntries(CONTINUITY_OUTCOME_BUCKETS.map(
      (bucket) => [
        bucket.id,
        {
          outcomeBucketLabel: bucket.label,
          summary: newContinuitySummary(),
        },
      ],
    )),
    postCompactionRequests: 0,
    postCompactionCacheReadDrops: 0,
    recent: [],
  };
}

function gapBandFor(gapMs) {
  return CONTINUITY_GAP_BANDS.find(
    (band) => gapMs >= band.startMs && gapMs < band.endMs,
  ) ?? null;
}

function outcomeBucketFor(gapMs) {
  return CONTINUITY_OUTCOME_BUCKETS.find(
    (bucket) => gapMs >= bucket.startMs && gapMs < bucket.endMs,
  ) ?? null;
}

function addContinuityExclusion(summary, field) {
  summary.sameConfigurationReturns += 1;
  summary[field] += 1;
}

function addComparableReturn(summary, row) {
  summary.sameConfigurationReturns += 1;
  summary.comparableReturns += 1;
  const previous = row.previous_tokens_in_cache_read;
  const current = row.tokens_in_cache_read;
  if (current <= previous * CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO) {
    summary.reusedHalfOrLessReturns += 1;
    return;
  }
  summary.reusedMoreThanHalfReturns += 1;
  if (current >= previous) {
    summary.matchedOrExceededReturns += 1;
  } else {
    summary.reusedBetweenHalfAndPreviousReturns += 1;
  }
}

function addContinuityDrop(summary, lostCacheTokens, premiumNanos) {
  summary.cacheReadDrops += 1;
  summary.lostCacheTokens += lostCacheTokens;
  if (premiumNanos === null) {
    summary.unpricedDrops += 1;
  } else {
    summary.pricedDrops += 1;
    summary.premiumNanos += premiumNanos;
  }
}

function finalizeContinuitySummary(summary) {
  const completeCoverage = summary.uncoveredReturns === 0;
  const premiumExact = completeCoverage && summary.unpricedDrops === 0
    ? nanosToUsdString(summary.premiumNanos)
    : null;
  return {
    sameConfigurationReturns: summary.sameConfigurationReturns,
    comparableReturns: summary.comparableReturns,
    compactionConfoundedReturns: summary.compactionConfoundedReturns,
    contextContractedReturns: summary.contextContractedReturns,
    insufficientEvidenceReturns: summary.insufficientEvidenceReturns,
    uncoveredReturns: summary.uncoveredReturns,
    reusedMoreThanHalfReturns: summary.reusedMoreThanHalfReturns,
    reusedHalfOrLessReturns: summary.reusedHalfOrLessReturns,
    matchedOrExceededReturns: summary.matchedOrExceededReturns,
    reusedBetweenHalfAndPreviousReturns:
      summary.reusedBetweenHalfAndPreviousReturns,
    coverageStatus: completeCoverage ? "complete" : "incomplete",
    cacheReadDrops: summary.cacheReadDrops,
    lostCacheTokens: summary.lostCacheTokens,
    pricedDrops: summary.pricedDrops,
    unpricedDrops: summary.unpricedDrops,
    estimatedPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    estimatedPremiumUsdExact: premiumExact,
    standardApiPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    allowanceWeighting: finalizePremiumWeighting(summary, completeCoverage),
    coveredSubtotal: finalizeCoveredSubtotal(summary),
  };
}

function continuityDetailFor(row, gapBand, gapMs, drop, premiumNanos) {
  const premiumExact = premiumNanos === null
    ? null
    : nanosToUsdString(premiumNanos);
  return {
    observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
    gapSeconds: Number((gapMs / 1_000).toFixed(3)),
    gapBand: gapBand.id,
    configuration: {
      model: row.model_id,
      reasoningEffort: effortName(row.reasoning_effort),
    },
    previousCacheReadTokens: drop.previousCacheReadTokens,
    currentCacheReadTokens: drop.currentCacheReadTokens,
    lostCacheTokens: drop.lostCacheTokens,
    estimatedPremiumUsd: premiumExact === null ? null : Number(premiumExact),
    estimatedPremiumUsdExact: premiumExact,
  };
}

function retainContinuityRecent(period, detail) {
  period.recent.push(detail);
  if (period.recent.length > MAX_CACHE_CONTINUITY_RECENT_DETAILS) {
    period.recent.shift();
  }
}

/**
 * Analyze chronological adjacent-request rows. The iterable may be backed by
 * SQLite or a fixture; identifiers used for ordering never enter the result.
 */
export function analyzeCacheSwitchRows(rows, {
  nowMs = Date.now(),
  pricer = createAccountingPricer(),
  declaredSpeedBaselines = [],
} = {}) {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  if (typeof pricer !== "function") throw new TypeError("pricer must be a function");
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const periods = PERIODS.map((period) => newPeriod(period, nowMs));
  const futureLimitMs = nowMs + FUTURE_EVIDENCE_TOLERANCE_MS;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const observedMs = row.observed_at_ms;
    const previousObservedMs = row.previous_observed_at_ms;
    if (!Number.isSafeInteger(observedMs)
        || !Number.isSafeInteger(previousObservedMs)
        || observedMs < previousObservedMs
        || observedMs > futureLimitMs) {
      continue;
    }
    const changeType = changeTypeFor(row);
    if (changeType === null) continue;
    const gapMs = observedMs - previousObservedMs;
    const proximate = gapMs <= CACHE_SWITCH_PROXIMITY_MS;
    const applicablePeriods = periods.filter((period) => observedMs >= period.startMs);
    for (const period of applicablePeriods) {
      addConfigurationChange(period.summary, proximate);
      addConfigurationChange(period.byChangeType[changeType], proximate);
    }
    if (!compactionAwareParser(row.previous_parser_version)
        || !compactionAwareParser(row.parser_version)) {
      for (const period of applicablePeriods) {
        period.summary.uncoveredConfigurationChanges += 1;
        period.byChangeType[changeType].uncoveredConfigurationChanges += 1;
      }
      continue;
    }
    if (!proximate) continue;
    // A compaction is a stronger, directly observed explanation for a changed
    // reusable prefix. It takes precedence over a simultaneous setting change
    // so the same cache collapse cannot enter both diagnostics.
    if (row.compaction_between === 1) continue;
    // NULL means the source did not report the component. It is not an
    // observed zero. All four inputs used to identify and bound a cache drop
    // must therefore be present before the row can enter the drop/cost sum.
    if (!contextCanRetainPreviousPrefix(row)) continue;
    const drop = materialDropFor(row);
    if (drop === null) continue;
    const {
      previousCacheReadTokens,
      currentCacheReadTokens,
      lostCacheTokens,
    } = drop;
    const premiumNanos = premiumFor(row, lostCacheTokens, pricer);
    const premiumCrossing = premiumCrossingFor(row, premiumNanos, baselines);
    const detail = detailFor(
      row,
      changeType,
      gapMs,
      previousCacheReadTokens,
      currentCacheReadTokens,
      lostCacheTokens,
      premiumNanos,
    );
    for (const period of applicablePeriods) {
      addDrop(period.summary, lostCacheTokens, premiumNanos);
      addDrop(period.byChangeType[changeType], lostCacheTokens, premiumNanos);
      addPremiumCrossing(period.summary, premiumCrossing);
      addPremiumCrossing(period.byChangeType[changeType], premiumCrossing);
      retainRecent(period, detail);
    }
  }
  return {
    status: "available",
    errorCode: null,
    proximityCeilingSeconds: CACHE_SWITCH_PROXIMITY_MS / 1_000,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    recentDetailLimit: MAX_CACHE_SWITCH_RECENT_DETAILS,
    periods: periods.map((period) => ({
      periodId: period.periodId,
      periodLabel: period.periodLabel,
      ...finalizeSummary(period.summary),
      // Exact-order coverage gaps cannot be assigned honestly to a known
      // change type. SQLite-backed reads overwrite this total-only field;
      // pure analyzer fixtures have complete ordering by construction.
      orderingCoverageGaps: 0,
      byChangeType: Object.fromEntries(CHANGE_TYPES.map((type) => [
        type,
        finalizeSummary(period.byChangeType[type]),
      ])),
      recent: [...period.recent].reverse(),
    })),
  };
}

/**
 * Analyze same-configuration returns without asserting that elapsed time
 * caused the observed cache miss. Recorded compactions take precedence and
 * remain visible as a separate, deliberately unpriced cohort.
 */
export function analyzeCacheContinuityRows(rows, {
  nowMs = Date.now(),
  pricer = createAccountingPricer(),
  declaredSpeedBaselines = [],
} = {}) {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  if (typeof pricer !== "function") throw new TypeError("pricer must be a function");
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const periods = PERIODS.map((period) => newContinuityPeriod(period, nowMs));
  const futureLimitMs = nowMs + FUTURE_EVIDENCE_TOLERANCE_MS;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const observedMs = row.observed_at_ms;
    const previousObservedMs = row.previous_observed_at_ms;
    if (!Number.isSafeInteger(observedMs)
        || !Number.isSafeInteger(previousObservedMs)
        || observedMs < previousObservedMs
        || observedMs > futureLimitMs) {
      continue;
    }
    const applicablePeriods = periods.filter((period) => observedMs >= period.startMs);
    const compactionBetween = row.compaction_between === 1;
    if (compactionBetween) {
      const postCompactionDrop = materialDropFor(row);
      for (const period of applicablePeriods) {
        period.postCompactionRequests += 1;
        if (postCompactionDrop !== null) {
          period.postCompactionCacheReadDrops += 1;
        }
      }
    }
    // A long pause inside one agent turn (for example, a slow tool or command)
    // is not a user returning to an older thread. The top-level turn boundary
    // is attached by the content-free extractor to the next positive-input
    // request, so only genuine new-turn returns enter this lens.
    if (row.turn_context_between !== 1
        || !sameContinuityConfiguration(row)) continue;
    const gapMs = observedMs - previousObservedMs;
    const gapBand = gapBandFor(gapMs);
    const outcomeBucket = outcomeBucketFor(gapMs);
    if (gapBand === null || outcomeBucket === null) continue;

    const targets = applicablePeriods.flatMap((period) => [
      period.summary,
      period.byGapBand[gapBand.id].summary,
      period.byOutcomeBucket[outcomeBucket.id].summary,
    ]);
    if (!compactionAwareParser(row.previous_parser_version)
        || !compactionAwareParser(row.parser_version)) {
      for (const summary of targets) {
        addContinuityExclusion(summary, "uncoveredReturns");
      }
      continue;
    }
    if (compactionBetween) {
      for (const summary of targets) {
        addContinuityExclusion(summary, "compactionConfoundedReturns");
      }
      continue;
    }
    if (!completeCacheComparison(row)
        || row.previous_tokens_in_cache_read === 0) {
      for (const summary of targets) {
        addContinuityExclusion(summary, "insufficientEvidenceReturns");
      }
      continue;
    }
    if (!contextCanRetainPreviousPrefix(row)) {
      for (const summary of targets) {
        addContinuityExclusion(summary, "contextContractedReturns");
      }
      continue;
    }
    for (const summary of targets) addComparableReturn(summary, row);
    const drop = materialDropFor(row);
    if (drop === null) continue;
    const premiumNanos = premiumFor(row, drop.lostCacheTokens, pricer);
    const premiumCrossing = premiumCrossingFor(row, premiumNanos, baselines);
    const detail = continuityDetailFor(
      row,
      gapBand,
      gapMs,
      drop,
      premiumNanos,
    );
    for (const summary of targets) {
      addContinuityDrop(summary, drop.lostCacheTokens, premiumNanos);
      addPremiumCrossing(summary, premiumCrossing);
    }
    for (const period of applicablePeriods) retainContinuityRecent(period, detail);
  }
  return {
    status: "available",
    errorCode: null,
    minimumGapSeconds: CACHE_CONTINUITY_MINIMUM_GAP_MS / 1_000,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    outcomeDisplayMaximumGapSeconds:
      CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS / 1_000,
    recentDetailLimit: MAX_CACHE_CONTINUITY_RECENT_DETAILS,
    periods: periods.map((period) => ({
      periodId: period.periodId,
      periodLabel: period.periodLabel,
      ...finalizeContinuitySummary(period.summary),
      // Kept only at the period total: an unorderable adjacency has no honest
      // elapsed-time band.
      orderingCoverageGaps: 0,
      postCompactionRequests: period.postCompactionRequests,
      postCompactionCacheReadDrops: period.postCompactionCacheReadDrops,
      byGapBand: Object.fromEntries(CONTINUITY_GAP_BANDS.map((band) => [
        band.id,
        {
          gapBandLabel: period.byGapBand[band.id].gapBandLabel,
          ...finalizeContinuitySummary(period.byGapBand[band.id].summary),
        },
      ])),
      byOutcomeBucket: Object.fromEntries(CONTINUITY_OUTCOME_BUCKETS.map(
        (bucket) => [
          bucket.id,
          {
            outcomeBucketLabel:
              period.byOutcomeBucket[bucket.id].outcomeBucketLabel,
            startSeconds: bucket.startMs / 1_000,
            endSeconds: Number.isFinite(bucket.endMs)
              ? bucket.endMs / 1_000
              : null,
            ...finalizeContinuitySummary(
              period.byOutcomeBucket[bucket.id].summary,
            ),
          },
        ],
      )),
      recent: [...period.recent].reverse(),
    })),
  };
}

// Preserve every comparison whose adjacency is provable, but withhold the
// total money figure for a period that also contains one or more sessions
// whose request order cannot be reconstructed. One sentinel is emitted per
// affected local session at its latest positive-input timestamp. The gap is
// deliberately total-only: without adjacency there is no honest change type
// or elapsed-time band to increment.
function applyOrderingCoverage(projection, gapObservedAtMs, nowMs) {
  const durations = new Map(PERIODS.map((period) => [period.id, period.durationMs]));
  const validGaps = gapObservedAtMs.filter(
    (value) => Number.isSafeInteger(value)
      && value <= nowMs + FUTURE_EVIDENCE_TOLERANCE_MS,
  );
  return {
    ...projection,
    periods: projection.periods.map((period) => {
      const durationMs = durations.get(period.periodId);
      const startMs = durationMs === null || durationMs === undefined
        ? Number.NEGATIVE_INFINITY
        : nowMs - durationMs;
      const orderingCoverageGaps = validGaps.reduce(
        (count, observedAtMs) => count + (observedAtMs >= startMs ? 1 : 0),
        0,
      );
      if (orderingCoverageGaps === 0) {
        return { ...period, orderingCoverageGaps: 0 };
      }
      return {
        ...period,
        orderingCoverageGaps,
        coverageStatus: "incomplete",
        estimatedPremiumUsd: null,
        estimatedPremiumUsdExact: null,
        standardApiPremiumUsd: null,
        allowanceWeighting: {
          status: "unavailable",
          reasonCode: "weighting_evidence_incomplete",
          basisFamilyId: period.allowanceWeighting?.basisFamilyId
            ?? codexPrimaryAllowanceBasis(
              "unresolved_as_standard",
            ).basisFamilyId,
          scenarios: Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => {
            const existing = period.allowanceWeighting?.scenarios?.[scenario];
            return [scenario, {
              ...(existing ?? {}),
              status: "unavailable",
              reasonCode: "weighting_evidence_incomplete",
              quotaWeightedPremiumUsd: null,
            }];
          })),
        },
      };
    }),
  };
}

/**
 * Read the bounded candidate set for both cache-impact lenses with one LAG
 * scan. LAG is partitioned by the index's salted local session identity,
 * which is deliberately absent from the returned product projections.
 */
export function readCacheImpacts(database, {
  nowMs = Date.now(),
  pricer = createAccountingPricer(),
  declaredSpeedBaselines = [],
} = {}) {
  const futureLimitMs = nowMs + FUTURE_EVIDENCE_TOLERANCE_MS;
  const statement = database.prepare(`
    WITH positive_usage AS MATERIALIZED (
      SELECT u.rowid AS usage_rowid, u.session_local, u.observed_at_ms,
             u.source_id, u.source_offset
      FROM usage_event u
      WHERE u.observed_at_ms <= ?
        -- Quota-only and compaction bookkeeping token_count rows can carry
        -- NULL or observed-zero components. Neither is an input request, and
        -- neither may consume the adjacency boundary before the next real
        -- positive-input request.
        AND COALESCE(u.tokens_in_uncached, 0)
          + COALESCE(u.tokens_in_cache_read, 0)
          + COALESCE(u.tokens_in_cache_write, 0) > 0
    ),
    session_order_coverage AS MATERIALIZED (
      SELECT session_local,
             MAX(observed_at_ms) AS latest_observed_at_ms,
             COUNT(*) AS positive_events,
             COUNT(source_id) AS sourced_events,
             COUNT(source_offset) AS ordered_events,
             COUNT(DISTINCT source_id) AS source_count
      FROM positive_usage
      GROUP BY session_local
    ),
    ordered_sessions AS MATERIALIZED (
      SELECT session_local
      FROM session_order_coverage
      -- A migrated/rotated older-parser source has no exact-order rows. A
      -- session spanning more than one source has offsets in incomparable
      -- coordinate systems. Withhold both cases rather than using an HMAC as
      -- chronology or manufacturing a cross-source order.
      WHERE positive_events = sourced_events
        AND positive_events = ordered_events
        AND source_count = 1
    ),
    adjacency AS MATERIALIZED (
      SELECT positive_usage.usage_rowid AS current_rowid,
             positive_usage.source_offset AS current_source_offset,
             LAG(positive_usage.usage_rowid) OVER session_order
               AS previous_rowid
      FROM positive_usage
      JOIN ordered_sessions USING(session_local)
      WINDOW session_order AS (
        PARTITION BY positive_usage.session_local
        -- Source byte order is authoritative within the single source proven
        -- above. Timestamps can tie or regress; the analyzer separately
        -- rejects a negative elapsed gap rather than inventing adjacency.
        ORDER BY positive_usage.source_offset
      )
    ),
    candidates AS MATERIALIZED (
      SELECT current.observed_at_ms AS observed_at_ms,
             current.model_id AS model_id,
             current.reasoning_effort AS reasoning_effort,
             current.tier_id AS tier_id,
             current.surface_id AS surface_id,
             current.parser_version_id AS parser_version_id,
             current.tokens_in_uncached AS tokens_in_uncached,
             current.tokens_in_cache_read AS tokens_in_cache_read,
             current.tokens_in_cache_write AS tokens_in_cache_write,
             current.tokens_out_text AS tokens_out_text,
             current.tokens_out_reasoning AS tokens_out_reasoning,
             current.tokens_out_combined AS tokens_out_combined,
             previous.observed_at_ms AS previous_observed_at_ms,
             previous.model_id AS previous_model_id,
             previous.reasoning_effort AS previous_reasoning_effort,
             previous.tier_id AS previous_tier_id,
             previous.surface_id AS previous_surface_id,
             previous.parser_version_id AS previous_parser_version_id,
             previous.tokens_in_cache_read AS previous_tokens_in_cache_read,
             COALESCE(boundary.compaction_before, 0) AS compaction_between,
             COALESCE(boundary.turn_context_before, 0)
               AS turn_context_between,
             adjacency.current_source_offset AS current_source_offset
      FROM adjacency
      JOIN usage_event current ON current.rowid = adjacency.current_rowid
      JOIN usage_event previous ON previous.rowid = adjacency.previous_rowid
      LEFT JOIN usage_event_boundary boundary
        ON boundary.current_event_key = current.event_key
      WHERE current.model_id != previous.model_id
         OR current.reasoning_effort != previous.reasoning_effort
         OR boundary.turn_context_before = 1
         OR boundary.compaction_before = 1
    ),
    candidate_output AS MATERIALIZED (
      SELECT candidates.observed_at_ms AS observed_at_ms,
             current_model.model_id AS model_id,
             current_model.recognition AS model_recognition,
             candidates.reasoning_effort AS reasoning_effort,
             candidates.tier_id AS tier_id,
             current_tier.codex_speed_mode AS codex_speed_mode,
             candidates.surface_id AS surface_id,
             current_parser.parser_version AS parser_version,
             candidates.tokens_in_uncached AS tokens_in_uncached,
             candidates.tokens_in_cache_read AS tokens_in_cache_read,
             candidates.tokens_in_cache_write AS tokens_in_cache_write,
             candidates.tokens_out_text AS tokens_out_text,
             candidates.tokens_out_reasoning AS tokens_out_reasoning,
             candidates.tokens_out_combined AS tokens_out_combined,
             candidates.previous_observed_at_ms AS previous_observed_at_ms,
             previous_model.model_id AS previous_model_id,
             previous_model.recognition AS previous_model_recognition,
             candidates.previous_reasoning_effort AS previous_reasoning_effort,
             candidates.previous_tier_id AS previous_tier_id,
             candidates.previous_surface_id AS previous_surface_id,
             previous_parser.parser_version AS previous_parser_version,
             candidates.previous_tokens_in_cache_read
               AS previous_tokens_in_cache_read,
             candidates.compaction_between AS compaction_between,
             candidates.turn_context_between AS turn_context_between,
             candidates.current_source_offset AS current_source_offset
      FROM candidates
      JOIN model current_model ON current_model.id = candidates.model_id
      JOIN model previous_model ON previous_model.id = candidates.previous_model_id
      JOIN tier_semantics current_tier
        ON current_tier.id = candidates.tier_id
      JOIN parser_version current_parser
        ON current_parser.id = candidates.parser_version_id
      JOIN parser_version previous_parser
        ON previous_parser.id = candidates.previous_parser_version_id
    )
    SELECT candidate_output.*, 0 AS ordering_coverage_gap
    FROM candidate_output
    UNION ALL
    SELECT latest_observed_at_ms,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,
           1 AS ordering_coverage_gap
    FROM session_order_coverage
    WHERE positive_events >= 2
      AND (positive_events != sourced_events
        OR positive_events != ordered_events
        OR source_count != 1)
    ORDER BY observed_at_ms, current_source_offset`);
  // SQL reduces the 500k+ adjacency population to the few thousand rows that
  // could enter either lens. Holding that candidate set once avoids running
  // the expensive window scan twice while staying bounded in practice by
  // configuration changes and content-free turn/compaction boundaries.
  const outputRows = statement.all(futureLimitMs);
  const orderingCoverageGapTimes = outputRows
    .filter((row) => row.ordering_coverage_gap === 1)
    .map((row) => Number(row.observed_at_ms));
  const rows = outputRows.filter((row) => row.ordering_coverage_gap === 0);
  return {
    cacheSwitchImpact: applyOrderingCoverage(
      analyzeCacheSwitchRows(rows, { nowMs, pricer, declaredSpeedBaselines }),
      orderingCoverageGapTimes,
      nowMs,
    ),
    cacheContinuityImpact: applyOrderingCoverage(
      analyzeCacheContinuityRows(rows, {
        nowMs,
        pricer,
        declaredSpeedBaselines,
      }),
      orderingCoverageGapTimes,
      nowMs,
    ),
  };
}

export function readCacheSwitchImpact(database, options = {}) {
  return readCacheImpacts(database, options).cacheSwitchImpact;
}

export function readCacheContinuityImpact(database, options = {}) {
  return readCacheImpacts(database, options).cacheContinuityImpact;
}

export function unavailableCacheSwitchImpact(errorCode) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string" && errorCode.length > 0
      ? errorCode
      : "local_unified_index_unavailable",
    proximityCeilingSeconds: CACHE_SWITCH_PROXIMITY_MS / 1_000,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    recentDetailLimit: MAX_CACHE_SWITCH_RECENT_DETAILS,
    periods: [],
  };
}

export function unavailableCacheContinuityImpact(errorCode) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string" && errorCode.length > 0
      ? errorCode
      : "local_unified_index_unavailable",
    minimumGapSeconds: CACHE_CONTINUITY_MINIMUM_GAP_MS / 1_000,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    outcomeDisplayMaximumGapSeconds:
      CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_MS / 1_000,
    recentDetailLimit: MAX_CACHE_CONTINUITY_RECENT_DETAILS,
    periods: [],
  };
}
