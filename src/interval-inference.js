const INFERENCE_SCHEMA_VERSION = "0.3";
const ESTIMATOR_VERSION = "interval-boundary-v0.3.0";
const EPSILON = 1e-12;
const BOOTSTRAP_REPLICATES = 500;
const BOOTSTRAP_SEED = 0x5eed2026;
const BOOTSTRAP_MAX_PAIR_SAMPLE = 1_000;

const GATE_POLICY = {
  minimumEligibleTransitions: 8,
  minimumDisplayedPercentSpan: 5,
  maximumRelativeFeasibleWidth: 0.5,
  maximumHoldoutMaePercentagePoints: 1.5,
  maximumUnknownControlFraction: 0.25,
  rationale: {
    minimumEligibleTransitions: "Eight boundaries leave room for multiple fit constraints and at least two validation observations.",
    minimumDisplayedPercentSpan: "Five displayed points are five times the one-point display granularity, limiting domination by a single rounding boundary.",
    maximumRelativeFeasibleWidth: "A range wider than half its midpoint is not operationally precise enough to call a capacity.",
    maximumHoldoutMaePercentagePoints: "One and a half points allows one integer display bin plus a half-point delayed/rounding tolerance.",
    maximumUnknownControlFraction: "More than one quarter unknown or uncontrolled intervals makes shared-pool contamination material by design.",
  },
};

function round(value, places = 12) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values) {
  if (values.length === 0) return null;
  return quantile([...values].sort((left, right) => left - right), 0.5);
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function resetGroupKey(transition) {
  return [
    transition.accountScopeId ?? "unattributed",
    transition.planVariant ?? "unknown",
    transition.provider,
    transition.planType,
    transition.limitId,
    transition.slot,
    transition.windowDurationMins,
    transition.resetsAt,
  ].join("|");
}

function seriesKey(transition) {
  return [
    transition.accountScopeId ?? "unattributed",
    transition.planVariant ?? "unknown",
    transition.provider,
    transition.planType,
    transition.limitId,
    transition.slot,
    transition.windowDurationMins,
  ].join("|");
}

function exclusionReasons(transition) {
  const reasons = [];
  if (!(transition.nextUsedPercent > transition.priorUsedPercent)) reasons.push("not_monotonic_increase");
  if (!(transition.marginalUsageEventCount > 0)) reasons.push("no_retained_usage_event");
  if (transition.quality?.localCoverage?.elapsedTimeCoverageFraction !== 1) reasons.push("partial_elapsed_time_coverage");
  if ((transition.quality?.pricingWarnings?.length ?? 0) > 0) reasons.push("pricing_warning");
  if ((transition.quality?.attributionWarnings?.length ?? 0) > 0) reasons.push("attribution_warning");
  return reasons;
}

function lagLowerCost(transition, model) {
  if (model.kind === "delayed_event") {
    return transition.displayLagEnvelopes?.byEventCount
      ?.find((entry) => entry.maxLagEvents === model.maxLagEvents)
      ?.lowerCumulativeApiPricedUsd ?? transition.lastPriorCumulativeApiPricedUsd;
  }
  if (model.kind === "delayed_time") {
    return transition.displayLagEnvelopes?.byElapsedTime
      ?.find((entry) => entry.maxLagMs === model.maxLagMs)
      ?.lowerCumulativeApiPricedUsd ?? transition.lastPriorCumulativeApiPricedUsd;
  }
  return transition.lastPriorCumulativeApiPricedUsd;
}

function thresholdFor(transition, model) {
  return model.rounding === "nearest"
    ? transition.nextUsedPercent - 0.5
    : transition.nextUsedPercent;
}

function toBoundaries(transitions, model) {
  return transitions.map((transition, index) => ({
    index,
    group: resetGroupKey(transition),
    threshold: thresholdFor(transition, model),
    lowerCostUsd: lagLowerCost(transition, model),
    upperCostUsd: transition.firstNextCumulativeApiPricedUsd,
    eventTime: transition.eventTime,
    transition,
  }));
}

export function jointlyFeasibleCapacity(boundaries) {
  const groups = new Map();
  for (const boundary of boundaries) {
    const group = groups.get(boundary.group) ?? [];
    group.push(boundary);
    groups.set(boundary.group, group);
  }
  let lowerUsd = 0;
  let upperUsd = Number.POSITIVE_INFINITY;
  const contradictions = [];
  for (const [group, observations] of groups) {
    for (const left of observations) {
      for (const right of observations) {
        const coefficient = (left.threshold - right.threshold) / 100;
        const rightHandSide = left.upperCostUsd - right.lowerCostUsd;
        if (Math.abs(coefficient) <= EPSILON) {
          if (rightHandSide < -EPSILON) contradictions.push({ group, type: "parallel_non_overlap" });
        } else if (coefficient > 0) {
          upperUsd = Math.min(upperUsd, rightHandSide / coefficient);
        } else {
          lowerUsd = Math.max(lowerUsd, rightHandSide / coefficient);
        }
      }
    }
  }
  lowerUsd = Math.max(0, lowerUsd);
  const feasible = contradictions.length === 0 && upperUsd > lowerUsd && upperUsd > 0;
  const midpointUsd = feasible && Number.isFinite(upperUsd)
    ? (lowerUsd > 0 ? Math.sqrt(lowerUsd * upperUsd) : upperUsd / 2)
    : null;
  return {
    feasible,
    lowerUsd: feasible ? round(lowerUsd) : null,
    upperUsd: feasible && Number.isFinite(upperUsd) ? round(upperUsd) : null,
    midpointUsd: midpointUsd === null ? null : round(midpointUsd),
    upperBounded: feasible && Number.isFinite(upperUsd),
    contradictionCount: contradictions.length,
  };
}

function originAlignedCapacity(boundaries) {
  let lowerUsd = 0;
  let upperUsd = Number.POSITIVE_INFINITY;
  let used = 0;
  for (const boundary of boundaries) {
    if (!(boundary.threshold > 0)) continue;
    lowerUsd = Math.max(lowerUsd, 100 * boundary.lowerCostUsd / boundary.threshold);
    upperUsd = Math.min(upperUsd, 100 * boundary.upperCostUsd / boundary.threshold);
    used += 1;
  }
  const feasible = used > 0 && upperUsd >= lowerUsd && upperUsd > 0;
  return {
    assumption: "zero_hidden_usage_offset_at_local_window_start",
    boundaryCount: used,
    feasible,
    lowerUsd: feasible ? round(lowerUsd) : null,
    upperUsd: feasible && Number.isFinite(upperUsd) ? round(upperUsd) : null,
  };
}

function pairwiseCapacityEstimates(boundaries) {
  const groups = new Map();
  for (const boundary of boundaries) {
    const group = groups.get(boundary.group) ?? [];
    group.push(boundary);
    groups.set(boundary.group, group);
  }
  const estimates = [];
  for (const observations of groups.values()) {
    observations.sort((left, right) => left.eventTime.localeCompare(right.eventTime));
    for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
        const left = observations[leftIndex];
        const right = observations[rightIndex];
        const thresholdDelta = right.threshold - left.threshold;
        const leftCost = (left.lowerCostUsd + left.upperCostUsd) / 2;
        const rightCost = (right.lowerCostUsd + right.upperCostUsd) / 2;
        const costDelta = rightCost - leftCost;
        if (thresholdDelta <= 0 || costDelta <= 0) continue;
        estimates.push(100 * costDelta / thresholdDelta);
      }
    }
  }
  return estimates;
}

function bootstrapMedian(estimates) {
  if (estimates.length < 2) return { replicates: 0, seed: BOOTSTRAP_SEED, lowerUsd: null, upperUsd: null };
  const ordered = [...estimates].sort((left, right) => left - right);
  const population = ordered.length <= BOOTSTRAP_MAX_PAIR_SAMPLE
    ? ordered
    : Array.from({ length: BOOTSTRAP_MAX_PAIR_SAMPLE }, (_, index) => ordered[Math.floor(index * ordered.length / BOOTSTRAP_MAX_PAIR_SAMPLE)]);
  const random = makeRng(BOOTSTRAP_SEED);
  const medians = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    const sample = [];
    for (let index = 0; index < population.length; index += 1) {
      sample.push(population[Math.floor(random() * population.length)]);
    }
    medians.push(median(sample));
  }
  medians.sort((left, right) => left - right);
  return {
    method: "deterministic_pairwise_median_bootstrap",
    replicates: BOOTSTRAP_REPLICATES,
    seed: BOOTSTRAP_SEED,
    sourcePairCount: estimates.length,
    resamplePairCount: population.length,
    lowerUsd: round(quantile(medians, 0.025)),
    upperUsd: round(quantile(medians, 0.975)),
  };
}

function robustEstimate(boundaries, { bootstrap = true } = {}) {
  const estimates = pairwiseCapacityEstimates(boundaries);
  const point = median(estimates);
  const deviations = point === null ? [] : estimates.map((value) => Math.abs(value - point));
  const mad = median(deviations);
  return {
    method: "within_reset_pairwise_theil_sen",
    pairCount: estimates.length,
    capacityUsd: point === null ? null : round(point),
    medianAbsoluteDeviationUsd: mad === null ? null : round(mad),
    central80PercentRangeUsd: estimates.length === 0 ? null : {
      lower: round(quantile([...estimates].sort((left, right) => left - right), 0.1)),
      upper: round(quantile([...estimates].sort((left, right) => left - right), 0.9)),
    },
    bootstrap95PercentUsd: bootstrap ? bootstrapMedian(estimates) : null,
  };
}

function groupOffset(boundaries, capacityUsd) {
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  const midpoints = [];
  for (const boundary of boundaries) {
    const intervalLower = boundary.threshold * capacityUsd / 100 - boundary.upperCostUsd;
    const intervalUpper = boundary.threshold * capacityUsd / 100 - boundary.lowerCostUsd;
    lower = Math.max(lower, intervalLower);
    upper = Math.min(upper, intervalUpper);
    midpoints.push((intervalLower + intervalUpper) / 2);
  }
  if (lower <= upper) return (lower + upper) / 2;
  return median(midpoints);
}

function residualRows(boundaries, capacityUsd, fitBoundaries = boundaries) {
  if (!(capacityUsd > 0)) return [];
  const fitGroups = new Map();
  for (const boundary of fitBoundaries) {
    const group = fitGroups.get(boundary.group) ?? [];
    group.push(boundary);
    fitGroups.set(boundary.group, group);
  }
  const offsets = new Map([...fitGroups].map(([key, group]) => [key, groupOffset(group, capacityUsd)]));
  return boundaries.flatMap((boundary) => {
    const offset = offsets.get(boundary.group);
    if (!Number.isFinite(offset)) return [];
    const predictedCost = boundary.threshold * capacityUsd / 100 - offset;
    const residualUsd = predictedCost < boundary.lowerCostUsd
      ? boundary.lowerCostUsd - predictedCost
      : (predictedCost > boundary.upperCostUsd ? predictedCost - boundary.upperCostUsd : 0);
    const transition = boundary.transition;
    const components = transition.marginalComponents;
    const inputTotal = components.input_uncached_tokens + components.input_cache_read_tokens + components.input_cache_write_tokens;
    const outputTotal = components.output_text_tokens + components.output_reasoning_tokens;
    const cacheShare = inputTotal === 0 ? null : (components.input_cache_read_tokens + components.input_cache_write_tokens) / inputTotal;
    const reasoningShare = outputTotal === 0 ? null : components.output_reasoning_tokens / outputTotal;
    const modelNames = Object.keys(transition.modelMix).sort();
    const toolClasses = Object.keys(transition.aggregateToolClassMix).sort();
    const fullWindowStartMs = Date.parse(transition.quality.localCoverage.fullWindowStartsAt);
    const windowDurationMs = transition.windowDurationMins * 60_000;
    const ageFraction = Math.max(0, Math.min(1, (Date.parse(transition.eventTime) - fullWindowStartMs) / windowDurationMs));
    return [{
      residualPercentagePoints: 100 * residualUsd / capacityUsd,
      modelBucket: modelNames.length === 1 ? modelNames[0] : (modelNames.length === 0 ? "unknown" : "mixed"),
      cacheShareBucket: cacheShare === null ? "unavailable" : (cacheShare < 0.25 ? "low" : (cacheShare < 0.75 ? "medium" : "high")),
      reasoningShareBucket: reasoningShare === null ? "unavailable" : (reasoningShare < 0.1 ? "low" : (reasoningShare < 0.5 ? "medium" : "high")),
      toolClassBucket: toolClasses.length === 0 ? "no_tool" : (toolClasses.length === 1 ? toolClasses[0] : "mixed"),
      utcHourBucket: String(new Date(transition.eventTime).getUTCHours()).padStart(2, "0"),
      windowAgeBucket: ageFraction < 0.25 ? "first_quarter" : (ageFraction < 0.5 ? "second_quarter" : (ageFraction < 0.75 ? "third_quarter" : "fourth_quarter")),
    }];
  });
}

function aggregateResiduals(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const values = groups.get(row[field]) ?? [];
    values.push(row.residualPercentagePoints);
    groups.set(row[field], values);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, values]) => ({
    bucket,
    count: values.length,
    meanAbsoluteErrorPercentagePoints: round(values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length),
    maximumAbsoluteErrorPercentagePoints: round(Math.max(...values.map(Math.abs))),
  }));
}

function residualDiagnostics(boundaries, capacityUsd) {
  const rows = residualRows(boundaries, capacityUsd);
  return {
    count: rows.length,
    overallMeanAbsoluteErrorPercentagePoints: rows.length === 0 ? null : round(rows.reduce((sum, row) => sum + Math.abs(row.residualPercentagePoints), 0) / rows.length),
    byModelMix: aggregateResiduals(rows, "modelBucket"),
    byCacheShare: aggregateResiduals(rows, "cacheShareBucket"),
    byReasoningShare: aggregateResiduals(rows, "reasoningShareBucket"),
    byToolClass: aggregateResiduals(rows, "toolClassBucket"),
    byUtcHour: aggregateResiduals(rows, "utcHourBucket"),
    byWindowAge: aggregateResiduals(rows, "windowAgeBucket"),
  };
}

function holdoutNewest(boundaries) {
  const groups = new Map();
  for (const boundary of boundaries) {
    const group = groups.get(boundary.group) ?? [];
    group.push(boundary);
    groups.set(boundary.group, group);
  }
  const training = [];
  const holdout = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.eventTime.localeCompare(right.eventTime));
    if (group.length < 5) {
      training.push(...group);
      continue;
    }
    const holdoutCount = Math.max(1, Math.floor(group.length * 0.2));
    training.push(...group.slice(0, -holdoutCount));
    holdout.push(...group.slice(-holdoutCount));
  }
  const fit = robustEstimate(training, { bootstrap: false });
  const rows = residualRows(holdout, fit.capacityUsd, training);
  return {
    method: "newest_20_percent_within_each_eligible_reset_group",
    trainingBoundaries: training.length,
    holdoutBoundaries: holdout.length,
    fittedCapacityUsd: fit.capacityUsd,
    meanAbsoluteErrorPercentagePoints: rows.length === 0 ? null : round(rows.reduce((sum, row) => sum + Math.abs(row.residualPercentagePoints), 0) / rows.length),
    maximumAbsoluteErrorPercentagePoints: rows.length === 0 ? null : round(Math.max(...rows.map((row) => Math.abs(row.residualPercentagePoints)))),
  };
}

function changePointDiagnostic(boundaries) {
  const ordered = [...boundaries].sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  if (ordered.length < 20) return { tested: false, reason: "fewer_than_20_boundaries" };
  const step = Math.max(1, Math.floor(ordered.length / 20));
  let best = null;
  for (let split = 8; split <= ordered.length - 8; split += step) {
    const left = robustEstimate(ordered.slice(0, split), { bootstrap: false }).capacityUsd;
    const right = robustEstimate(ordered.slice(split), { bootstrap: false }).capacityUsd;
    if (!(left > 0) || !(right > 0)) continue;
    const ratio = Math.max(left, right) / Math.min(left, right);
    if (!best || ratio > best.capacityRatio) {
      best = { splitEventTime: ordered[split].eventTime, beforeCapacityUsd: left, afterCapacityUsd: right, capacityRatio: round(ratio) };
    }
  }
  if (!best) return { tested: false, reason: "insufficient_within_reset_pairs_on_each_side" };
  return { tested: true, flagged: best.capacityRatio >= 1.25, thresholdRatio: 1.25, ...best };
}

function fitModel(transitions, model) {
  const boundaries = toBoundaries(transitions, model);
  const feasible = jointlyFeasibleCapacity(boundaries);
  const robust = robustEstimate(boundaries);
  return {
    observationModel: model,
    boundaryCount: boundaries.length,
    jointlyFeasibleCapacityUsd: feasible,
    robustEstimate: robust,
    originAlignedSensitivity: originAlignedCapacity(boundaries),
    holdout: holdoutNewest(boundaries),
    residualDiagnostics: residualDiagnostics(boundaries, robust.capacityUsd),
    changePointDiagnostic: changePointDiagnostic(boundaries),
  };
}

function intervalsOverlap(left, right) {
  if (!left?.lowerUsd || !left?.upperUsd || !right?.lowerUsd || !right?.upperUsd) return null;
  return Math.max(left.lowerUsd, right.lowerUsd) <= Math.min(left.upperUsd, right.upperUsd);
}

function inferSeries(transitions) {
  const excludedByReason = {};
  const controlStateCounts = {};
  const eligible = [];
  for (const transition of transitions) {
    controlStateCounts[transition.controlledState] = (controlStateCounts[transition.controlledState] ?? 0) + 1;
    const reasons = exclusionReasons(transition);
    if (reasons.length === 0) eligible.push(transition);
    for (const reason of reasons) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  const first = transitions[0];
  const models = {
    floor: fitModel(eligible, { name: "floor", kind: "immediate", rounding: "floor" }),
    nearest: fitModel(eligible, { name: "nearest", kind: "immediate", rounding: "nearest" }),
    delayedEvent1: fitModel(eligible, { name: "delayed_event_1", kind: "delayed_event", rounding: "floor", maxLagEvents: 1 }),
    delayedTime30s: fitModel(eligible, { name: "delayed_time_30s", kind: "delayed_time", rounding: "floor", maxLagMs: 30_000 }),
  };
  const displayedValues = eligible.flatMap((transition) => [transition.priorUsedPercent, transition.nextUsedPercent]);
  const displayedPercentSpan = displayedValues.length === 0 ? 0 : Math.max(...displayedValues) - Math.min(...displayedValues);
  const unknownControls = (controlStateCounts.unknown ?? 0) + (controlStateCounts.uncontrolled ?? 0);
  const unknownControlFraction = transitions.length === 0 ? 1 : unknownControls / transitions.length;
  const floorFeasible = models.floor.jointlyFeasibleCapacityUsd;
  const failures = [];
  if (eligible.length < GATE_POLICY.minimumEligibleTransitions) failures.push("too_few_eligible_transitions");
  if (displayedPercentSpan < GATE_POLICY.minimumDisplayedPercentSpan) failures.push("insufficient_displayed_percentage_span");
  if (!floorFeasible.feasible || !floorFeasible.upperBounded) failures.push("no_finite_jointly_feasible_capacity_interval");
  if (floorFeasible.feasible && floorFeasible.upperBounded) {
    const midpoint = (floorFeasible.lowerUsd + floorFeasible.upperUsd) / 2;
    const relativeWidth = midpoint > 0 ? (floorFeasible.upperUsd - floorFeasible.lowerUsd) / midpoint : Number.POSITIVE_INFINITY;
    if (relativeWidth > GATE_POLICY.maximumRelativeFeasibleWidth) failures.push("jointly_feasible_interval_too_wide");
  }
  if (models.floor.holdout.meanAbsoluteErrorPercentagePoints === null
      || models.floor.holdout.meanAbsoluteErrorPercentagePoints > GATE_POLICY.maximumHoldoutMaePercentagePoints) {
    failures.push("heldout_error_unavailable_or_too_large");
  }
  if (unknownControlFraction > GATE_POLICY.maximumUnknownControlFraction) failures.push("material_unknown_or_uncontrolled_activity");
  const delayedOverlap = intervalsOverlap(floorFeasible, models.delayedEvent1.jointlyFeasibleCapacityUsd);
  if (delayedOverlap === false) failures.push("capacity_depends_on_unverified_display_delay_model");
  const changePoint = models.floor.changePointDiagnostic;
  if (changePoint.tested && changePoint.flagged) failures.push("candidate_capacity_change_point");
  const uniqueFailures = [...new Set(failures)].sort();

  return {
    classification: {
      accountScopeId: first.accountScopeId ?? "unattributed",
      planVariant: first.planVariant ?? "unknown",
      provider: first.provider,
      planType: first.planType,
      limitId: first.limitId,
      slot: first.slot,
      windowDurationMins: first.windowDurationMins,
    },
    selection: {
      totalTransitions: transitions.length,
      eligibleTransitions: eligible.length,
      excludedByReason,
      controlStateCounts,
      unknownOrUncontrolledFraction: round(unknownControlFraction),
      displayedPercentSpan,
    },
    models,
    modelComparison: {
      floorAndNearestSlopeEquivalentWithPerResetOffset: true,
      explanation: "Changing every threshold by the same half point is absorbed by the per-reset nuisance offset; slope/capacity is not distinguished without an origin anchor.",
      floorDelayedEventIntervalsOverlap: delayedOverlap,
    },
    identifiability: {
      verdict: uniqueFailures.length === 0 ? "range_identified" : "non_identifiable",
      failures: uniqueFailures,
      reportedCapacityRangeUsd: uniqueFailures.length === 0 ? {
        lower: floorFeasible.lowerUsd,
        upper: floorFeasible.upperUsd,
      } : null,
      provisionalRobustCapacityUsd: models.floor.robustEstimate.capacityUsd,
    },
  };
}

export function inferCapacityFromTransitions(dataset) {
  if (!dataset || dataset.schemaVersion !== "0.3" || !Array.isArray(dataset.transitions)) {
    throw new Error("Expected a schema 0.3 transition dataset");
  }
  const grouped = new Map();
  for (const transition of dataset.transitions) {
    const key = seriesKey(transition);
    const group = grouped.get(key) ?? [];
    group.push(transition);
    grouped.set(key, group);
  }
  const series = [...grouped.values()]
    .filter((transitions) => transitions.length > 0)
    .map(inferSeries)
    .sort((left, right) => seriesKey(left.classification).localeCompare(seriesKey(right.classification)));
  return {
    schemaVersion: INFERENCE_SCHEMA_VERSION,
    estimatorVersion: ESTIMATOR_VERSION,
    materializedAt: dataset.materializedAt,
    source: {
      transitionSchemaVersion: dataset.schemaVersion,
      transitionParserVersion: dataset.parserVersion,
      scope: dataset.scope,
      standardApiPricing: dataset.pricing,
    },
    gatePolicy: GATE_POLICY,
    overallVerdict: series.length > 0 && series.every((item) => item.identifiability.verdict === "range_identified")
      ? "range_identified"
      : "non_identifiable",
    series,
  };
}

export function renderInferenceReport(report) {
  const date = report.source.scope.endAt.slice(0, 10);
  const lines = [
    "---",
    "title: Usage Limit Interval Inference Report",
    `date: ${date}`,
    "type: research",
    `status: ${report.overallVerdict === "range_identified" ? "accepted" : "non-identifiable"}`,
    "---",
    "",
    "# Usage Limit Interval Inference Report",
    "",
    `Overall verdict: **${report.overallVerdict.replaceAll("_", " ")}**.`,
    "",
    "The primary model treats every increasing display change as an interval containing a hidden integer threshold. It fits one capacity across reset windows while allowing a separate hidden-usage offset for each reset. Standard API-priced dollars are an explanatory proxy, not a claim about the provider's private accounting formula.",
    "",
  ];
  for (const item of report.series) {
    const label = `${item.classification.limitId}/${item.classification.slot}/${item.classification.windowDurationMins}m`;
    lines.push(`## ${label}`, "");
    lines.push(`Eligible transitions: ${item.selection.eligibleTransitions}/${item.selection.totalTransitions}; displayed span: ${item.selection.displayedPercentSpan} percentage points.`, "");
    lines.push(`Verdict: **${item.identifiability.verdict.replaceAll("_", " ")}**.`, "");
    if (item.identifiability.verdict === "range_identified") {
      const feasible = item.models.floor.jointlyFeasibleCapacityUsd;
      lines.push(feasible.feasible && feasible.upperBounded
        ? `Exact floor-model feasible range: $${feasible.lowerUsd.toFixed(2)} to $${feasible.upperUsd.toFixed(2)}.`
        : "Exact floor-model feasible range: not finite or mutually incompatible.", "");
      const robust = item.models.floor.robustEstimate;
      lines.push(`Robust pairwise median: ${robust.capacityUsd === null ? "unavailable" : `$${robust.capacityUsd.toFixed(2)}`}; bootstrap 95%: ${robust.bootstrap95PercentUsd.lowerUsd === null ? "unavailable" : `$${robust.bootstrap95PercentUsd.lowerUsd.toFixed(2)} to $${robust.bootstrap95PercentUsd.upperUsd.toFixed(2)}`}.`, "");
      lines.push(`Newest-transition holdout MAE: ${item.models.floor.holdout.meanAbsoluteErrorPercentagePoints === null ? "unavailable" : `${item.models.floor.holdout.meanAbsoluteErrorPercentagePoints.toFixed(3)} percentage points`}.`, "");
    } else {
      lines.push("Capacity, bootstrap, and fit diagnostics are withheld because the identifiability gate failed; inspect the machine artifact only for method development, not as a reported allowance.", "");
    }
    if (item.identifiability.failures.length > 0) {
      lines.push("Gate failures:", "", ...item.identifiability.failures.map((failure) => `- ${failure}`), "");
    }
  }
  lines.push(
    "## Model boundary",
    "",
    "Floor and nearest-integer rounding have the same capacity slope once each reset receives a free offset; the half-point shift moves only that offset. Origin-aligned results are retained as sensitivity analysis because they can distinguish the two only by assuming zero hidden/shared usage at the local window start.",
    "",
    "Delayed-display variants widen each transition boundary using the actual cost of the prior one request or prior 30 seconds stored by the transition miner.",
    "",
  );
  return lines.join("\n");
}
