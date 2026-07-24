const SCHEMA_VERSION = "0.3";
const ESTIMATOR_VERSION = "shared-pool-residual-v0.3.0";
const DEFAULT_STALE_SNAPSHOT_MS = 60_000;
const LARGE_OBSERVATION_GAP_MS = 300_000;
const CHANGE_POINT_MINIMUM_SIDE = 8;
const CHANGE_POINT_THRESHOLD_PERCENTAGE_POINTS = 0.5;
const SENSITIVITY_MULTIPLIERS = [0.75, 1, 1.25];

function round(value, places = 12) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function seriesKey(classification) {
  return [
    classification.provider,
    classification.planType,
    classification.limitId,
    classification.slot,
    classification.windowDurationMins,
  ].join("|");
}

function canonicalControlState(value) {
  return value === "controlled" || value === "uncontrolled" ? value : "unknown";
}

function modelNames(modelMix) {
  return Object.keys(modelMix ?? {}).sort();
}

function capacityAssumptions(inferenceReport) {
  const result = new Map();
  for (const series of inferenceReport?.series ?? []) {
    const classification = series.classification;
    if (!classification) continue;
    const identified = series.identifiability?.reportedCapacityRangeUsd;
    const provisional = Number(
      series.identifiability?.provisionalRobustCapacityUsd
      ?? series.models?.floor?.robustEstimate?.capacityUsd,
    );
    if (Number.isFinite(identified?.lower) && identified.lower > 0
        && Number.isFinite(identified?.upper) && identified.upper >= identified.lower) {
      result.set(seriesKey(classification), {
        status: "identified_range",
        pointCapacityUsd: (identified.lower + identified.upper) / 2,
        rangeUsd: { lower: identified.lower, upper: identified.upper },
      });
    } else if (Number.isFinite(provisional) && provisional > 0) {
      result.set(seriesKey(classification), {
        status: "provisional_non_identifiable_sensitivity_only",
        pointCapacityUsd: provisional,
        rangeUsd: null,
      });
    } else {
      result.set(seriesKey(classification), {
        status: "unavailable",
        pointCapacityUsd: null,
        rangeUsd: null,
      });
    }
  }
  return result;
}

function normalizeTransition(transition) {
  const coverageFraction = transition.quality?.elapsedTimeCoverageFraction
    ?? transition.quality?.localCoverage?.elapsedTimeCoverageFraction;
  return {
    sourceKind: transition.intervalKind === "adjacent_snapshot_interval"
      ? "historical_snapshot_interval"
      : "historical_transition",
    sourceLabel: null,
    eventTime: transition.eventTime,
    elapsedMs: Number.isFinite(transition.elapsedMs)
      ? transition.elapsedMs
      : Math.max(0, Date.parse(transition.eventTime) - Date.parse(transition.lastPriorObservedAt ?? transition.priorObservedAt)),
    classification: {
      provider: transition.provider,
      planType: transition.planType,
      limitId: transition.limitId,
      slot: transition.slot,
      windowDurationMins: transition.windowDurationMins,
      resetsAt: transition.resetsAt,
    },
    priorUsedPercent: transition.priorUsedPercent,
    nextUsedPercent: transition.nextUsedPercent,
    localApiPricedUsd: transition.marginalApiPricedUsd,
    localUsageEventCount: transition.marginalUsageEventCount,
    controlledState: canonicalControlState(transition.controlledState),
    coverageState: coverageFraction === 1 ? "complete_elapsed_time" : (Number.isFinite(coverageFraction) ? "partial_elapsed_time" : "unknown"),
    coverageFraction: Number.isFinite(coverageFraction) ? coverageFraction : null,
    snapshotAgeMs: transition.snapshot?.providerSnapshotAgeMs ?? null,
    priceCardIds: [...new Set(transition.priceCardIds ?? [])].sort(),
    pricingWarnings: [...new Set(transition.quality?.pricingWarnings ?? [])].sort(),
    qualityWarnings: [...new Set(transition.quality?.warnings ?? [])].sort(),
    models: modelNames(transition.modelMix),
    concurrentLocalUsageDetected: transition.controlledState === "uncontrolled",
    resetChangedOrAmbiguous: !Number.isFinite(transition.resetsAt),
  };
}

function normalizeExperiment(result) {
  if (!result || !["completed", "completed_with_stop"].includes(result.status) || !result.measuredLocal) return [];
  const beforeByKey = new Map((result.before?.windows ?? []).map((window) => [
    [window.limitId, window.slot, window.windowDurationMins, window.resetsAt].join("|"),
    window,
  ]));
  return (result.quotaChanges ?? []).flatMap((change) => {
    const key = [change.limitId, change.slot, change.windowDurationMins, change.resetsAt].join("|");
    const before = beforeByKey.get(key);
    const beforeUsedPercent = Number.isFinite(change.beforeUsedPercent)
      ? change.beforeUsedPercent
      : (Number.isFinite(change.displayedMovement) ? 0 : null);
    const afterUsedPercent = Number.isFinite(change.afterUsedPercent)
      ? change.afterUsedPercent
      : (Number.isFinite(change.displayedMovement) ? beforeUsedPercent + change.displayedMovement : null);
    if (!Number.isFinite(beforeUsedPercent) || !Number.isFinite(afterUsedPercent)) return [];
    return [{
      sourceKind: "controlled_experiment",
      sourceLabel: null,
      eventTime: result.endedAt ?? result.after?.capturedAt,
      elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
      classification: {
        provider: before?.provider ?? "openai_codex",
        planType: before?.planType ?? "unknown",
        limitId: change.limitId ?? "codex",
        slot: change.slot ?? "primary",
        windowDurationMins: Number.isFinite(change.windowDurationMins) ? change.windowDurationMins : 0,
        resetsAt: Number.isFinite(change.resetsAt) ? change.resetsAt : null,
      },
      priorUsedPercent: beforeUsedPercent,
      nextUsedPercent: afterUsedPercent,
      localApiPricedUsd: result.measuredLocal.apiPricedUsd,
      localUsageEventCount: result.measuredLocal.diagnostics?.pricedEvents ?? null,
      controlledState: canonicalControlState(result.controlledState),
      coverageState: result.measuredLocal.diagnostics ? "complete_measured_interval_scan" : "unknown",
      coverageFraction: result.measuredLocal.diagnostics ? 1 : null,
      snapshotAgeMs: null,
      priceCardIds: [...new Set(result.projection?.priceCardIds ?? [])].sort(),
      pricingWarnings: Object.keys(result.measuredLocal.warningCounts ?? {}).sort(),
      qualityWarnings: [...new Set(result.stopReasons ?? [])].sort(),
      models: modelNames(result.measuredLocal.models),
      concurrentLocalUsageDetected: result.concurrencyEvidence?.concurrentLocalUsageDetected === true,
      resetChangedOrAmbiguous: change.resetChangedOrMissingBefore === true,
    }];
  });
}

function residualAtCapacity(interval, capacityUsd) {
  if (!(capacityUsd > 0) || !Number.isFinite(interval.localApiPricedUsd)) {
    return {
      predictedQuotaDeltaPercentagePoints: null,
      observedQuotaDeltaInterval: null,
      residualIntervalPercentagePoints: null,
      residualCenterPercentagePoints: null,
      explainedWithinDisplayGranularity: null,
    };
  }
  const displayedDelta = interval.nextUsedPercent - interval.priorUsedPercent;
  const predicted = interval.localApiPricedUsd * 100 / capacityUsd;
  const observedInterval = {
    lower: displayedDelta - 1,
    upper: displayedDelta + 1,
    model: "difference_of_two_integer_display_bins",
  };
  const residual = {
    lower: observedInterval.lower - predicted,
    upper: observedInterval.upper - predicted,
  };
  return {
    predictedQuotaDeltaPercentagePoints: round(predicted),
    observedQuotaDeltaInterval: { ...observedInterval, lower: round(observedInterval.lower), upper: round(observedInterval.upper) },
    residualIntervalPercentagePoints: { lower: round(residual.lower), upper: round(residual.upper) },
    residualCenterPercentagePoints: round(displayedDelta - predicted),
    explainedWithinDisplayGranularity: residual.lower <= 0 && residual.upper >= 0,
  };
}

function intervalFlags(interval, prediction, staleSnapshotMs) {
  const displayedDelta = interval.nextUsedPercent - interval.priorUsedPercent;
  const flags = [];
  if (displayedDelta < 0) flags.push("negative_quota_delta");
  if (displayedDelta === 0 && interval.localApiPricedUsd > 0) flags.push("cost_without_quota_movement");
  if (displayedDelta !== 0 && (!(interval.localUsageEventCount > 0) || interval.localApiPricedUsd === 0)) {
    flags.push("quota_movement_without_local_cost");
  }
  if (interval.coverageState.startsWith("partial") || interval.coverageState === "unknown") flags.push("local_coverage_gap");
  if (interval.elapsedMs > LARGE_OBSERVATION_GAP_MS) flags.push("large_observation_gap");
  if (interval.snapshotAgeMs === null) flags.push("snapshot_age_unavailable");
  else if (interval.snapshotAgeMs > staleSnapshotMs) flags.push("stale_provider_snapshot");
  if (interval.resetChangedOrAmbiguous) flags.push("reset_changed_or_ambiguous");
  if (interval.pricingWarnings.length > 0) flags.push("pricing_incomplete");
  if (interval.models.length > 1) flags.push("mixed_model_or_fallback_activity");
  if (interval.models.includes("unknown")) flags.push("unknown_model_activity");
  if (interval.concurrentLocalUsageDetected) flags.push("concurrent_local_activity");
  if (interval.controlledState === "unknown") flags.push("unknown_control_state");
  if (interval.controlledState === "uncontrolled") flags.push("uncontrolled_interval");
  if (prediction.explainedWithinDisplayGranularity === false) {
    flags.push("unexplained_movement");
    if (prediction.residualIntervalPercentagePoints.lower > 0) flags.push("possible_unobserved_shared_usage");
    if (prediction.residualIntervalPercentagePoints.upper < 0) flags.push("local_price_proxy_exceeds_displayed_movement");
  }
  return [...new Set(flags)].sort();
}

function hypothesesFor(flags) {
  const hypotheses = [];
  if (flags.includes("possible_unobserved_shared_usage")) hypotheses.push("other_surface_device_or_unlogged_activity_possible");
  if (flags.includes("quota_movement_without_local_cost")) hypotheses.push("missing_local_events_or_unobserved_shared_usage_possible");
  if (flags.includes("local_coverage_gap")) hypotheses.push("local_logging_gap_possible");
  if (flags.includes("stale_provider_snapshot")) hypotheses.push("display_delay_or_catch_up_possible");
  if (flags.includes("mixed_model_or_fallback_activity")) hypotheses.push("model_fallback_or_routing_change_possible");
  if (flags.includes("pricing_incomplete")) hypotheses.push("pricing_proxy_incomplete");
  return hypotheses.sort();
}

function aggregateRows(rows) {
  const residuals = rows.map((row) => row.residual.residualCenterPercentagePoints).filter(Number.isFinite);
  const flagCounts = {};
  for (const row of rows) for (const flag of row.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
  return {
    intervals: rows.length,
    windowIntervalApiPricedUsdSum: round(rows.reduce((sum, row) => sum + row.local.apiPricedUsd, 0)),
    windowIntervalDisplayedQuotaDeltaSum: round(rows.reduce((sum, row) => sum + row.observed.displayedQuotaDeltaPercentagePoints, 0)),
    overlapWarning: "do_not_treat_as_unique_usage_or_quota_burn_across_simultaneous_limit_windows",
    unexplainedIntervals: rows.filter((row) => row.flags.includes("unexplained_movement")).length,
    meanAbsoluteResidualCenterPercentagePoints: residuals.length === 0 ? null : round(mean(residuals.map(Math.abs))),
    flagCounts: Object.fromEntries(Object.entries(flagCounts).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function groupView(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, aggregateRows(values)]));
}

function sensitivityView(rows, assumptions) {
  const bySeries = new Map();
  for (const row of rows) {
    const key = seriesKey(row.classification);
    const group = bySeries.get(key) ?? [];
    group.push(row);
    bySeries.set(key, group);
  }
  return [...bySeries.entries()].flatMap(([key, seriesRows]) => {
    const assumption = assumptions.get(key);
    if (!(assumption?.pointCapacityUsd > 0)) {
      return [{ classification: seriesRows[0].classification, capacityStatus: "unavailable", candidateCapacityUsd: null, ...aggregateRows([]) }];
    }
    const capacities = SENSITIVITY_MULTIPLIERS.map((multiplier) => ({
      multiplier,
      capacityUsd: assumption.pointCapacityUsd * multiplier,
    }));
    if (assumption.rangeUsd) {
      capacities.push({ multiplier: null, capacityUsd: assumption.rangeUsd.lower });
      capacities.push({ multiplier: null, capacityUsd: assumption.rangeUsd.upper });
    }
    const seen = new Set();
    return capacities.filter((candidate) => {
      const keyValue = round(candidate.capacityUsd);
      if (seen.has(keyValue)) return false;
      seen.add(keyValue);
      return true;
    }).map((candidate) => {
      const residuals = seriesRows.map((row) => {
        const residual = residualAtCapacity({
          nextUsedPercent: row.observed.afterUsedPercent,
          priorUsedPercent: row.observed.beforeUsedPercent,
          localApiPricedUsd: row.local.apiPricedUsd,
        }, candidate.capacityUsd);
        return residual.residualCenterPercentagePoints;
      }).filter(Number.isFinite);
      return {
        classification: seriesRows[0].classification,
        capacityStatus: assumption.status,
        candidateCapacityUsd: round(candidate.capacityUsd),
        relativeToPointEstimate: candidate.multiplier,
        intervalCount: seriesRows.length,
        modelAndFallbackSensitivity: [...new Set(seriesRows.flatMap((row) => row.local.models))].sort(),
        basis: "api_priced_cost_to_displayed_quota_sensitivity_without_causal_correction",
        meanAbsoluteResidualCenterPercentagePoints: residuals.length === 0 ? null : round(mean(residuals.map(Math.abs))),
      };
    });
  }).sort((left, right) => seriesKey(left.classification).localeCompare(seriesKey(right.classification))
    || (left.candidateCapacityUsd ?? 0) - (right.candidateCapacityUsd ?? 0));
}

function residualChangePoints(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.residual.residualCenterPercentagePoints)) continue;
    const key = seriesKey(row.classification);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    group.sort((left, right) => left.eventTime.localeCompare(right.eventTime));
    if (group.length < CHANGE_POINT_MINIMUM_SIDE * 2) return null;
    let best = null;
    for (let split = CHANGE_POINT_MINIMUM_SIDE; split <= group.length - CHANGE_POINT_MINIMUM_SIDE; split += 1) {
      const before = mean(group.slice(0, split).map((row) => row.residual.residualCenterPercentagePoints));
      const after = mean(group.slice(split).map((row) => row.residual.residualCenterPercentagePoints));
      const shift = Math.abs(after - before);
      if (!best || shift > best.absoluteMeanResidualShiftPercentagePoints) {
        best = {
          splitEventTime: group[split].eventTime,
          beforeMeanResidualPercentagePoints: round(before),
          afterMeanResidualPercentagePoints: round(after),
          absoluteMeanResidualShiftPercentagePoints: round(shift),
        };
      }
    }
    return {
      classification: group[0].classification,
      tested: true,
      flagged: best.absoluteMeanResidualShiftPercentagePoints >= CHANGE_POINT_THRESHOLD_PERCENTAGE_POINTS,
      kind: "capacity_or_accounting_residual_change_point_candidate",
      thresholdPercentagePoints: CHANGE_POINT_THRESHOLD_PERCENTAGE_POINTS,
      ...best,
    };
  }).filter(Boolean).sort((left, right) => seriesKey(left.classification).localeCompare(seriesKey(right.classification)));
}

function structuralChanges(rows) {
  const ordered = [...rows].sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const changes = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const next = ordered[index];
    const basePrior = [prior.classification.provider, prior.classification.planType, prior.classification.limitId, prior.classification.slot, prior.classification.windowDurationMins].join("|");
    const baseNext = [next.classification.provider, next.classification.planType, next.classification.limitId, next.classification.slot, next.classification.windowDurationMins].join("|");
    if (basePrior !== baseNext) {
      changes.push({ intervalIndex: next.intervalIndex, eventTime: next.eventTime, type: "plan_limit_or_window_change" });
    }
    if (prior.classification.resetsAt !== next.classification.resetsAt) {
      changes.push({ intervalIndex: next.intervalIndex, eventTime: next.eventTime, type: "reset_boundary" });
    }
    if (prior.local.models.length > 0
        && prior.local.models.join("|") === next.local.models.join("|")
        && prior.priceCardIds.length > 0
        && next.priceCardIds.length > 0
        && prior.priceCardIds.join("|") !== next.priceCardIds.join("|")) {
      changes.push({ intervalIndex: next.intervalIndex, eventTime: next.eventTime, type: "pricing_source_change" });
      next.flags = [...new Set([...next.flags, "pricing_source_change"])].sort();
    }
  }
  const lastModelsBySeries = new Map();
  const lastPricesBySeriesAndModel = new Map();
  for (const row of ordered) {
    const models = row.local.models.join("|");
    if (models.length === 0) continue;
    const key = seriesKey(row.classification);
    const priorModels = lastModelsBySeries.get(key);
    if (priorModels && priorModels !== models) {
      changes.push({ intervalIndex: row.intervalIndex, eventTime: row.eventTime, type: "model_mix_change" });
    }
    lastModelsBySeries.set(key, models);
    if (row.priceCardIds.length === 0) continue;
    const priceKey = `${key}|${models}`;
    const prices = row.priceCardIds.join("|");
    const priorPrices = lastPricesBySeriesAndModel.get(priceKey);
    if (priorPrices && priorPrices !== prices) {
      changes.push({ intervalIndex: row.intervalIndex, eventTime: row.eventTime, type: "pricing_source_change" });
      row.flags = [...new Set([...row.flags, "pricing_source_change"])].sort();
    }
    lastPricesBySeriesAndModel.set(priceKey, prices);
  }
  const deduplicated = new Map(changes.map((change) => [`${change.intervalIndex}|${change.type}`, change]));
  return [...deduplicated.values()].sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.type.localeCompare(right.type));
}

function staleCatchUps(rows) {
  const ordered = [...rows].sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const result = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const stale = ordered[index];
    const next = ordered[index + 1];
    if (seriesKey(stale.classification) !== seriesKey(next.classification)) continue;
    if (!stale.flags.includes("stale_provider_snapshot")) continue;
    if (stale.observed.displayedQuotaDeltaPercentagePoints <= 0
        && next.observed.displayedQuotaDeltaPercentagePoints >= 2) {
      result.push({
        kind: "stale_display_catch_up_candidate",
        staleIntervalIndex: stale.intervalIndex,
        catchUpIntervalIndex: next.intervalIndex,
        catchUpEventTime: next.eventTime,
        classification: next.classification,
      });
      next.flags = [...new Set([...next.flags, "possible_stale_display_catch_up"])].sort();
    }
  }
  return result;
}

function dailyBucketSignals(observations) {
  return (observations ?? []).flatMap((observation) => {
    if (observation?.kind !== "codex_quota_observation") return [];
    return (observation.windows ?? []).flatMap((window) => {
      const activity = window.officialTokenActivity;
      const ratio = Number(activity?.localToOfficialCurrentDayRatio);
      if (!Number.isFinite(ratio) || ratio < 0) return [];
      const direction = ratio < 0.8
        ? "local_below_official_daily_tokens"
        : (ratio > 1.2 ? "local_above_official_daily_tokens" : "roughly_aligned_with_official_daily_tokens");
      return [{
        capturedAt: observation.capturedAt,
        classification: {
          limitId: window.limitId,
          slot: window.slot,
          windowDurationMins: window.windowDurationMins,
          resetsAt: window.resetsAt,
        },
        currentUtcDayTokens: Number.isFinite(activity.currentUtcDayTokens) ? activity.currentUtcDayTokens : null,
        dateBucketTotalSinceStartDate: Number.isFinite(activity.dateBucketTotalSinceStartDate) ? activity.dateBucketTotalSinceStartDate : null,
        localToOfficialCurrentDayRatio: round(ratio),
        direction,
        role: "lagging_anomaly_signal_only_not_interval_denominator_or_correction",
      }];
    });
  }).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)
    || String(left.classification.limitId).localeCompare(String(right.classification.limitId)));
}

export function analyzeContamination({
  transitionDataset,
  inferenceReport,
  experimentResults = [],
  captureObservations = [],
  staleSnapshotMs = DEFAULT_STALE_SNAPSHOT_MS,
} = {}) {
  if (!transitionDataset || transitionDataset.schemaVersion !== "0.3" || !Array.isArray(transitionDataset.transitions)) {
    throw new Error("Expected a schema 0.3 transition dataset");
  }
  if (!inferenceReport || inferenceReport.schemaVersion !== "0.3" || !Array.isArray(inferenceReport.series)) {
    throw new Error("Expected a schema 0.3 inference report");
  }
  const assumptions = capacityAssumptions(inferenceReport);
  const materializedAtCandidates = [
    transitionDataset.materializedAt,
    ...experimentResults.flatMap((result) => [result?.endedAt, result?.after?.capturedAt]),
    ...captureObservations.map((observation) => observation?.capturedAt),
  ].filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  const materializedAt = materializedAtCandidates.sort().at(-1) ?? transitionDataset.materializedAt;
  const normalized = [
    ...(Array.isArray(transitionDataset.snapshotIntervals)
      ? transitionDataset.snapshotIntervals
      : transitionDataset.transitions).map(normalizeTransition),
    ...experimentResults.flatMap(normalizeExperiment),
  ].filter((interval) => Number.isFinite(interval.priorUsedPercent)
      && Number.isFinite(interval.nextUsedPercent)
      && Number.isFinite(interval.localApiPricedUsd)
      && typeof interval.eventTime === "string")
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime)
      || seriesKey(left.classification).localeCompare(seriesKey(right.classification)));
  const rows = normalized.map((interval, intervalIndex) => {
    const assumption = assumptions.get(seriesKey(interval.classification)) ?? {
      status: "unavailable",
      pointCapacityUsd: null,
      rangeUsd: null,
    };
    const prediction = residualAtCapacity(interval, assumption.pointCapacityUsd);
    const flags = intervalFlags(interval, prediction, staleSnapshotMs);
    return {
      intervalIndex,
      sourceKind: interval.sourceKind,
      sourceLabel: interval.sourceLabel,
      eventTime: interval.eventTime,
      classification: interval.classification,
      controlledState: interval.controlledState,
      observed: {
        beforeUsedPercent: interval.priorUsedPercent,
        afterUsedPercent: interval.nextUsedPercent,
        displayedQuotaDeltaPercentagePoints: round(interval.nextUsedPercent - interval.priorUsedPercent),
        elapsedMs: Number.isFinite(interval.elapsedMs) ? interval.elapsedMs : null,
      },
      local: {
        apiPricedUsd: round(interval.localApiPricedUsd),
        usageEventCount: interval.localUsageEventCount,
        coverageState: interval.coverageState,
        coverageFraction: interval.coverageFraction,
        concurrentLocalUsageDetected: interval.concurrentLocalUsageDetected,
        models: interval.models,
      },
      capacityAssumption: {
        status: assumption.status,
        pointCapacityUsd: assumption.pointCapacityUsd === null ? null : round(assumption.pointCapacityUsd),
        rangeUsd: assumption.rangeUsd,
      },
      residual: prediction,
      snapshotAgeMs: interval.snapshotAgeMs,
      priceCardIds: interval.priceCardIds,
      pricingWarnings: interval.pricingWarnings,
      flags,
      hypotheses: hypothesesFor(flags),
    };
  });
  const structural = structuralChanges(rows);
  const catchUps = staleCatchUps(rows);
  const strictReferenceIntervals = rows.filter((row) => row.controlledState === "controlled"
    && row.local.coverageState !== "unknown"
    && !row.local.coverageState.startsWith("partial")
    && row.pricingWarnings.length === 0
    && row.local.concurrentLocalUsageDetected !== true);
  const strictReferenceMinimum = 8;
  const overallVerdict = inferenceReport.overallVerdict === "range_identified"
      && strictReferenceIntervals.length >= strictReferenceMinimum
    ? "residual_diagnostics_available"
    : "non_identifiable";
  const explainedMovement = overallVerdict === "residual_diagnostics_available"
    ? {
        status: "measurable_under_identified_capacity_and_control_gate",
        count: rows.filter((row) => row.residual.explainedWithinDisplayGranularity === true).length,
        intervalIndexes: rows.filter((row) => row.residual.explainedWithinDisplayGranularity === true).map((row) => row.intervalIndex),
      }
    : {
        status: "not_measurable_capacity_or_control_gate_non_identifiable",
        count: null,
        intervalIndexes: [],
      };
  return {
    schemaVersion: SCHEMA_VERSION,
    estimatorVersion: ESTIMATOR_VERSION,
    materializedAt,
    source: {
      transitionSchemaVersion: transitionDataset.schemaVersion,
      transitionParserVersion: transitionDataset.parserVersion,
      inferenceEstimatorVersion: inferenceReport.estimatorVersion,
      experimentResultSchemaVersions: [...new Set(experimentResults.map((result) => result?.schemaVersion).filter(Boolean))].sort(),
    },
    policy: {
      staleSnapshotMs,
      changePointMinimumIntervalsPerSide: CHANGE_POINT_MINIMUM_SIDE,
      changePointThresholdPercentagePoints: CHANGE_POINT_THRESHOLD_PERCENTAGE_POINTS,
      displayedDeltaIntervalModel: "difference_of_two_integer_display_bins",
      strictReferenceMinimumControlledIntervals: strictReferenceMinimum,
    },
    overallVerdict,
    summary: {
      ...aggregateRows(rows),
      strictControlledReferenceIntervals: strictReferenceIntervals.length,
    },
    intervals: rows,
    views: {
      byControlState: Object.fromEntries(["controlled", "uncontrolled", "unknown"].map((state) => [state, {
        controlState: state,
        ...aggregateRows(rows.filter((row) => row.controlledState === state)),
      }])),
      byCoverage: groupView(rows, (row) => row.local.coverageState),
      negativeDeltas: {
        count: rows.filter((row) => row.flags.includes("negative_quota_delta")).length,
        intervalIndexes: rows.filter((row) => row.flags.includes("negative_quota_delta")).map((row) => row.intervalIndex),
      },
      unexplainedMovement: {
        count: rows.filter((row) => row.flags.includes("unexplained_movement")).length,
        intervalIndexes: rows.filter((row) => row.flags.includes("unexplained_movement")).map((row) => row.intervalIndex),
      },
      explainedMovement,
      resets: groupView(rows, (row) => `${seriesKey(row.classification)}|${row.classification.resetsAt}`),
      sensitivity: sensitivityView(rows, assumptions),
      changePoints: residualChangePoints(rows),
      structuralChanges: structural,
      staleCatchUps: catchUps,
      dailyBucketSignals: dailyBucketSignals(captureObservations),
    },
    dataBoundaries: {
      causalInterpretation: "not_supported_by_residuals_alone",
      causalStatement: "Residuals cannot distinguish other device or surface use from missing local events, display delay, routing, or a wrong capacity proxy.",
      provisionalCapacityUse: "sensitivity_only_when_inference_is_non_identifiable",
      officialDailyBuckets: "not_used_to_correct_rescale_or_force_interval_residuals",
      hypotheses: "competing_explanations_not_detected_causes",
      historicalIntervalSource: Array.isArray(transitionDataset.snapshotIntervals)
        ? "adjacent_snapshot_intervals_including_zero_movement"
        : "collapsed_transition_fallback_zero_movement_unavailable",
      localOnly: true,
      storedConversationContent: false,
      storedStableIdentifiers: false,
      storedPathsOrToolArguments: false,
    },
  };
}

export function renderContaminationReport(report) {
  const date = report.materializedAt.slice(0, 10);
  const structuralCounts = {};
  for (const change of report.views.structuralChanges) {
    structuralCounts[change.type] = (structuralCounts[change.type] ?? 0) + 1;
  }
  const lines = [
    "---",
    "title: Shared-Pool Contamination and Residual Report",
    `date: ${date}`,
    "type: research",
    `status: ${report.overallVerdict === "non_identifiable" ? "non-identifiable" : "diagnostic"}`,
    "---",
    "",
    "# Shared-Pool Contamination and Residual Report",
    "",
    `Overall verdict: **${report.overallVerdict.replaceAll("_", " ")}**.`,
    "",
    `Analyzed ${report.summary.intervals} aligned intervals: ${report.views.byControlState.controlled.intervals} controlled, ${report.views.byControlState.uncontrolled.intervals} uncontrolled, and ${report.views.byControlState.unknown.intervals} unknown.`,
    "",
    `Strict controlled reference intervals: ${report.summary.strictControlledReferenceIntervals}/${report.policy.strictReferenceMinimumControlledIntervals} required.`,
    "",
    `Unexplained beyond the integer-display interval under the selected capacity assumptions: ${report.views.unexplainedMovement.count}. Explained movement: ${report.views.explainedMovement.count ?? `not measurable (${report.views.explainedMovement.status})`}. Negative displayed deltas: ${report.views.negativeDeltas.count}.`,
    "",
    `Zero displayed movement with positive local API-priced cost: ${report.summary.flagCounts.cost_without_quota_movement ?? 0}. Displayed movement without retained local cost: ${report.summary.flagCounts.quota_movement_without_local_cost ?? 0}. Large observation gaps: ${report.summary.flagCounts.large_observation_gap ?? 0}.`,
    "",
    "Residuals are conditional on standard API-price-equivalent capacity assumptions. A provisional capacity from a non-identifiable inference is shown only as sensitivity analysis and is not a recovered provider limit.",
    "",
    "## Change and contamination views",
    "",
    `Residual change-point series tested: ${report.views.changePoints.filter((item) => item.tested).length}; flagged: ${report.views.changePoints.filter((item) => item.flagged).length}.`,
    "",
    `Structural boundaries: ${report.views.structuralChanges.length} (${Object.entries(structuralCounts).sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => `${type}: ${count}`).join(", ") || "none"}); stale-display catch-up candidates: ${report.views.staleCatchUps.length}.`,
    "",
    `Official daily-bucket anomaly signals: ${report.views.dailyBucketSignals.length}; these are lagging signals only and do not enter interval residual arithmetic.`,
    "",
    "## Interpretation boundary",
    "",
    "Positive residuals can be consistent with another device or surface, a logging gap, stale display catch-up, routing changes, or a wrong capacity proxy. They do not identify which cause occurred. Official daily buckets are not used to force local cost and displayed quota into agreement.",
    "",
  ];
  return lines.join("\n");
}
