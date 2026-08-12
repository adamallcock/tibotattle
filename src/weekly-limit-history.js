const HISTORY_SCHEMA_VERSION = "0.1";

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] * (1 - (position - lower)) + ordered[upper] * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

// Slot is deliberately not part of series identity: it is a server-assigned
// UI role, and the weekly window flipped secondary -> primary around
// 2026-07-06. Identity is (limit, duration) with resetsAt as the instance
// facet; the group's first-row slot is kept downstream as display provenance.
function exactGroupKey(transition) {
  return [
    transition.accountScopeId ?? "unattributed",
    transition.provider,
    transition.planType,
    transition.limitId,
    transition.windowDurationMins,
    transition.resetsAt,
  ].join("|");
}

function addNumericFields(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Number.isFinite(value)) target[key] = (target[key] ?? 0) + value;
  }
}

function summarizeMix(groups) {
  const components = {};
  const models = {};
  for (const group of groups) {
    addNumericFields(components, group.marginalComponents);
    for (const [model, values] of Object.entries(group.modelMix ?? {})) {
      const target = models[model] ??= { costUsd: 0, events: 0 };
      target.costUsd += values.costUsd ?? 0;
      target.events += values.events ?? 0;
    }
  }
  const totalTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
  const componentTokenShares = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, totalTokens > 0 ? round(value / totalTokens) : null]));
  const modelCostTotal = Object.values(models).reduce((sum, value) => sum + value.costUsd, 0);
  const modelCostShares = Object.fromEntries(Object.entries(models).map(([key, value]) => [key, modelCostTotal > 0 ? round(value.costUsd / modelCostTotal) : null]));
  return { components, componentTokenShares, modelCostShares, resetCount: groups.length };
}

function eligibility(transition) {
  const reasons = [];
  if (!(transition.nextUsedPercent > transition.priorUsedPercent)) reasons.push("not_monotonic");
  if (!(transition.marginalUsageEventCount > 0)) reasons.push("no_retained_usage");
  if (transition.quality?.localCoverage?.elapsedTimeCoverageFraction !== 1) reasons.push("partial_elapsed_coverage");
  if ((transition.quality?.pricingWarnings?.length ?? 0) > 0) reasons.push("pricing_warning");
  if ((transition.quality?.attributionWarnings?.length ?? 0) > 0) reasons.push("attribution_warning");
  return reasons;
}

function summarizeExactGroup(transitions) {
  const eligible = transitions.filter((transition) => eligibility(transition).length === 0);
  const boundaries = eligible.map((transition) => ({
    percent: transition.nextUsedPercent,
    costUsd: (transition.lastPriorCumulativeApiPricedUsd + transition.firstNextCumulativeApiPricedUsd) / 2,
    quotaWeightedLowerUsd: Number.isFinite(transition.lastPriorCumulativeQuotaWeightedLowerUsd) && Number.isFinite(transition.firstNextCumulativeQuotaWeightedLowerUsd)
      ? (transition.lastPriorCumulativeQuotaWeightedLowerUsd + transition.firstNextCumulativeQuotaWeightedLowerUsd) / 2
      : null,
    quotaWeightedUpperUsd: Number.isFinite(transition.lastPriorCumulativeQuotaWeightedUpperUsd) && Number.isFinite(transition.firstNextCumulativeQuotaWeightedUpperUsd)
      ? (transition.lastPriorCumulativeQuotaWeightedUpperUsd + transition.firstNextCumulativeQuotaWeightedUpperUsd) / 2
      : null,
  })).sort((left, right) => left.percent - right.percent || left.costUsd - right.costUsd);
  const pairs = { standard: [], lower: [], upper: [] };
  for (let leftIndex = 0; leftIndex < boundaries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boundaries.length; rightIndex += 1) {
      const percentDelta = boundaries[rightIndex].percent - boundaries[leftIndex].percent;
      if (percentDelta <= 0) continue;
      for (const [name, field] of [["standard", "costUsd"], ["lower", "quotaWeightedLowerUsd"], ["upper", "quotaWeightedUpperUsd"]]) {
        const costDelta = boundaries[rightIndex][field] - boundaries[leftIndex][field];
        if (Number.isFinite(costDelta) && costDelta > 0) pairs[name].push(100 * costDelta / percentDelta);
      }
    }
  }
  const percentages = eligible.flatMap((transition) => [transition.priorUsedPercent, transition.nextUsedPercent]);
  const tierUsageEventCounts = {};
  const marginalComponents = {};
  const modelMix = {};
  const priceCardIds = new Set();
  for (const transition of eligible) {
    for (const [mode, count] of Object.entries(transition.tierUsageEventCounts ?? { unknown: transition.marginalUsageEventCount })) {
      tierUsageEventCounts[mode] = (tierUsageEventCounts[mode] ?? 0) + count;
    }
    addNumericFields(marginalComponents, transition.marginalComponents);
    for (const [model, values] of Object.entries(transition.modelMix ?? {})) {
      const target = modelMix[model] ??= { costUsd: 0, events: 0 };
      target.costUsd += values.costUsd ?? 0;
      target.events += values.events ?? 0;
    }
    for (const cardId of transition.priceCardIds ?? []) priceCardIds.add(cardId);
  }
  const first = transitions[0];
  const last = transitions.at(-1);
  const percentSpan = percentages.length === 0 ? 0 : Math.max(...percentages) - Math.min(...percentages);
  const central80 = pairs.standard.length === 0 ? null : { lower: round(quantile(pairs.standard, 0.1)), upper: round(quantile(pairs.standard, 0.9)) };
  const sensitivity = pairs.lower.length === 0 || pairs.upper.length === 0 ? null : {
    unknownAsStandardCapacityUsd: round(median(pairs.lower)),
    unknownAsFastCapacityUsd: round(median(pairs.upper)),
  };
  const relativePairWidth = central80 && median(pairs.standard) > 0 ? (central80.upper - central80.lower) / median(pairs.standard) : null;
  return {
    accountScopeId: first.accountScopeId ?? "unattributed",
    provider: first.provider,
    planType: first.planType,
    limitId: first.limitId,
    slot: first.slot,
    windowDurationMins: first.windowDurationMins,
    resetsAt: first.resetsAt,
    resetIdentity: new Date(first.resetsAt * 1000).toISOString(),
    firstObservedAt: first.lastPriorObservedAt,
    lastObservedAt: last.firstNextObservedAt,
    totalTransitions: transitions.length,
    eligibleTransitions: eligible.length,
    percentSpan,
    pairCount: pairs.standard.length,
    descriptiveCapacityUsd: round(median(pairs.standard)),
    central80PercentRangeUsd: central80,
    quotaWeightedSensitivity: sensitivity,
    relativeCentral80PairWidth: round(relativePairWidth),
    tierUsageEventCounts,
    marginalComponents,
    modelMix,
    priceCardIds: [...priceCardIds].sort(),
    controlledStateCounts: transitions.reduce((counts, transition) => {
      counts[transition.controlledState] = (counts[transition.controlledState] ?? 0) + 1;
      return counts;
    }, {}),
    usableDiagnostic: eligible.length >= 8 && percentSpan >= 5 && pairs.standard.length >= 8 && relativePairWidth <= 1,
  };
}

function selectDuplicateResetGroups(groups) {
  const classifications = new Map();
  for (const group of groups) {
    const key = [group.accountScopeId, group.provider, group.planType, group.limitId, group.windowDurationMins].join("|");
    const list = classifications.get(key) ?? [];
    list.push(group);
    classifications.set(key, list);
  }
  const selected = [];
  const suppressed = [];
  for (const values of classifications.values()) {
    values.sort((left, right) => left.resetsAt - right.resetsAt);
    let cluster = [];
    const flush = () => {
      if (cluster.length === 0) return;
      cluster.sort((left, right) => right.eligibleTransitions - left.eligibleTransitions || right.totalTransitions - left.totalTransitions);
      selected.push(cluster[0]);
      suppressed.push(...cluster.slice(1).map((group) => ({
        resetsAt: group.resetsAt,
        selectedResetsAt: cluster[0].resetsAt,
        reason: "near_duplicate_reset_identity_with_fewer_eligible_transitions",
      })));
      cluster = [];
    };
    for (const group of values) {
      if (cluster.length > 0 && group.resetsAt - cluster.at(-1).resetsAt > 2) flush();
      cluster.push(group);
    }
    flush();
  }
  selected.sort((left, right) => left.resetsAt - right.resetsAt);
  return { selected, suppressed };
}

export function analyzeWeeklyLimitHistory(dataset) {
  const weekly = dataset.transitions.filter((transition) => transition.windowDurationMins === 10080);
  const exactGroups = new Map();
  for (const transition of weekly) {
    const values = exactGroups.get(exactGroupKey(transition)) ?? [];
    values.push(transition);
    exactGroups.set(exactGroupKey(transition), values);
  }
  const summarized = [...exactGroups.values()].map((values) => summarizeExactGroup(values.sort((left, right) => left.eventTime.localeCompare(right.eventTime))));
  const deduplicated = selectDuplicateResetGroups(summarized);
  const allUsable = deduplicated.selected
    .filter((group) => group.usableDiagnostic && group.descriptiveCapacityUsd > 0)
    .sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt) || left.resetsAt - right.resetsAt);
  const usablePartitions = new Map();
  for (const group of allUsable) {
    const key = [group.accountScopeId, group.provider, group.planType, group.limitId, group.windowDurationMins].join("|");
    const values = usablePartitions.get(key) ?? [];
    values.push(group);
    usablePartitions.set(key, values);
  }
  const crossPartitionHeadlineSuppressed = usablePartitions.size > 1;
  const usable = crossPartitionHeadlineSuppressed ? [] : allUsable;
  const partitionSummaries = [...usablePartitions.values()].map((groups) => ({
    accountScopeId: groups[0].accountScopeId,
    provider: groups[0].provider,
    planType: groups[0].planType,
    limitId: groups[0].limitId,
    slot: groups[0].slot,
    windowDurationMins: groups[0].windowDurationMins,
    usableResetGroups: groups.length,
    medianDescriptiveCapacityUsd: round(median(groups.map((group) => group.descriptiveCapacityUsd))),
    firstObservedAt: groups[0].firstObservedAt,
    lastObservedAt: groups.at(-1).lastObservedAt,
  }));
  const estimates = usable.map((group) => group.descriptiveCapacityUsd);
  const third = Math.min(3, Math.floor(usable.length / 2));
  const early = third > 0 ? usable.slice(0, third) : [];
  const late = third > 0 ? usable.slice(-third) : [];
  const earlyMedian = median(early.map((group) => group.descriptiveCapacityUsd));
  const lateMedian = median(late.map((group) => group.descriptiveCapacityUsd));
  const earlyTierLower = median(early.map((group) => group.quotaWeightedSensitivity?.unknownAsStandardCapacityUsd).filter(Number.isFinite));
  const earlyTierUpper = median(early.map((group) => group.quotaWeightedSensitivity?.unknownAsFastCapacityUsd).filter(Number.isFinite));
  const lateTierLower = median(late.map((group) => group.quotaWeightedSensitivity?.unknownAsStandardCapacityUsd).filter(Number.isFinite));
  const lateTierUpper = median(late.map((group) => group.quotaWeightedSensitivity?.unknownAsFastCapacityUsd).filter(Number.isFinite));
  const ratio = earlyMedian > 0 && lateMedian > 0 ? lateMedian / earlyMedian : null;
  const recentTierRelativeWidth = lateMedian > 0 && Number.isFinite(lateTierLower) && Number.isFinite(lateTierUpper)
    ? (lateTierUpper - lateTierLower) / lateMedian
    : null;
  const conditionalSlopeDecisionUseful = late.length >= 3 && recentTierRelativeWidth !== null && recentTierRelativeWidth <= 0.5;
  const resetToResetRatios = usable.slice(1).map((current, index) => {
    const prior = usable[index];
    const priorLower = prior.quotaWeightedSensitivity?.unknownAsStandardCapacityUsd;
    const priorUpper = prior.quotaWeightedSensitivity?.unknownAsFastCapacityUsd;
    const currentLower = current.quotaWeightedSensitivity?.unknownAsStandardCapacityUsd;
    const currentUpper = current.quotaWeightedSensitivity?.unknownAsFastCapacityUsd;
    return {
      priorFirstObservedAt: prior.firstObservedAt,
      currentFirstObservedAt: current.firstObservedAt,
      standardRatio: round(current.descriptiveCapacityUsd / prior.descriptiveCapacityUsd),
      tierWeightedRatioRange: [priorLower, priorUpper, currentLower, currentUpper].every(Number.isFinite) && priorLower > 0 && priorUpper > 0
        ? { lower: round(currentLower / priorUpper), upper: round(currentUpper / priorLower) }
        : null,
      priorEligibleTransitions: prior.eligibleTransitions,
      currentEligibleTransitions: current.eligibleTransitions,
      priorPercentSpan: prior.percentSpan,
      currentPercentSpan: current.percentSpan,
    };
  });
  const descriptive = estimates.length === 0 ? null : {
    resetCount: estimates.length,
    medianUsd: round(median(estimates)),
    central80PercentAcrossResetsUsd: {
      lower: round(quantile(estimates, 0.1)),
      upper: round(quantile(estimates, 0.9)),
    },
    minimumUsd: round(Math.min(...estimates)),
    maximumUsd: round(Math.max(...estimates)),
  };
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    kind: "weekly_limit_history_diagnostic",
    materializedAt: dataset.scope.endAt,
    source: {
      parserVersion: dataset.parserVersion,
      startAt: dataset.scope.startAt,
      endAt: dataset.scope.endAt,
      pricingBasis: dataset.pricing.basis,
      snapshotIntervalsIncluded: dataset.scope.snapshotIntervalsIncluded,
    },
    verdict: "not_testable",
    verdictReason: crossPartitionHeadlineSuppressed
      ? "Usable resets span multiple account/plan partitions, so cross-reset headline and trend statistics are suppressed; local receipts also do not bound shared-pool usage."
      : "Local token receipts do not bound usage from other tasks, devices, products, resets, or provider-side weighting; every retained transition has unknown control state.",
    crossPartitionHeadlineSuppressed,
    partitionSummaries,
    descriptiveStandardApiEquivalent: descriptive,
    speedSensitivityEnvelope: descriptive ? {
      allStandardLowerUsd: descriptive.central80PercentAcrossResetsUsd.lower,
      allFastUpperUsd: round(descriptive.central80PercentAcrossResetsUsd.upper * 2.5),
      interpretation: "Stress-test envelope only; Fast weights are model-specific and tier is not exactly attributable per turn.",
    } : null,
    conditionalRecentBallpark: third > 0 ? {
      status: "conditional_not_identified",
      recentResetCount: late.length,
      standardApiEquivalentMedianUsd: round(lateMedian),
      tierWeightedSensitivityUsd: { lower: round(lateTierLower), upper: round(lateTierUpper) },
      decisionUsefulness: {
        asActualAllowance: false,
        asConditionalLocalSlope: conditionalSlopeDecisionUseful,
        relativeTierWidth: round(recentTierRelativeWidth),
        maximumAcceptedRelativeTierWidth: 0.5,
        actualAllowanceBlocker: "unbounded_missing_shared_pool_usage",
      },
      assumptions: [
        "retained local usage is the complete shared-pool numerator",
        "quota percentage changes belong to the same accounting pool",
        "provider weighting is bounded by the captured Standard/Fast timeline",
        "banked resets and display lag do not change the within-reset slope",
      ],
    } : null,
    earlyLateComparison: {
      earlyResetCount: early.length,
      lateResetCount: late.length,
      earlyMedianUsd: round(earlyMedian),
      lateMedianUsd: round(lateMedian),
      lateToEarlyRatio: round(ratio),
      percentChange: ratio === null ? null : round(100 * (ratio - 1), 2),
      tierWeightedEarlyMedianRangeUsd: { lower: round(earlyTierLower), upper: round(earlyTierUpper) },
      tierWeightedLateMedianRangeUsd: { lower: round(lateTierLower), upper: round(lateTierUpper) },
      tierWeightedLateToEarlyRatioRange: earlyTierUpper > 0 && earlyTierLower > 0
        ? { lower: round(lateTierLower / earlyTierUpper), upper: round(lateTierUpper / earlyTierLower) }
        : null,
      directionIdentifiedAfterTierSensitivity: earlyTierUpper > 0 && earlyTierLower > 0
        ? lateTierLower / earlyTierUpper > 1 || lateTierUpper / earlyTierLower < 1
        : false,
      changeClassification: "suggestive",
      providerPolicyChangeConfirmed: false,
    },
    resetToResetRatios,
    workloadMixComparison: {
      early: summarizeMix(early),
      late: summarizeMix(late),
      interpretation: "Descriptive only; changes in model, cache, output, and reasoning mix are confounders, not identified causes of slope movement.",
    },
    unavailableIdentifiabilityDiagnostics: {
      exactFeasibleIntervalUsd: null,
      holdoutError: null,
      residualDistribution: null,
      changePointTest: null,
      reason: "Every retained transition has unknown control state and shared-pool usage outside local logs is unbounded; fitting these diagnostics would create false precision.",
    },
    resetDiagnostics: deduplicated.selected,
    nearDuplicateResetGroupsSuppressed: deduplicated.suppressed,
    quality: {
      exactResetGroups: summarized.length,
      selectedResetGroups: deduplicated.selected.length,
      usableDiagnosticResetGroups: allUsable.length,
      headlineUsableResetGroups: usable.length,
      usableAccountPlanPartitions: usablePartitions.size,
      allTransitionsControlled: weekly.every((transition) => transition.controlledState === "controlled"),
      controlStateCounts: weekly.reduce((counts, transition) => {
        counts[transition.controlledState] = (counts[transition.controlledState] ?? 0) + 1;
        return counts;
      }, {}),
      unboundedMissingUsage: true,
      integerDisplayGranularityPercentagePoints: 1,
    },
  };
}

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "unavailable";
}

export function renderWeeklyLimitHistoryReport(report) {
  const rows = report.resetDiagnostics.filter((group) => group.usableDiagnostic).map((group) =>
    `| ${group.firstObservedAt.slice(0, 10)} | ${group.resetIdentity} | ${group.eligibleTransitions} | ${group.percentSpan}% | ${money(group.descriptiveCapacityUsd)} | ${money(group.central80PercentRangeUsd?.lower)}–${money(group.central80PercentRangeUsd?.upper)} | ${Object.entries(group.tierUsageEventCounts).map(([key, value]) => `${key}:${value}`).join(", ")} |`,
  );
  const diagnostic = report.descriptiveStandardApiEquivalent;
  const earlyTier = report.earlyLateComparison.tierWeightedEarlyMedianRangeUsd;
  const lateTier = report.earlyLateComparison.tierWeightedLateMedianRangeUsd;
  const ratioRange = report.earlyLateComparison.tierWeightedLateToEarlyRatioRange;
  const tierSensitivityNarrative = [earlyTier?.lower, earlyTier?.upper, lateTier?.lower, lateTier?.upper, ratioRange?.lower, ratioRange?.upper].every(Number.isFinite)
    ? `After applying captured/unknown Standard-versus-Fast sensitivity, the early median can range from ${money(earlyTier.lower)} to ${money(earlyTier.upper)}, while the late median can range from ${money(lateTier.lower)} to ${money(lateTier.upper)}. The possible late/early ratio ${ratioRange.lower <= 1 && ratioRange.upper >= 1 ? "crosses 1, so the change direction is not identified" : `stays ${ratioRange.lower > 1 ? "above" : "below"} 1`}.`
    : "The tier-weighted early/late ratio is unavailable because at least one reset lacks a complete supported-model Standard/Fast sensitivity.";
  return [
    "---",
    "title: Weekly Limit History Diagnostic",
    `date: ${report.materializedAt.slice(0, 10)}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# Weekly Limit History Diagnostic",
    "",
    `Verdict: **${report.verdict}**. ${report.verdictReason}`,
    "",
    "## Descriptive result",
    "",
    report.crossPartitionHeadlineSuppressed
      ? `${report.quality.usableDiagnosticResetGroups} usable reset groups span ${report.quality.usableAccountPlanPartitions} account/plan partitions. The pooled median, early/late trend, adjacent-reset ratios, and ballpark are suppressed instead of comparing unlike partitions.`
      : diagnostic
      ? `${diagnostic.resetCount} reset groups produce a median within-reset slope of ${money(diagnostic.medianUsd)} and a central 80% reset-to-reset spread of ${money(diagnostic.central80PercentAcrossResetsUsd.lower)}–${money(diagnostic.central80PercentAcrossResetsUsd.upper)} in Standard API-price-equivalent units.`
      : "No reset group met the minimum descriptive thresholds.",
    "",
    "This is not a weekly allowance estimate. It is the slope of retained local API-priced activity against the provider's displayed integer percentage. Missing shared-pool activity is unbounded, so no finite confidence interval around the true allowance follows from these data.",
    "",
    "## Early versus late",
    "",
    `The median of the first ${report.earlyLateComparison.earlyResetCount} usable reset groups is ${money(report.earlyLateComparison.earlyMedianUsd)}; the last ${report.earlyLateComparison.lateResetCount} is ${money(report.earlyLateComparison.lateMedianUsd)} (${report.earlyLateComparison.percentChange ?? "unavailable"}% descriptive change). This does not confirm a provider policy change.`,
    "",
    tierSensitivityNarrative,
    "",
    "## Usable reset diagnostics",
    "",
    "| First observed | Reset identity | Eligible transitions | Display span | Median slope | Central 80% pairs | Tier-event mix |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "## Why a ballpark is not identified",
    "",
    "- The one-point display rounding can be averaged down across many transitions; it is not the main blocker.",
    "- Local receipts exclude concurrent use on other tasks, devices, and shared Codex/agent surfaces. That missing numerator has no observable upper bound.",
    "- Subscription Standard/Fast state is session-timeline evidence, not exact per-turn attribution; Fast can weight supported models by 2–2.5×.",
    "- Provider credit rules and model availability changed during the retained history, while the ledger deliberately uses one current Standard API-price basis.",
    "- Every historical interval is control-state `unknown`; no repeated isolated reference panel spans multiple reset windows.",
    "",
  ].join("\n");
}
