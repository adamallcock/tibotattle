import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";

const SCHEMA_VERSION = "weekly-calibration-v0.2";
const WEEKLY_WINDOW_MINS = SEVEN_DAY_WINDOW_MINUTES;

// Reporting owns this small runtime-neutral decimal helper so its projections
// do not cross into the accounting owner just to aggregate provenance totals.
function normalizeDecimal(value, label) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  const input = String(value ?? "").trim();
  if (!input) throw new TypeError(`${label} must be a non-negative decimal`);
  const match = input.match(/^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) throw new TypeError(`${label} must be a non-negative decimal`);
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new TypeError(`${label} exponent is too large`);
  }
  let digits = `${match[1]}${match[2] ?? ""}`;
  let scale = (match[2] ?? "").length - exponent;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1_000) {
    throw new TypeError(`${label} precision is too large`);
  }
  digits = digits.replace(/^0+(?=\d)/u, "");
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  while (scale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  if (!digits || /^0+$/u.test(digits)) return "0";
  if (scale === 0) return digits;
  if (digits.length <= scale) return `0.${"0".repeat(scale - digits.length)}${digits}`;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function decimalParts(value) {
  const normalized = normalizeDecimal(value, "decimal");
  const [whole, fraction = ""] = normalized.split(".");
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function addUsdStrings(...values) {
  return values.reduce((total, value) => {
    const left = decimalParts(total);
    const right = decimalParts(value);
    const scale = Math.max(left.scale, right.scale);
    const sum = left.value * (10n ** BigInt(scale - left.scale))
      + right.value * (10n ** BigInt(scale - right.scale));
    const digits = sum.toString().padStart(scale + 1, "0");
    return normalizeDecimal(
      scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`,
      "sum",
    );
  }, "0");
}

const FROZEN_BASELINE = {
  id: "weekly-calibration-2026-07-24-v0.1",
  sourceEndAt: "2026-07-24T13:51:29.000Z",
  qualifyingResets: 14,
  medianApiPriceEquivalentUsd: 1878.752157,
  sameResetHoldoutMaePp: 2.160749,
  sameResetHoldoutBiasPp: -1.745481,
  priorResetMaePp: 3.953951,
  priorResetBiasPp: -1.223901,
};

const ONLINE_CHECKPOINTS = [5, 10, 15, 20, 30, 40, 50, 60].map((displaySpanPp) => ({
  id: `display_${displaySpanPp}pp`,
  displaySpanPp,
  minimumBoundaries: 9,
}));

const FORECAST_METHODS = [
  { id: "rolling_3_median", label: "Rolling median of up to 3 prior resets" },
  { id: "rolling_3_median_calibrated", label: "Rolling 3 median with prior forecast-ratio correction" },
  { id: "rolling_2_median", label: "Rolling median of 2 prior resets" },
  { id: "expanding_median", label: "Expanding median of all prior resets" },
  { id: "recency_weighted_mean_0_5", label: "Recency-weighted mean (0.5 decay)" },
  { id: "recency_weighted_mean_0_5_calibrated", label: "Recency-weighted mean with prior forecast-ratio correction" },
  { id: "regime_15pct_persistence_2", label: "15% persistent-shift regime prior" },
];

const CANDIDATES = [
  { id: "standard_api", label: "Standard API cost", kind: "standard" },
  { id: "speed_lower", label: "Captured speed lower bound", kind: "lower" },
  { id: "speed_midpoint", label: "Captured speed midpoint", kind: "midpoint" },
  { id: "speed_upper", label: "Captured speed upper bound", kind: "upper" },
];

const LAG_CANDIDATES = [
  { id: "no_delay", label: "No display delay", kind: "standard" },
  { id: "one_event", label: "Up to one prior usage event", kind: "lag_event", maxLagEvents: 1 },
  { id: "delay_5s", label: "Up to 5 seconds", kind: "lag_time", maxLagMs: 5_000 },
  { id: "delay_30s", label: "Up to 30 seconds", kind: "lag_time", maxLagMs: 30_000 },
  { id: "delay_60s", label: "Up to 60 seconds", kind: "lag_time", maxLagMs: 60_000 },
];

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function quantile(values, probability) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] * (1 - (position - lower)) + ordered[upper] * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function partitionKey(row, { includeSlot = true } = {}) {
  return [
    row.accountScopeId ?? "unattributed",
    row.provider,
    row.planType,
    row.limitId,
    includeSlot ? row.slot : null,
    row.windowDurationMins,
  ].filter((value) => value !== null).join("|");
}

function slotResetKey(row) {
  return `${partitionKey(row)}|${row.resetsAt}`;
}

function logicalResetKey(row) {
  return `${partitionKey(row, { includeSlot: false })}|${row.resetsAt}`;
}

function isEligible(row) {
  return row.windowDurationMins === WEEKLY_WINDOW_MINS
    && row.limitId === "codex"
    && row.nextUsedPercent > row.priorUsedPercent
    && row.marginalUsageEventCount > 0
    && row.quality?.localCoverage?.elapsedTimeCoverageFraction === 1
    && (row.quality?.pricingWarnings?.length ?? 0) === 0
    && (row.quality?.attributionWarnings?.length ?? 0) === 0;
}

function priceCardProvenance(rows) {
  const ids = new Set();
  const byCard = new Map();
  for (const row of rows) {
    for (const id of Array.isArray(row.priceCardIds) ? row.priceCardIds : []) {
      if (typeof id === "string" && id.length > 0 && id.length <= 128) ids.add(id);
    }
    for (const item of Array.isArray(row.priceCardBreakdown) ? row.priceCardBreakdown : []) {
      if (typeof item?.priceCardId !== "string"
          || item.priceCardId.length === 0
          || item.priceCardId.length > 128
          || !Number.isSafeInteger(item.events)
          || item.events < 0
          || typeof item.costUsd !== "string"
          || !/^\d+(?:\.\d+)?$/u.test(item.costUsd)) continue;
      ids.add(item.priceCardId);
      const current = byCard.get(item.priceCardId) ?? {
        priceCardId: item.priceCardId,
        events: 0,
        costUsd: "0",
      };
      current.events += item.events;
      current.costUsd = addUsdStrings(current.costUsd, item.costUsd);
      byCard.set(item.priceCardId, current);
    }
  }
  return {
    priceCardIds: [...ids].sort(),
    priceCardBreakdown: [...byCard.values()].sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
  };
}

function boundaryCost(row, candidate, side) {
  const prefix = side === "prior" ? "lastPrior" : "firstNext";
  const standard = row[`${prefix}CumulativeApiPricedUsd`];
  const lower = row[`${prefix}CumulativeQuotaWeightedLowerUsd`];
  const upper = row[`${prefix}CumulativeQuotaWeightedUpperUsd`];
  if (candidate.kind === "lag_event" && side === "prior") {
    return row.displayLagEnvelopes?.byEventCount
      ?.find((entry) => entry.maxLagEvents === candidate.maxLagEvents)
      ?.lowerCumulativeApiPricedUsd ?? standard;
  }
  if (candidate.kind === "lag_time" && side === "prior") {
    return row.displayLagEnvelopes?.byElapsedTime
      ?.find((entry) => entry.maxLagMs === candidate.maxLagMs)
      ?.lowerCumulativeApiPricedUsd ?? standard;
  }
  if (candidate.kind === "standard") return standard;
  if (candidate.kind === "lower") return lower;
  if (candidate.kind === "upper") return upper;
  return Number.isFinite(lower) && Number.isFinite(upper) ? (lower + upper) / 2 : null;
}

function midpointBoundary(row, candidate) {
  const lower = boundaryCost(row, candidate, "prior");
  const upper = boundaryCost(row, candidate, "next");
  return Number.isFinite(lower) && Number.isFinite(upper) ? (lower + upper) / 2 : null;
}

function uniquePoints(rows, candidate) {
  const ordered = [...rows].filter(isEligible).sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  if (ordered.length === 0) return [];
  const byPercent = new Map();
  const add = (percent, cost, observedAt) => {
    if (!Number.isFinite(percent) || !Number.isFinite(cost)) return;
    const values = byPercent.get(percent) ?? [];
    values.push({ cost, observedAt });
    byPercent.set(percent, values);
  };
  const initialCost = candidate.kind === "lag_event" || candidate.kind === "lag_time"
    ? ordered[0].lastPriorCumulativeApiPricedUsd
    : boundaryCost(ordered[0], candidate, "prior");
  add(ordered[0].priorUsedPercent, initialCost, ordered[0].lastPriorObservedAt);
  for (const row of ordered) add(row.nextUsedPercent, midpointBoundary(row, candidate), row.firstNextObservedAt);
  return [...byPercent.entries()]
    .map(([percent, values]) => ({
      percent,
      costUsd: median(values.map((value) => value.cost)),
      observedAt: values.map((value) => value.observedAt).sort().at(-1),
    }))
    .sort((left, right) => left.percent - right.percent || left.costUsd - right.costUsd);
}

function pairwiseCapacities(points) {
  const capacities = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const percentDelta = points[right].percent - points[left].percent;
      const costDelta = points[right].costUsd - points[left].costUsd;
      if (percentDelta > 0 && costDelta > 0) capacities.push(100 * costDelta / percentDelta);
    }
  }
  return capacities;
}

function capacityFit(points) {
  const pairs = pairwiseCapacities(points);
  const capacityUsd = median(pairs);
  return {
    capacityUsd,
    pairCount: pairs.length,
    central80Usd: pairs.length === 0 ? null : {
      lower: quantile(pairs, 0.1),
      upper: quantile(pairs, 0.9),
    },
  };
}

function scoreFromAnchor(points, capacityUsd, anchor) {
  if (!Number.isFinite(capacityUsd) || capacityUsd <= 0 || points.length === 0) return null;
  const scored = points.map((point) => {
    const observedChangePp = point.percent - anchor.percent;
    const predictedChangePp = 100 * (point.costUsd - anchor.costUsd) / capacityUsd;
    const residualPp = predictedChangePp - observedChangePp;
    return {
      observedAt: point.observedAt,
      observedChangePp: round(observedChangePp),
      predictedChangePp: round(predictedChangePp),
      residualPp: round(residualPp),
      absoluteErrorPp: round(Math.abs(residualPp)),
    };
  });
  return {
    pointCount: scored.length,
    observedMovementPp: round(scored.at(-1).observedChangePp),
    predictedMovementPp: round(scored.at(-1).predictedChangePp),
    meanAbsoluteErrorPp: round(mean(scored.map((row) => row.absoluteErrorPp))),
    signedBiasPp: round(mean(scored.map((row) => row.residualPp))),
    finalResidualPp: round(scored.at(-1).residualPp),
    rows: scored,
  };
}

function fitRelativeCentral80Width(fit) {
  return fit.central80Usd && fit.capacityUsd > 0
    ? (fit.central80Usd.upper - fit.central80Usd.lower) / fit.capacityUsd
    : null;
}

function evaluateCheckpoint(points, checkpoint, priorCapacityUsd = null) {
  const baselinePercent = points[0]?.percent;
  const trainingEndIndex = points.findIndex((point, index) => index + 1 >= checkpoint.minimumBoundaries
    && point.percent - baselinePercent >= checkpoint.displaySpanPp);
  if (trainingEndIndex < 0 || points.length - trainingEndIndex - 1 < 2) return null;
  const training = points.slice(0, trainingEndIndex + 1);
  const later = points.slice(trainingEndIndex + 1);
  const fit = capacityFit(training);
  const width = fitRelativeCentral80Width(fit);
  if (!Number.isFinite(fit.capacityUsd) || fit.pairCount < 8 || !Number.isFinite(width) || width > 1) return null;
  const anchor = training.at(-1);
  const onlineScore = scoreFromAnchor(later, fit.capacityUsd, anchor);
  const priorScore = Number.isFinite(priorCapacityUsd)
    ? scoreFromAnchor(later, priorCapacityUsd, anchor)
    : null;
  return {
    checkpointId: checkpoint.id,
    requestedDisplaySpanPp: checkpoint.displaySpanPp,
    actualTrainingSpanPp: round(anchor.percent - baselinePercent),
    checkpointObservedAt: anchor.observedAt,
    trainingBoundaryCount: training.length,
    laterBoundaryCount: later.length,
    fittedCapacityUsd: round(fit.capacityUsd),
    relativeCentral80Width: round(width),
    onlineScore,
    priorScore,
    improvementVersusPriorFraction: priorScore?.meanAbsoluteErrorPp > 0
      ? round((priorScore.meanAbsoluteErrorPp - onlineScore.meanAbsoluteErrorPp) / priorScore.meanAbsoluteErrorPp)
      : null,
  };
}

function aggregateScores(records, scoreField) {
  const scores = records.map((record) => record[scoreField]).filter(Boolean);
  const points = scores.flatMap((score) => score.rows);
  return {
    scoredResets: scores.length,
    scoredPoints: points.length,
    pooledMaePp: round(mean(points.map((point) => point.absoluteErrorPp))),
    pooledBiasPp: round(mean(points.map((point) => point.residualPp))),
    medianResetMaePp: round(median(scores.map((score) => score.meanAbsoluteErrorPp))),
  };
}

function summarizeEvidence(rows) {
  const eligible = rows.filter(isEligible);
  const components = {};
  const models = {};
  const tools = {};
  const controlledStates = {};
  const snapshotAges = [];
  const localReceiptLags = [];
  const tierEvents = {};
  for (const row of eligible) {
    for (const [component, value] of Object.entries(row.marginalComponents ?? {})) {
      if (Number.isFinite(value)) components[component] = (components[component] ?? 0) + value;
    }
    for (const [model, values] of Object.entries(row.modelMix ?? {})) {
      const target = models[model] ??= { costUsd: 0, events: 0 };
      target.costUsd += values.costUsd ?? 0;
      target.events += values.events ?? 0;
    }
    for (const [toolClass, count] of Object.entries(row.aggregateToolClassMix ?? {})) {
      tools[toolClass] = (tools[toolClass] ?? 0) + count;
    }
    controlledStates[row.controlledState ?? "unknown"] = (controlledStates[row.controlledState ?? "unknown"] ?? 0) + 1;
    if (Number.isFinite(row.snapshot?.providerSnapshotAgeMs)) snapshotAges.push(row.snapshot.providerSnapshotAgeMs);
    if (Number.isFinite(row.snapshot?.localReceiptLagMs)) localReceiptLags.push(row.snapshot.localReceiptLagMs);
    for (const [tier, count] of Object.entries(row.tierUsageEventCounts ?? {})) tierEvents[tier] = (tierEvents[tier] ?? 0) + count;
  }
  const totalTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
  const totalModelCost = Object.values(models).reduce((sum, value) => sum + value.costUsd, 0);
  const totalTierEvents = Object.values(tierEvents).reduce((sum, value) => sum + value, 0);
  const knownTierEvents = (tierEvents.standard ?? 0) + (tierEvents.fast ?? 0);
  return {
    tokenComponents: components,
    componentTokenShares: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, totalTokens > 0 ? round(value / totalTokens) : null])),
    modelCostShares: Object.fromEntries(Object.entries(models).map(([key, value]) => [key, totalModelCost > 0 ? round(value.costUsd / totalModelCost) : null])),
    modelEventCounts: Object.fromEntries(Object.entries(models).map(([key, value]) => [key, value.events])),
    toolClassCounts: tools,
    controlledStateCounts: controlledStates,
    coverage: {
      eligibleTransitions: eligible.length,
      accountKnownFraction: eligible.length > 0 ? round(eligible.filter((row) => row.accountScopeId && row.accountScopeId !== "unattributed").length / eligible.length) : null,
      speedKnownEventFraction: totalTierEvents > 0 ? round(knownTierEvents / totalTierEvents) : null,
      providerSnapshotAgeKnownFraction: eligible.length > 0 ? round(snapshotAges.length / eligible.length) : null,
      controlledStateKnownFraction: eligible.length > 0 ? round(eligible.filter((row) => row.controlledState && row.controlledState !== "unknown").length / eligible.length) : null,
      medianProviderSnapshotAgeMs: round(median(snapshotAges)),
      p90ProviderSnapshotAgeMs: round(quantile(snapshotAges, 0.9)),
      medianLocalReceiptLagMs: round(median(localReceiptLags)),
    },
  };
}

function aggregateCoverage(rows) {
  const profiles = rows.map((row) => row.evidenceProfile?.coverage).filter(Boolean);
  const total = profiles.reduce((sum, profile) => sum + profile.eligibleTransitions, 0);
  const weighted = (field) => total > 0 ? round(profiles.reduce((sum, profile) => sum
    + (Number.isFinite(profile[field]) ? profile[field] * profile.eligibleTransitions : 0), 0) / total) : null;
  return {
    eligibleTransitions: total,
    accountKnownFraction: weighted("accountKnownFraction"),
    speedKnownEventFraction: weighted("speedKnownEventFraction"),
    providerSnapshotAgeKnownFraction: weighted("providerSnapshotAgeKnownFraction"),
    controlledStateKnownFraction: weighted("controlledStateKnownFraction"),
    acceptanceTargetFraction: 0.9,
  };
}

function baseForecastCapacity(prior, methodId) {
  const capacities = prior.map((row) => row.selectedFit.fullCapacityUsd);
  if (capacities.length < 2) return null;
  if (methodId === "rolling_2_median") return median(capacities.slice(-2));
  if (methodId === "rolling_3_median") return median(capacities.slice(-3));
  if (methodId === "expanding_median") return median(capacities);
  if (methodId === "recency_weighted_mean_0_5") {
    const weighted = capacities.reduce((result, value, index) => {
      const weight = 0.5 ** (capacities.length - index - 1);
      return { numerator: result.numerator + value * weight, denominator: result.denominator + weight };
    }, { numerator: 0, denominator: 0 });
    return weighted.numerator / weighted.denominator;
  }
  return null;
}

function forecastForMethod(prior, methodId) {
  const calibratedBase = methodId.endsWith("_calibrated") ? methodId.replace(/_calibrated$/, "") : null;
  if (calibratedBase) {
    const baseCapacity = baseForecastCapacity(prior, calibratedBase);
    const ratios = [];
    for (let index = 2; index < prior.length; index += 1) {
      const historicalForecast = baseForecastCapacity(prior.slice(0, index), calibratedBase);
      if (historicalForecast > 0) ratios.push(prior[index].selectedFit.fullCapacityUsd / historicalForecast);
    }
    if (!(baseCapacity > 0) || ratios.length < 2) return null;
    const correctionMultiplier = median(ratios.slice(-3));
    return {
      forecastCapacityUsd: baseCapacity * correctionMultiplier,
      regimeDetected: false,
      correctionEvidence: {
        priorForecastRatios: ratios.slice(-3),
        correctionMultiplier,
      },
    };
  }
  const baseCapacity = baseForecastCapacity(prior, methodId);
  if (baseCapacity > 0) return { forecastCapacityUsd: baseCapacity, regimeDetected: false };
  const capacities = prior.map((row) => row.selectedFit.fullCapacityUsd);
  if (capacities.length < 4) return null;
  const earlierMedian = median(capacities.slice(0, -2));
  const recent = capacities.slice(-2);
  const directions = recent.map((value) => (value - earlierMedian) / earlierMedian);
  const regimeDetected = directions.every((value) => value >= 0.15)
    || directions.every((value) => value <= -0.15);
  return {
    forecastCapacityUsd: regimeDetected ? median(recent) : median(capacities.slice(-3)),
    regimeDetected,
    earlierMedianUsd: earlierMedian,
    recentMedianUsd: median(recent),
    recentRelativeChanges: directions,
  };
}

function evaluateForecastMethods(rows) {
  const recordsByMethod = new Map(FORECAST_METHODS.map((method) => [method.id, []]));
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const prior = rows.slice(0, index).filter((candidate) => candidate.continuityTrack === current.continuityTrack
      && candidate.lastObservedAt <= current.firstObservedAt);
    for (const method of FORECAST_METHODS) {
      const forecast = forecastForMethod(prior, method.id);
      if (!forecast) continue;
      const points = current.selectedFit.points;
      const score = scoreFromAnchor(points.slice(1), forecast.forecastCapacityUsd, points[0]);
      recordsByMethod.get(method.id).push({
        methodId: method.id,
        methodLabel: method.label,
        resetIdentity: current.resetIdentity,
        firstObservedAt: current.firstObservedAt,
        priorResetCount: prior.length,
        priorResetIdentities: prior.map((row) => row.resetIdentity),
        forecastCapacityUsd: round(forecast.forecastCapacityUsd),
        regimeDetected: forecast.regimeDetected,
        regimeEvidence: forecast.regimeDetected ? {
          earlierMedianUsd: round(forecast.earlierMedianUsd),
          recentMedianUsd: round(forecast.recentMedianUsd),
          recentRelativeChanges: forecast.recentRelativeChanges.map((value) => round(value)),
        } : null,
        correctionEvidence: forecast.correctionEvidence ? {
          priorForecastRatios: forecast.correctionEvidence.priorForecastRatios.map((value) => round(value)),
          correctionMultiplier: round(forecast.correctionEvidence.correctionMultiplier),
        } : null,
        score,
      });
    }
  }
  const resetMethodCounts = new Map();
  for (const records of recordsByMethod.values()) {
    for (const record of records) resetMethodCounts.set(record.resetIdentity, (resetMethodCounts.get(record.resetIdentity) ?? 0) + 1);
  }
  const commonResetIds = new Set([...resetMethodCounts].filter(([, count]) => count === FORECAST_METHODS.length).map(([resetIdentity]) => resetIdentity));
  const summaries = FORECAST_METHODS.map((method) => {
    const records = recordsByMethod.get(method.id);
    const common = records.filter((record) => commonResetIds.has(record.resetIdentity));
    return {
      id: method.id,
      label: method.label,
      allAvailable: aggregateScores(records, "score"),
      commonEvaluation: aggregateScores(common, "score"),
      detectedRegimeForecasts: records.filter((record) => record.regimeDetected).map((record) => record.resetIdentity),
    };
  });
  const eligible = summaries.filter((summary) => summary.commonEvaluation.scoredResets >= 3 && Number.isFinite(summary.commonEvaluation.pooledMaePp));
  eligible.sort((left, right) => left.commonEvaluation.pooledMaePp - right.commonEvaluation.pooledMaePp
    || Math.abs(left.commonEvaluation.pooledBiasPp) - Math.abs(right.commonEvaluation.pooledBiasPp)
    || FORECAST_METHODS.findIndex((method) => method.id === left.id) - FORECAST_METHODS.findIndex((method) => method.id === right.id));
  const diagnosticBest = eligible[0] ?? summaries[0];
  const baseline = summaries.find((summary) => summary.id === "rolling_3_median") ?? summaries[0];
  const protectedEligible = eligible.filter((summary) => summary.id === baseline.id
    || (baseline.commonEvaluation.pooledMaePp > 0
      && (baseline.commonEvaluation.pooledMaePp - summary.commonEvaluation.pooledMaePp) / baseline.commonEvaluation.pooledMaePp >= 0.1
      && Math.abs(summary.commonEvaluation.pooledBiasPp) <= Math.abs(baseline.commonEvaluation.pooledBiasPp)));
  const selected = protectedEligible[0] ?? baseline;
  const recordsLookup = new Map([...recordsByMethod].map(([methodId, records]) => [
    methodId,
    new Map(records.map((record) => [record.resetIdentity, record])),
  ]));
  const prequentialRecords = [];
  for (const row of rows) {
    const earlierCommonIds = [...commonResetIds].filter((resetIdentity) => resetIdentity < row.resetIdentity);
    const historicalScores = summaries.map((summary) => {
      const records = earlierCommonIds.map((resetIdentity) => recordsLookup.get(summary.id).get(resetIdentity)).filter(Boolean);
      return { methodId: summary.id, ...aggregateScores(records, "score") };
    }).filter((summary) => summary.scoredResets >= 5 && Number.isFinite(summary.pooledMaePp));
    const historicalBaseline = historicalScores.find((summary) => summary.methodId === "rolling_3_median");
    const protectedCandidates = historicalScores.filter((summary) => summary.methodId === "rolling_3_median"
      || (historicalBaseline?.pooledMaePp > 0
        && (historicalBaseline.pooledMaePp - summary.pooledMaePp) / historicalBaseline.pooledMaePp >= 0.1
        && Math.abs(summary.pooledBiasPp) <= Math.abs(historicalBaseline.pooledBiasPp)));
    protectedCandidates.sort((left, right) => left.pooledMaePp - right.pooledMaePp
      || Math.abs(left.pooledBiasPp) - Math.abs(right.pooledBiasPp)
      || FORECAST_METHODS.findIndex((method) => method.id === left.methodId) - FORECAST_METHODS.findIndex((method) => method.id === right.methodId));
    const chosenMethodId = protectedCandidates[0]?.methodId ?? "rolling_3_median";
    const forecast = recordsLookup.get(chosenMethodId).get(row.resetIdentity) ?? null;
    row.selectedForecast = forecast ? {
      ...forecast,
      selectionBasis: protectedCandidates[0]?.methodId !== "rolling_3_median"
        ? "protected_prior_common_improvement"
        : historicalBaseline ? "rolling_three_protected_baseline" : "fixed_cold_start_default",
      selectionTrainingResets: protectedCandidates[0]?.scoredResets ?? 0,
    } : null;
    if (row.selectedForecast) prequentialRecords.push(row.selectedForecast);
  }
  return {
    selectionRule: "on common resets, require >=10% MAE improvement versus rolling_3_median without worse absolute bias; otherwise retain rolling_3_median",
    commonEvaluationResets: commonResetIds.size,
    selectedMethodId: selected.id,
    selectedMethodLabel: selected.label,
    diagnosticBestMethodId: diagnosticBest.id,
    diagnosticBestMethodLabel: diagnosticBest.label,
    diagnosticBestImprovementVersusBaselineFraction: baseline.commonEvaluation.pooledMaePp > 0
      ? round((baseline.commonEvaluation.pooledMaePp - diagnosticBest.commonEvaluation.pooledMaePp) / baseline.commonEvaluation.pooledMaePp)
      : null,
    candidates: summaries,
    prequentialValidation: aggregateScores(prequentialRecords, "score"),
    prequentialRule: "for each reset, require 5 earlier common scores and >=10% MAE improvement without worse absolute bias; otherwise use rolling_3_median",
  };
}

function evaluateFixedBoundaryHypothesis(rows, boundaryAt) {
  const records = [];
  const baselineRecords = [];
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    if (current.firstObservedAt < boundaryAt) continue;
    const allPrior = rows.slice(0, index).filter((candidate) => candidate.continuityTrack === current.continuityTrack
      && candidate.lastObservedAt <= current.firstObservedAt);
    const boundaryPrior = allPrior.filter((candidate) => candidate.firstObservedAt >= boundaryAt);
    if (boundaryPrior.length < 2) continue;
    const points = current.selectedFit.points;
    const boundaryCapacity = median(boundaryPrior.map((candidate) => candidate.selectedFit.fullCapacityUsd));
    const baselineCapacity = median(allPrior.slice(-3).map((candidate) => candidate.selectedFit.fullCapacityUsd));
    records.push({
      resetIdentity: current.resetIdentity,
      priorResetIdentities: boundaryPrior.map((candidate) => candidate.resetIdentity),
      score: scoreFromAnchor(points.slice(1), boundaryCapacity, points[0]),
    });
    baselineRecords.push({
      resetIdentity: current.resetIdentity,
      score: scoreFromAnchor(points.slice(1), baselineCapacity, points[0]),
    });
  }
  const hypothesis = aggregateScores(records, "score");
  const baseline = aggregateScores(baselineRecords, "score");
  return {
    boundaryAt,
    status: records.length >= 3 ? "tested" : "insufficient_independent_resets",
    hypothesis: "reset the expanding forecast history at the proposed boundary",
    scoredResetIdentities: records.map((record) => record.resetIdentity),
    boundarySpecific: hypothesis,
    rollingThreeOnSameResets: baseline,
    improvementFraction: baseline.pooledMaePp > 0
      ? round((baseline.pooledMaePp - hypothesis.pooledMaePp) / baseline.pooledMaePp)
      : null,
    adopted: records.length >= 3
      && baseline.pooledMaePp > 0
      && (baseline.pooledMaePp - hypothesis.pooledMaePp) / baseline.pooledMaePp >= 0.1
      && Math.abs(hypothesis.pooledBiasPp) <= Math.abs(baseline.pooledBiasPp),
  };
}

function evaluateOnlineCalibration(rows) {
  for (const row of rows) {
    row.onlineCheckpoints = Object.fromEntries(ONLINE_CHECKPOINTS.map((checkpoint) => [
      checkpoint.id,
      evaluateCheckpoint(row.selectedFit.points, checkpoint, row.selectedForecast?.forecastCapacityUsd),
    ]));
  }
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    for (const checkpoint of ONLINE_CHECKPOINTS) {
      const evaluation = current.onlineCheckpoints[checkpoint.id];
      if (!evaluation) continue;
      const priorRatios = rows.slice(0, index)
        .filter((row) => row.continuityTrack === current.continuityTrack && row.lastObservedAt <= current.firstObservedAt)
        .map((row) => row.onlineCheckpoints[checkpoint.id]
          ? row.selectedFit.fullCapacityUsd / row.onlineCheckpoints[checkpoint.id].fittedCapacityUsd
          : null)
        .filter((value) => Number.isFinite(value) && value > 0)
        .slice(-3);
      if (priorRatios.length < 3) continue;
      const correctionMultiplier = median(priorRatios);
      const correctedCapacityUsd = evaluation.fittedCapacityUsd * correctionMultiplier;
      const points = current.selectedFit.points;
      const anchorIndex = evaluation.trainingBoundaryCount - 1;
      evaluation.correction = {
        method: "median early-to-full capacity ratio from the prior 3 completed resets",
        priorResetCount: priorRatios.length,
        multiplier: round(correctionMultiplier),
        correctedCapacityUsd: round(correctedCapacityUsd),
      };
      evaluation.correctedOnlineScore = scoreFromAnchor(points.slice(anchorIndex + 1), correctedCapacityUsd, points[anchorIndex]);
    }
  }
  const candidates = ONLINE_CHECKPOINTS.map((checkpoint) => {
    const records = rows.map((row) => row.onlineCheckpoints[checkpoint.id]).filter(Boolean);
    const comparable = records.filter((record) => record.priorScore && record.correctedOnlineScore);
    const rawOnline = aggregateScores(comparable, "onlineScore");
    const online = aggregateScores(comparable, "correctedOnlineScore");
    const prior = aggregateScores(comparable, "priorScore");
    return {
      id: checkpoint.id,
      requestedDisplaySpanPp: checkpoint.displaySpanPp,
      minimumBoundaries: checkpoint.minimumBoundaries,
      availableResets: records.length,
      comparison: {
        ...online,
        rawOnlinePooledMaePp: rawOnline.pooledMaePp,
        rawOnlinePooledBiasPp: rawOnline.pooledBiasPp,
        priorPooledMaePp: prior.pooledMaePp,
        priorPooledBiasPp: prior.pooledBiasPp,
        improvementVersusPriorFraction: prior.pooledMaePp > 0
          ? round((prior.pooledMaePp - online.pooledMaePp) / prior.pooledMaePp)
          : null,
      },
    };
  });
  const targetMeeting = candidates.filter((candidate) => candidate.comparison.scoredResets >= 5
    && candidate.comparison.pooledMaePp <= 1.5
    && candidate.comparison.improvementVersusPriorFraction >= 0.1)
    .sort((left, right) => left.requestedDisplaySpanPp - right.requestedDisplaySpanPp);
  const scored = candidates.filter((candidate) => candidate.comparison.scoredResets >= 5 && Number.isFinite(candidate.comparison.pooledMaePp))
    .sort((left, right) => left.comparison.pooledMaePp - right.comparison.pooledMaePp
      || left.requestedDisplaySpanPp - right.requestedDisplaySpanPp);
  const selected = targetMeeting[0] ?? null;
  const diagnosticBest = scored[0] ?? null;
  const latest = rows.at(-1);
  const latestEvaluation = selected ? latest?.onlineCheckpoints[selected.id] : null;
  return {
    selectionRule: "earliest checkpoint whose prior-reset-corrected online fit has at least 5 comparable resets, <=1.5 pp pooled MAE, and >=10% improvement over the selected prior forecast; otherwise lowest-MAE diagnostic candidate",
    selectionStatus: targetMeeting.length > 0 ? "acceptance_target_met" : scored.length > 0 ? "rejected_no_improvement" : "insufficient_evidence",
    selectedCheckpointId: selected?.id ?? null,
    selectedRequestedDisplaySpanPp: selected?.requestedDisplaySpanPp ?? null,
    diagnosticBestCheckpointId: diagnosticBest?.id ?? null,
    diagnosticBestPooledMaePp: diagnosticBest?.comparison.pooledMaePp ?? null,
    candidates,
    currentReset: latest ? {
      resetIdentity: latest.resetIdentity,
      firstObservedAt: latest.firstObservedAt,
      observedSpanPp: round(latest.selectedFit.percentSpan),
      boundaryCount: latest.selectedFit.pointCount,
      status: latestEvaluation ? "calibrated_experimental" : "prior_only_online_update_rejected",
      fittedCapacityUsd: latestEvaluation?.fittedCapacityUsd ?? null,
      expectedPooledMaePp: selected?.comparison.pooledMaePp ?? null,
      checkpointEvaluation: latestEvaluation,
    } : null,
  };
}

function fitReset(rows, candidate) {
  const points = uniquePoints(rows, candidate);
  if (points.length < 8) return null;
  const fullSpanPp = points.at(-1).percent - points[0].percent;
  if (fullSpanPp < 5) return null;
  const cutoffPercent = points[0].percent + fullSpanPp * 0.7;
  let train = points.filter((point) => point.percent <= cutoffPercent);
  let holdout = points.filter((point) => point.percent > cutoffPercent);
  if (train.length < 5 || holdout.length < 2) {
    const split = Math.max(5, Math.min(points.length - 2, Math.floor(points.length * 0.7)));
    train = points.slice(0, split);
    holdout = points.slice(split);
  }
  const trainFit = capacityFit(train);
  if (!Number.isFinite(trainFit.capacityUsd) || trainFit.pairCount < 6) return null;
  const holdoutScore = scoreFromAnchor(holdout, trainFit.capacityUsd, train.at(-1));
  const fullFit = capacityFit(points);
  if (!Number.isFinite(fullFit.capacityUsd)) return null;
  const relativeCentral80Width = fitRelativeCentral80Width(fullFit);
  if (!Number.isFinite(relativeCentral80Width) || relativeCentral80Width > 1) return null;
  const inSampleScore = scoreFromAnchor(points.slice(1), fullFit.capacityUsd, points[0]);
  const pricing = priceCardProvenance(rows);
  return {
    pointCount: points.length,
    percentSpan: fullSpanPp,
    firstObservedAt: points[0].observedAt,
    lastObservedAt: points.at(-1).observedAt,
    trainPointCount: train.length,
    holdoutPointCount: holdout.length,
    trainPercentSpan: train.at(-1).percent - train[0].percent,
    holdoutPercentSpan: holdout.at(-1).percent - train.at(-1).percent,
    trainCapacityUsd: trainFit.capacityUsd,
    fullCapacityUsd: fullFit.capacityUsd,
    central80Usd: fullFit.central80Usd,
    relativeCentral80Width,
    pairCount: fullFit.pairCount,
    holdoutScore,
    inSampleScore,
    ...pricing,
    points,
  };
}

function observedTimestamp(row, field) {
  const parsed = Date.parse(row[field] ?? row.eventTime);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupInterval(rows) {
  const timestamps = rows.flatMap((row) => [
    observedTimestamp(row, "lastPriorObservedAt"),
    observedTimestamp(row, "firstNextObservedAt"),
    observedTimestamp(row, "eventTime"),
  ]).filter(Number.isFinite);
  return {
    start: timestamps.length > 0 ? Math.min(...timestamps) : null,
    end: timestamps.length > 0 ? Math.max(...timestamps) : null,
  };
}

function rangesOverlap(left, right) {
  return Number.isFinite(left.start)
    && Number.isFinite(left.end)
    && Number.isFinite(right.start)
    && Number.isFinite(right.end)
    && Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function sameObservationTimestamp(left, right) {
  const timestamps = new Set(left.flatMap((row) => [
    observedTimestamp(row, "lastPriorObservedAt"),
    observedTimestamp(row, "firstNextObservedAt"),
    observedTimestamp(row, "eventTime"),
  ]).filter(Number.isFinite));
  return right.some((row) => [
    observedTimestamp(row, "lastPriorObservedAt"),
    observedTimestamp(row, "firstNextObservedAt"),
    observedTimestamp(row, "eventTime"),
  ].some((timestamp) => Number.isFinite(timestamp) && timestamps.has(timestamp)));
}

function hasSimultaneousSlotConflict(rows) {
  const bySlot = new Map();
  for (const row of rows) {
    const values = bySlot.get(row.slot) ?? [];
    values.push(row);
    bySlot.set(row.slot, values);
  }
  const slots = [...bySlot.values()];
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      if (sameObservationTimestamp(slots[left], slots[right])
          || rangesOverlap(groupInterval(slots[left]), groupInterval(slots[right]))) return true;
    }
  }
  return false;
}

function summarizeResetGroup(rows) {
  const ordered = [...rows].sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || String(left.slot).localeCompare(String(right.slot)));
  const eligible = ordered.filter(isEligible);
  const percentages = eligible.flatMap((row) => [row.priorUsedPercent, row.nextUsedPercent])
    .filter(Number.isFinite);
  return {
    rows: ordered,
    eligibleCount: eligible.length,
    observedSpanPp: percentages.length > 0 ? Math.max(...percentages) - Math.min(...percentages) : 0,
    interval: groupInterval(ordered),
    first: ordered[0],
  };
}

function compareResetGroupStrength(left, right) {
  return right.eligibleCount - left.eligibleCount
    || right.observedSpanPp - left.observedSpanPp
    || right.rows.length - left.rows.length
    || left.first.resetsAt - right.first.resetsAt
    || left.first.eventTime.localeCompare(right.first.eventTime);
}

function groupEvidenceWeight(group) {
  return group.eligibleCount * 1_000_000 + group.observedSpanPp * 1_000 + group.rows.length;
}

function selectNonOverlappingGroups(groups) {
  const ordered = [...groups].sort((left, right) => left.interval.end - right.interval.end
    || left.interval.start - right.interval.start
    || compareResetGroupStrength(left, right));
  const compatible = ordered.map((group, index) => {
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      if (ordered[prior].interval.end <= group.interval.start) return prior;
    }
    return -1;
  });
  const best = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const group = ordered[index];
    const include = groupEvidenceWeight(group) + (compatible[index] >= 0 ? best[compatible[index]].weight : 0);
    const exclude = index > 0 ? best[index - 1].weight : 0;
    if (include > exclude) {
      best.push({ weight: include, indices: [...(compatible[index] >= 0 ? best[compatible[index]].indices : []), index] });
      continue;
    }
    if (include < exclude) {
      best.push(index > 0 ? best[index - 1] : { weight: 0, indices: [] });
      continue;
    }
    const included = [...(compatible[index] >= 0 ? best[compatible[index]].indices : []), index];
    const excluded = index > 0 ? best[index - 1].indices : [];
    const includeFirst = included.map((candidate) => ordered[candidate]).sort(compareResetGroupStrength)[0];
    const excludeFirst = excluded.map((candidate) => ordered[candidate]).sort(compareResetGroupStrength)[0];
    best.push(!excludeFirst || compareResetGroupStrength(includeFirst, excludeFirst) < 0
      ? { weight: include, indices: included }
      : (index > 0 ? best[index - 1] : { weight: 0, indices: [] }));
  }
  return best.length === 0 ? [] : best.at(-1).indices.map((index) => ordered[index]);
}

function selectResetGroups(transitions) {
  const bySlotReset = new Map();
  for (const row of transitions.filter((item) => item.windowDurationMins === WEEKLY_WINDOW_MINS && item.limitId === "codex")) {
    const values = bySlotReset.get(slotResetKey(row)) ?? [];
    values.push(row);
    bySlotReset.set(slotResetKey(row), values);
  }
  const byLogicalReset = new Map();
  for (const rows of bySlotReset.values()) {
    const key = logicalResetKey(rows[0]);
    const values = byLogicalReset.get(key) ?? [];
    values.push(...rows);
    byLogicalReset.set(key, values);
  }
  const suppressed = [];
  const logicalGroups = [];
  for (const rows of byLogicalReset.values()) {
    const group = summarizeResetGroup(rows);
    if (hasSimultaneousSlotConflict(group.rows)) {
      suppressed.push({
        resetsAt: group.first.resetsAt,
        selectedResetsAt: null,
        partition: partitionKey(group.first, { includeSlot: false }),
        reason: "simultaneous_slot_conflict",
      });
      continue;
    }
    logicalGroups.push(group);
  }
  const byContinuityTrack = new Map();
  for (const group of logicalGroups) {
    const key = partitionKey(group.first, { includeSlot: false });
    const values = byContinuityTrack.get(key) ?? [];
    values.push(group);
    byContinuityTrack.set(key, values);
  }
  const selected = [];
  for (const groups of byContinuityTrack.values()) {
    groups.sort((left, right) => left.first.resetsAt - right.first.resetsAt);
    let cluster = [];
    const flush = () => {
      if (cluster.length === 0) return;
      cluster.sort(compareResetGroupStrength);
      selected.push(cluster[0]);
      for (const duplicate of cluster.slice(1)) suppressed.push({
        resetsAt: duplicate.first.resetsAt,
        selectedResetsAt: cluster[0].first.resetsAt,
        partition: partitionKey(duplicate.first, { includeSlot: false }),
        reason: "near_duplicate_reset_identity_with_less_evidence",
      });
      cluster = [];
    };
    for (const group of groups) {
      if (cluster.length > 0 && group.first.resetsAt - cluster.at(-1).first.resetsAt > 2) flush();
      cluster.push(group);
    }
    flush();
  }
  const nonOverlapping = [];
  const selectedByTrack = new Map();
  for (const group of selected) {
    const key = partitionKey(group.first, { includeSlot: false });
    const values = selectedByTrack.get(key) ?? [];
    values.push(group);
    selectedByTrack.set(key, values);
  }
  for (const groups of selectedByTrack.values()) {
    const retained = selectNonOverlappingGroups(groups);
    const retainedIds = new Set(retained);
    nonOverlapping.push(...retained);
    for (const group of groups) {
      if (retainedIds.has(group)) continue;
      const winner = retained.filter((candidate) => rangesOverlap(candidate.interval, group.interval))
        .sort(compareResetGroupStrength)[0] ?? null;
      suppressed.push({
        resetsAt: group.first.resetsAt,
        selectedResetsAt: winner?.first.resetsAt ?? null,
        partition: partitionKey(group.first, { includeSlot: false }),
        reason: "overlapping_observation_window",
      });
    }
  }
  nonOverlapping.sort((left, right) => left.rows[0].eventTime.localeCompare(right.rows[0].eventTime));
  return {
    selected: nonOverlapping,
    suppressed,
    exactGroupCount: bySlotReset.size,
    logicalGroupCount: logicalGroups.length,
  };
}

function speedCounts(rows) {
  const counts = {};
  for (const row of rows.filter(isEligible)) {
    for (const [speed, count] of Object.entries(row.tierUsageEventCounts ?? { unknown: row.marginalUsageEventCount })) {
      counts[speed] = (counts[speed] ?? 0) + count;
    }
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    knownFraction: total > 0 ? ((counts.standard ?? 0) + (counts.fast ?? 0)) / total : null,
    fastFractionOfKnown: (counts.standard ?? 0) + (counts.fast ?? 0) > 0
      ? (counts.fast ?? 0) / ((counts.standard ?? 0) + (counts.fast ?? 0))
      : null,
  };
}

function candidateSummary(candidate, resets) {
  const fits = resets.map((reset) => reset.fits[candidate.id]).filter(Boolean);
  const holdoutRows = fits.flatMap((fit) => fit.holdoutScore.rows);
  return {
    id: candidate.id,
    label: candidate.label,
    qualifyingResets: fits.length,
    holdoutPoints: holdoutRows.length,
    medianResetHoldoutMaePp: round(median(fits.map((fit) => fit.holdoutScore.meanAbsoluteErrorPp))),
    pooledHoldoutMaePp: round(mean(holdoutRows.map((row) => row.absoluteErrorPp))),
    pooledHoldoutBiasPp: round(mean(holdoutRows.map((row) => row.residualPp))),
    medianResetInSampleMaePp: round(median(fits.map((fit) => fit.inSampleScore.meanAbsoluteErrorPp))),
  };
}

export function analyzeWeeklyCalibration(
  dataset,
  { priorWindow = 3, forcedCandidateId = null } = {},
) {
  if (forcedCandidateId !== null
      && !CANDIDATES.some((candidate) => candidate.id === forcedCandidateId)) {
    throw new TypeError("Unknown forced weekly calibration candidate");
  }
  const grouped = selectResetGroups(dataset.transitions ?? []);
  const resetFits = grouped.selected.map((group) => {
    const first = group.first;
    const fits = Object.fromEntries(CANDIDATES.map((candidate) => [candidate.id, fitReset(group.rows, candidate)]));
    const lagFits = Object.fromEntries(LAG_CANDIDATES.map((candidate) => [candidate.id, fitReset(group.rows, candidate)]));
    return {
      accountScopeId: first.accountScopeId ?? "unattributed",
      provider: first.provider,
      planType: first.planType,
      limitId: first.limitId,
      slot: first.slot,
      windowDurationMins: first.windowDurationMins,
      resetsAt: first.resetsAt,
      resetIdentity: new Date(first.resetsAt * 1000).toISOString(),
      exactPartition: partitionKey(first),
      continuityTrack: partitionKey(first, { includeSlot: false }),
      totalTransitions: group.rows.length,
      eligibleTransitions: group.eligibleCount,
      speed: speedCounts(group.rows),
      evidenceProfile: summarizeEvidence(group.rows),
      ...priceCardProvenance(group.rows),
      fits,
      lagFits,
    };
  }).filter((reset) => Object.values(reset.fits).some(Boolean));

  const candidates = CANDIDATES.map((candidate) => candidateSummary(candidate, resetFits));
  const lagCandidates = LAG_CANDIDATES.map((candidate) => candidateSummary(candidate, resetFits.map((reset) => ({
    ...reset,
    fits: reset.lagFits,
  }))));
  const eligibleCandidates = candidates.filter((candidate) => candidate.qualifyingResets >= 3 && Number.isFinite(candidate.medianResetHoldoutMaePp));
  eligibleCandidates.sort((left, right) => left.medianResetHoldoutMaePp - right.medianResetHoldoutMaePp
    || left.pooledHoldoutMaePp - right.pooledHoldoutMaePp
    || CANDIDATES.findIndex((item) => item.id === left.id) - CANDIDATES.findIndex((item) => item.id === right.id));
  const selectedCandidate = forcedCandidateId === null
    ? eligibleCandidates[0]
      ?? candidates.find((candidate) => candidate.id === "standard_api")
    : candidates.find((candidate) => candidate.id === forcedCandidateId);
  const selectedId = selectedCandidate?.id ?? "standard_api";

  const rows = resetFits
    .filter((reset) => reset.fits[selectedId])
    .sort((left, right) => left.fits[selectedId].firstObservedAt.localeCompare(right.fits[selectedId].firstObservedAt))
    .map((reset) => {
      const fit = reset.fits[selectedId];
      return {
        ...reset,
        firstObservedAt: fit.firstObservedAt,
        lastObservedAt: fit.lastObservedAt,
        weekLabel: fit.firstObservedAt.slice(0, 10),
        selectedFit: fit,
        priorPrediction: null,
      };
    });

  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const prior = rows.slice(0, index)
      .filter((candidate) => candidate.continuityTrack === current.continuityTrack
        && candidate.lastObservedAt <= current.firstObservedAt)
      .slice(-priorWindow);
    if (prior.length < 2) continue;
    const forecastCapacityUsd = median(prior.map((candidate) => candidate.selectedFit.fullCapacityUsd));
    const points = current.selectedFit.points;
    const score = scoreFromAnchor(points.slice(1), forecastCapacityUsd, points[0]);
    current.priorPrediction = {
      priorResetCount: prior.length,
      priorResetIdentities: prior.map((candidate) => candidate.resetIdentity),
      forecastCapacityUsd: round(forecastCapacityUsd),
      ...score,
    };
  }

  const standard = candidates.find((candidate) => candidate.id === "standard_api");
  const comparableStandard = Number.isFinite(standard?.medianResetHoldoutMaePp) && standard.medianResetHoldoutMaePp > 0;
  const forecastModelSelection = evaluateForecastMethods(rows);
  const julyNineRegimeHypothesis = evaluateFixedBoundaryHypothesis(rows, "2026-07-09T00:00:00.000Z");
  const onlineCalibration = evaluateOnlineCalibration(rows);
  const eligibleLagCandidates = lagCandidates.filter((candidate) => candidate.qualifyingResets >= 3 && Number.isFinite(candidate.pooledHoldoutMaePp))
    .sort((left, right) => left.pooledHoldoutMaePp - right.pooledHoldoutMaePp
      || Math.abs(left.pooledHoldoutBiasPp) - Math.abs(right.pooledHoldoutBiasPp)
      || LAG_CANDIDATES.findIndex((candidate) => candidate.id === left.id) - LAG_CANDIDATES.findIndex((candidate) => candidate.id === right.id));
  const noDelayLag = lagCandidates.find((candidate) => candidate.id === "no_delay");
  const bestLag = eligibleLagCandidates[0] ?? noDelayLag;
  const lagImprovement = Number.isFinite(noDelayLag?.pooledHoldoutMaePp) && noDelayLag.pooledHoldoutMaePp > 0
    ? (noDelayLag.pooledHoldoutMaePp - bestLag.pooledHoldoutMaePp) / noDelayLag.pooledHoldoutMaePp
    : null;
  const priorPredictions = rows.map((row) => row.priorPrediction).filter(Boolean);
  const priorPredictionPoints = priorPredictions.flatMap((prediction) => prediction.rows);
  const capacityValues = rows.map((row) => row.selectedFit.fullCapacityUsd);
  const holdoutAbsoluteErrorPp = rows.reduce((sum, row) => sum
    + row.selectedFit.holdoutScore.rows.reduce((resetSum, point) => resetSum + point.absoluteErrorPp, 0), 0);
  const errorContributions = rows.map((row) => {
    const absoluteErrorPp = row.selectedFit.holdoutScore.rows.reduce((sum, point) => sum + point.absoluteErrorPp, 0);
    return {
      resetIdentity: row.resetIdentity,
      weekLabel: row.weekLabel,
      slot: row.slot,
      absoluteErrorPp: round(absoluteErrorPp),
      shareOfTotal: holdoutAbsoluteErrorPp > 0 ? round(absoluteErrorPp / holdoutAbsoluteErrorPp) : null,
      meanAbsoluteErrorPp: row.selectedFit.holdoutScore.meanAbsoluteErrorPp,
      signedBiasPp: row.selectedFit.holdoutScore.signedBiasPp,
      holdoutPoints: row.selectedFit.holdoutScore.pointCount,
      speedKnownFraction: row.speed.knownFraction,
      fastFractionOfKnown: row.speed.fastFractionOfKnown,
      evidenceProfile: row.evidenceProfile,
    };
  }).sort((left, right) => right.absoluteErrorPp - left.absoluteErrorPp);
  const observedBaseline = {
    qualifyingResets: rows.length,
    medianApiPriceEquivalentUsd: round(median(capacityValues)),
    sameResetHoldoutMaePp: selectedCandidate?.pooledHoldoutMaePp ?? null,
    sameResetHoldoutBiasPp: selectedCandidate?.pooledHoldoutBiasPp ?? null,
    priorResetMaePp: round(mean(priorPredictionPoints.map((point) => point.absoluteErrorPp))),
    priorResetBiasPp: round(mean(priorPredictionPoints.map((point) => point.residualPp))),
  };
  const referenceDataset = dataset.scope?.endAt === FROZEN_BASELINE.sourceEndAt;
  const baselineMatches = Object.entries(observedBaseline).every(([key, value]) => Number.isFinite(value)
    && Math.abs(value - FROZEN_BASELINE[key]) <= 1e-6);
  const prospectiveCoverage = aggregateCoverage(rows);
  const componentModelAssessment = {
    status: "pre_fit_rejected_insufficient_independent_evidence",
    proposedFeatureGroups: [
      "cached_input",
      "uncached_input",
      "output_and_reasoning",
      "model_family",
      "captured_fast",
    ],
    independentResetValues: rows.length,
    minimumResetsPerFeatureGroup: 5,
    minimumRequiredIndependentResets: 25,
    largestTwoResetErrorShare: errorContributions.length >= 2
      ? round(errorContributions[0].shareOfTotal + errorContributions[1].shareOfTotal)
      : null,
    coverage: prospectiveCoverage,
    testedLowDimensionalAlternative: {
      candidate: selectedId,
      improvementVersusStandardFraction: comparableStandard
        ? round((standard.pooledHoldoutMaePp - selectedCandidate.pooledHoldoutMaePp) / standard.pooledHoldoutMaePp)
        : null,
    },
    decision: "retain component ledgers and captured-speed candidate, but do not fit several component multipliers until independent reset and coverage gates pass",
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "weekly_quota_cost_calibration",
    materializedAt: dataset.scope?.endAt ?? dataset.materializedAt ?? new Date().toISOString(),
    source: {
      parserVersion: dataset.parserVersion,
      startAt: dataset.scope?.startAt ?? null,
      endAt: dataset.scope?.endAt ?? null,
      pricingBasis: dataset.pricing?.basis ?? null,
      snapshotIntervalsIncluded: dataset.scope?.snapshotIntervalsIncluded ?? null,
    },
    baselineReceipt: {
      reference: FROZEN_BASELINE,
      observed: observedBaseline,
      referenceDataset,
      matchesReference: referenceDataset && baselineMatches,
      status: referenceDataset ? (baselineMatches ? "reproduced" : "drift_detected") : "different_dataset",
    },
    selection: {
      selectedCandidateId: selectedId,
      selectedCandidateLabel: selectedCandidate?.label ?? selectedId,
      rule: forcedCandidateId === null
        ? "lowest median reset-level chronological holdout MAE; pooled MAE breaks ties"
        : "owner-selected allowance scenario fitted independently with the same reset and no-look-ahead machinery",
      forcedCandidateId,
      candidateMinimumResets: 3,
      candidateScores: candidates,
      standardBaselineImprovement: comparableStandard ? {
        medianResetAbsoluteMaePp: round(standard.medianResetHoldoutMaePp - selectedCandidate.medianResetHoldoutMaePp),
        medianResetRelativeFraction: round((standard.medianResetHoldoutMaePp - selectedCandidate.medianResetHoldoutMaePp) / standard.medianResetHoldoutMaePp),
        pooledAbsoluteMaePp: round(standard.pooledHoldoutMaePp - selectedCandidate.pooledHoldoutMaePp),
        pooledRelativeFraction: round((standard.pooledHoldoutMaePp - selectedCandidate.pooledHoldoutMaePp) / standard.pooledHoldoutMaePp),
      } : null,
    },
    weeklyValueSummary: capacityValues.length === 0 ? null : {
      resetCount: rows.length,
      medianApiPriceEquivalentUsd: round(median(capacityValues)),
      central80AcrossResetsUsd: {
        lower: round(quantile(capacityValues, 0.1)),
        upper: round(quantile(capacityValues, 0.9)),
      },
      minimumUsd: round(Math.min(...capacityValues)),
      maximumUsd: round(Math.max(...capacityValues)),
    },
    prospectiveStyleValidation: {
      method: `rolling median of up to the prior ${priorWindow} completed qualifying resets (minimum 2) in the same account/plan/provider/limit/window continuity track; slot changes retained as metadata`,
      scoredResets: priorPredictions.length,
      scoredPoints: priorPredictionPoints.length,
      pooledMeanAbsoluteErrorPp: round(mean(priorPredictionPoints.map((point) => point.absoluteErrorPp))),
      pooledSignedBiasPp: round(mean(priorPredictionPoints.map((point) => point.residualPp))),
      medianFinalResidualPp: round(median(priorPredictions.map((prediction) => prediction.finalResidualPp))),
      empiricalErrorEnvelope: priorPredictionPoints.length > 0 ? {
        central80SignedPp: {
          lower: round(quantile(priorPredictionPoints.map((point) => point.residualPp), 0.1)),
          upper: round(quantile(priorPredictionPoints.map((point) => point.residualPp), 0.9)),
        },
        p80AbsoluteErrorPp: round(quantile(priorPredictionPoints.map((point) => point.absoluteErrorPp), 0.8)),
        p90AbsoluteErrorPp: round(quantile(priorPredictionPoints.map((point) => point.absoluteErrorPp), 0.9)),
      } : null,
    },
    forecastModelSelection,
    regimeHypotheses: {
      julyNine2026: julyNineRegimeHypothesis,
      persistentShift: {
        candidateId: "regime_15pct_persistence_2",
        summary: forecastModelSelection.candidates.find((candidate) => candidate.id === "regime_15pct_persistence_2"),
        adopted: forecastModelSelection.selectedMethodId === "regime_15pct_persistence_2",
      },
    },
    onlineCalibration,
    displayLagSelection: {
      selectionRule: "lowest pooled chronological holdout MAE across identical Standard API-price resets; adopt delay only for positive improvement",
      selectedCandidateId: bestLag?.id ?? null,
      selectedCandidateLabel: bestLag?.label ?? null,
      adoptedDelay: bestLag?.id !== "no_delay" && lagImprovement > 0,
      improvementVersusNoDelayFraction: round(lagImprovement),
      candidates: lagCandidates,
    },
    errorConcentration: {
      totalAbsoluteHoldoutErrorPp: round(holdoutAbsoluteErrorPp),
      largestResetShare: errorContributions[0]?.shareOfTotal ?? null,
      topTwoCumulativeShare: errorContributions.length >= 2
        ? round(errorContributions[0].shareOfTotal + errorContributions[1].shareOfTotal)
        : errorContributions[0]?.shareOfTotal ?? null,
      resets: errorContributions,
    },
    componentModelAssessment,
    accuracyFloorAssessment: {
      status: "targets_not_met_historical_observability_floor",
      sameResetMaePp: selectedCandidate?.pooledHoldoutMaePp ?? null,
      sameResetTargetPp: 1.5,
      priorResetMaePp: observedBaseline.priorResetMaePp,
      priorResetTargetPp: 2.5,
      priorResetAbsoluteBiasPp: round(Math.abs(observedBaseline.priorResetBiasPp)),
      biasTargetPp: 0.5,
      p80AbsoluteForecastErrorPp: round(quantile(priorPredictionPoints.map((point) => point.absoluteErrorPp), 0.8)),
      newlyCompletedProspectiveResets: 0,
      requiredNewProspectiveResets: 3,
      blockers: [
        "whole-percentage provider quantization",
        "historical account and plan scope unavailable",
        "historical provider snapshot age unavailable",
        "unlogged shared-pool activity from ChatGPT Work, Workspace Agents, ChatGPT for Excel, Codex cloud, and other Codex devices unbounded",
        "no uncontaminated controlled experiment result",
      ],
    },
    resetValues: rows.map((row) => ({
      accountScopeId: row.accountScopeId,
      provider: row.provider,
      planType: row.planType,
      limitId: row.limitId,
      slot: row.slot,
      windowDurationMins: row.windowDurationMins,
      resetsAt: row.resetsAt,
      resetIdentity: row.resetIdentity,
      continuityTrack: row.continuityTrack,
      weekLabel: row.weekLabel,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      totalTransitions: row.totalTransitions,
      eligibleTransitions: row.eligibleTransitions,
      pointCount: row.selectedFit.pointCount,
      percentSpan: round(row.selectedFit.percentSpan),
      apiPriceEquivalentUsd: round(row.selectedFit.fullCapacityUsd),
      central80PairwiseUsd: {
        lower: round(row.selectedFit.central80Usd?.lower),
        upper: round(row.selectedFit.central80Usd?.upper),
      },
      chronologicalHoldout: {
        trainPointCount: row.selectedFit.trainPointCount,
        holdoutPointCount: row.selectedFit.holdoutPointCount,
        trainCapacityUsd: round(row.selectedFit.trainCapacityUsd),
        observedMovementPp: row.selectedFit.holdoutScore.observedMovementPp,
        predictedMovementPp: row.selectedFit.holdoutScore.predictedMovementPp,
        meanAbsoluteErrorPp: row.selectedFit.holdoutScore.meanAbsoluteErrorPp,
        signedBiasPp: row.selectedFit.holdoutScore.signedBiasPp,
      },
      inSampleMaePp: row.selectedFit.inSampleScore.meanAbsoluteErrorPp,
      priorPrediction: row.priorPrediction,
      selectedForecast: row.selectedForecast,
      onlineCheckpoints: row.onlineCheckpoints,
      speedEvidence: row.speed,
      evidenceProfile: row.evidenceProfile,
      candidateFits: Object.fromEntries(Object.entries(row.fits).map(([id, fit]) => [id, fit ? {
        apiPriceEquivalentUsd: round(fit.fullCapacityUsd),
        holdoutMaePp: fit.holdoutScore.meanAbsoluteErrorPp,
        holdoutBiasPp: fit.holdoutScore.signedBiasPp,
      } : null])),
      priceCardIds: row.priceCardIds ?? row.selectedFit.priceCardIds ?? [],
      priceCardBreakdown: row.priceCardBreakdown
        ?? row.selectedFit.priceCardBreakdown
        ?? [],
    })),
    quality: {
      exactResetGroups: grouped.exactGroupCount,
      selectedResetGroups: grouped.selected.length,
      duplicateResetGroupsSuppressed: grouped.suppressed.length,
      qualifyingResetValues: rows.length,
      displayGranularityPercentagePoints: 1,
      historicalAccountScopeKnown: rows.every((row) => row.accountScopeId !== "unattributed"),
      sharedSurfaceUsageBounded: false,
      prospectiveCoverage,
    },
    duplicateResetGroupsSuppressed: grouped.suppressed,
    interpretation: {
      resultType: "conditional_api_price_equivalent_behavioral_calibration",
      identifiedProviderAllowance: false,
      caveats: [
        "The provider exposes a whole-percentage display, not the absolute denominator or exact debit ledger.",
        "Historical local receipts do not bound concurrent ChatGPT Work, Workspace Agent, ChatGPT for Excel, Codex cloud, or other-device Codex activity. Ordinary Chat conversations and ordinary Chat Voice are excluded from this shared agentic pool by provider policy.",
        "Historical account scope is unattributed; slot changes are retained and only bridged in the continuity validation.",
        "The selected cost basis improves prediction only if its chronological holdout score beats the Standard API baseline; it does not reveal the provider's private rate card.",
        "Per-reset values are descriptive full-series fits. Prior-reset predictions are the no-look-ahead test of temporal stability.",
      ],
    },
  };
}

export const BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT = 64;

function safeSpeedEventCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteOrNull(value, { minimum = Number.NEGATIVE_INFINITY } = {}) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : null;
}

const COMPOSITION_STATUSES = new Set([
  "fitted",
  "fallback_blended",
  "insufficient_observations",
]);
const MAX_COMPOSITION_MODELS = 24;

// The composition-aware calibration (design:
// docs/design/composition-aware-expected-line.md): a per-model $/100pp
// vector fitted by NNLS in the quota-analysis kernel, carried on the summary
// so the expected line and the calibration card can price a cost mix per
// model instead of through one blended constant. The projection is defensive:
// a malformed block degrades to null rather than poisoning the summary, and
// a non-"fitted" status never carries a vector.
function projectComposition(composition) {
  if (!composition || typeof composition !== "object"
      || Array.isArray(composition)
      || !COMPOSITION_STATUSES.has(composition.status)) {
    return null;
  }
  const vectorEntries = Object.entries(composition.capacityUsdByModel ?? {})
    .slice(0, MAX_COMPOSITION_MODELS)
    .filter(([model]) => typeof model === "string" && model.length > 0
      && model.length <= 64)
    .map(([model, value]) => [
      model,
      value === null ? null : finiteOrNull(value, { minimum: 0 }),
    ]);
  const capacityUsdByModel = composition.status === "fitted"
      && vectorEntries.some(([, value]) => value !== null && value > 0)
    ? Object.fromEntries(vectorEntries)
    : null;
  return {
    status: capacityUsdByModel === null && composition.status === "fitted"
      ? "fallback_blended"
      : composition.status,
    grainHours: finiteOrNull(composition.grainHours, { minimum: 0 }),
    observationCount: Number.isSafeInteger(composition.observationCount)
      && composition.observationCount >= 0
      ? composition.observationCount
      : 0,
    capacityUsdByModel,
    modelCostShares: Object.fromEntries(
      Object.entries(composition.modelCostShares ?? {})
        .slice(0, MAX_COMPOSITION_MODELS)
        .filter(([model]) => typeof model === "string" && model.length > 0
          && model.length <= 64)
        .map(([model, value]) => [model, finiteOrNull(value, { minimum: 0 })]),
    ),
    r2: finiteOrNull(composition.r2),
    singleConstantUsd: finiteOrNull(
      composition.singleConstantUsd,
      { minimum: 0 },
    ),
    singleConstantR2: finiteOrNull(composition.singleConstantR2),
    blendedRecentMixUsd: finiteOrNull(
      composition.blendedRecentMixUsd,
      { minimum: 0 },
    ),
    recentMixDays: finiteOrNull(composition.recentMixDays, { minimum: 0 }),
  };
}

export function projectBoundedWeeklyCalibrationSummary(dataset, options = {}) {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)
      || (dataset.transitions !== undefined
        && !Array.isArray(dataset.transitions))) {
    throw new TypeError("Weekly calibration dataset is invalid");
  }
  const { composition = null, ...analysisOptions } = options;
  const report = analyzeWeeklyCalibration(dataset, analysisOptions);
  const value = report.weeklyValueSummary;
  const resets = report.resetValues
    .slice(-BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT)
    .map((row) => ({
      resetIdentity: row.resetIdentity,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      slot: row.slot,
      observedSpanPercentagePoints: row.percentSpan,
      apiPriceEquivalentUsd: row.apiPriceEquivalentUsd,
      plausibleRangeUsd: {
        lower: row.central80PairwiseUsd?.lower ?? null,
        upper: row.central80PairwiseUsd?.upper ?? null,
      },
      eligibleTransitions: row.eligibleTransitions,
      uniqueBoundaries: row.pointCount,
      knownSpeedFraction: row.speedEvidence?.knownFraction ?? null,
      // Retained so a consumer can separate windows whose observed speed
      // evidence is predominantly Standard from windows that are merely
      // well-covered. Older Codex versions are the only source of this
      // evidence, so both fractions decay toward null over time.
      fastFractionOfKnown: row.speedEvidence?.fastFractionOfKnown ?? null,
      speedEventCounts: {
        standard: safeSpeedEventCount(row.speedEvidence?.counts?.standard),
        fast: safeSpeedEventCount(row.speedEvidence?.counts?.fast),
        unknown: safeSpeedEventCount(row.speedEvidence?.counts?.unknown),
      },
      holdoutMeanAbsoluteErrorPercentagePoints:
        row.chronologicalHoldout?.meanAbsoluteErrorPp ?? null,
    }));
  return {
    schemaVersion: "weekly-calibration-summary-v0.1",
    status: value === null ? "insufficient_evidence" : "estimated",
    generatedAt: report.materializedAt,
    evidenceBasis:
      "lineage_aware_local_usage_and_provider_percentage_snapshots",
    interpretation:
      "conditional_api_price_equivalent_not_provider_allowance_or_bill",
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
      label: "Historical estimate; account-unattributed and may combine multiple accounts",
    },
    estimate: value === null
      ? null
      : {
        qualifyingResets: value.resetCount,
        medianApiPriceEquivalentUsd: value.medianApiPriceEquivalentUsd,
        plausibleRangeUsd: {
          lower: value.central80AcrossResetsUsd?.lower ?? null,
          upper: value.central80AcrossResetsUsd?.upper ?? null,
        },
        minimumUsd: value.minimumUsd,
        maximumUsd: value.maximumUsd,
      },
    validation: {
      selectedCostBasis: report.selection.selectedCandidateId,
      sameResetHoldoutMeanAbsoluteErrorPercentagePoints:
        report.accuracyFloorAssessment.sameResetMaePp,
      priorResetMeanAbsoluteErrorPercentagePoints:
        report.accuracyFloorAssessment.priorResetMaePp,
      priorResetAbsoluteBiasPercentagePoints:
        report.accuracyFloorAssessment.priorResetAbsoluteBiasPp,
      forecastErrorP80PercentagePoints:
        report.accuracyFloorAssessment.p80AbsoluteForecastErrorPp,
      scoredPriorResets:
        report.prospectiveStyleValidation.scoredResets,
      scoredPriorPoints:
        report.prospectiveStyleValidation.scoredPoints,
    },
    sourceCounts: {
      rateLimitSnapshots:
        Number.isSafeInteger(dataset.summary?.deduplicatedRateLimitSnapshots)
          ? dataset.summary.deduplicatedRateLimitSnapshots
          : 0,
      weeklyTransitions: (dataset.transitions ?? [])
        .filter((row) => row.windowDurationMins === WEEKLY_WINDOW_MINS)
        .length,
      qualifyingResetValues: report.quality.qualifyingResetValues,
    },
    // Optional composition-aware per-model calibration; null when the caller
    // supplied none (older caches simply omit the field).
    composition: projectComposition(composition),
    recentResets: resets,
    limitations: [
      "Provider percentages are whole-number observations, not an exact debit ledger.",
      "Historical local logs do not safely identify which account was active.",
      "Unobserved shared-pool activity and provider-side accounting changes remain possible.",
    ],
  };
}

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "unavailable";
}

export function renderWeeklyCalibrationReport(report) {
  const rows = report.resetValues.map((row) => `| ${row.weekLabel} | ${row.slot} | ${row.percentSpan}% | ${money(row.apiPriceEquivalentUsd)} | ${money(row.central80PairwiseUsd.lower)}–${money(row.central80PairwiseUsd.upper)} | ${row.chronologicalHoldout.meanAbsoluteErrorPp.toFixed(2)} pp | ${row.priorPrediction ? `${row.priorPrediction.meanAbsoluteErrorPp.toFixed(2)} pp` : "not enough prior resets"} | ${row.speedEvidence.knownFraction === null ? "unknown" : `${(100 * row.speedEvidence.knownFraction).toFixed(1)}%`} |`);
  const summary = report.weeklyValueSummary;
  const latest = report.resetValues.at(-1);
  const forecastError = report.prospectiveStyleValidation;
  const topErrors = report.errorConcentration?.resets?.slice(0, 5) ?? [];
  const coverage = report.quality.prospectiveCoverage;
  const online = report.onlineCalibration;
  return [
    "---",
    "title: Seven-Day Quota Cost Calibration",
    `date: ${report.materializedAt.slice(0, 10)}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# Seven-Day Quota Cost Calibration",
    "",
    "## Current practical answer",
    "",
    summary ? `The best current ballpark is **${money(summary.medianApiPriceEquivalentUsd)} of Standard-API-price-equivalent work for 100% of the seven-day display**. Reset-to-reset values have varied from ${money(summary.minimumUsd)} to ${money(summary.maximumUsd)}; the middle 80% are ${money(summary.central80AcrossResetsUsd.lower)}–${money(summary.central80AcrossResetsUsd.upper)}.` : "There is not yet enough evidence for a seven-day value.",
    "",
    `A forecast made only from earlier completed resets has historically missed subsequent displayed readings by **${forecastError.pooledMeanAbsoluteErrorPp?.toFixed(2) ?? "an unknown number of"} percentage points on average**. Eighty percent of individual historical prediction errors were no larger than ${forecastError.empiricalErrorEnvelope?.p80AbsoluteErrorPp?.toFixed(2) ?? "an unavailable number of"} points.`,
    "",
    latest?.selectedForecast ? `For the latest retained reset, the start-of-reset forecast was **${money(latest.selectedForecast.forecastCapacityUsd)}** using ${latest.selectedForecast.methodLabel.toLowerCase()}.` : "The latest retained reset did not have two earlier comparable resets for a start-of-reset forecast.",
    "",
    online.selectionStatus === "acceptance_target_met"
      ? `An in-reset update is accepted after ${online.selectedRequestedDisplaySpanPp} displayed points; its later-period error is ${online.candidates.find((candidate) => candidate.id === online.selectedCheckpointId)?.comparison.pooledMaePp.toFixed(2)} points.`
      : `**Do not replace the prior-reset forecast with an early in-reset fit yet.** The tested updates did not meet the accuracy target (${online.selectionStatus.replaceAll("_", " ")}); the least-bad diagnostic checkpoint was ${online.diagnosticBestCheckpointId ?? "unavailable"} at ${online.diagnosticBestPooledMaePp?.toFixed(2) ?? "unavailable"} points MAE.`,
    "",
    `Selected accounting basis: **${report.selection.selectedCandidateLabel}** by chronological holdout error. ${report.selection.standardBaselineImprovement ? `Pooled holdout MAE improves by ${(100 * report.selection.standardBaselineImprovement.pooledRelativeFraction).toFixed(1)}% versus the Standard API baseline.` : "No valid baseline improvement is available."}`,
    "",
    summary ? `${summary.resetCount} qualifying seven-day reset windows imply a median **${money(summary.medianApiPriceEquivalentUsd)}** API-price-equivalent value, with a central 80% reset-to-reset range of ${money(summary.central80AcrossResetsUsd.lower)}–${money(summary.central80AcrossResetsUsd.upper)}.` : "No reset met the calibration thresholds.",
    "",
    "This is a conditional behavioral conversion of local API-priced activity into displayed quota percentage. It is not an identified provider allowance, invoice value, or Codex credit rate card.",
    "",
    "## Week-by-week reset values",
    "",
    "| First observed | Slot | Display span | API-price-equivalent value | Within-reset sensitivity range | Later-30% MAE | Prior-reset MAE | Speed known |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Validation",
    "",
    `The model-selection score uses the earlier 70% of each reset to predict the later 30%. The prospective-style check uses only earlier completed resets and scores ${report.prospectiveStyleValidation.scoredResets} later resets, with mean MAE ${report.prospectiveStyleValidation.pooledMeanAbsoluteErrorPp ?? "unavailable"} pp.`,
    "",
    `Display delay was tested at no delay, one event, 5 seconds, 30 seconds, and 60 seconds. **${report.displayLagSelection.selectedCandidateLabel}** had the lowest comparable error, so a delay adjustment is ${report.displayLagSelection.adoptedDelay ? "adopted" : "not adopted"}.`,
    "",
    `The fixed July 9 regime hypothesis is **${report.regimeHypotheses.julyNine2026.status.replaceAll("_", " ")}** and ${report.regimeHypotheses.julyNine2026.adopted ? "improved" : "did not improve"} the rolling-three forecast on the same later resets. The persistent-shift rule is ${report.regimeHypotheses.persistentShift.adopted ? "selected" : "not selected"}.`,
    "",
    "## Where the remaining error comes from",
    "",
    `The two highest-error resets account for ${report.errorConcentration?.topTwoCumulativeShare === null ? "an unavailable share" : `${(100 * report.errorConcentration.topTwoCumulativeShare).toFixed(1)}%`} of all later-period absolute error. This concentration is why adding many parameters would currently be easy to overfit.`,
    "",
    "| Reset first seen | Share of error | Reset MAE | Bias | Speed known |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...topErrors.map((row) => `| ${row.weekLabel} | ${(100 * row.shareOfTotal).toFixed(1)}% | ${row.meanAbsoluteErrorPp.toFixed(2)} pp | ${row.signedBiasPp.toFixed(2)} pp | ${row.speedKnownFraction === null ? "unknown" : `${(100 * row.speedKnownFraction).toFixed(1)}%`} |`),
    "",
    "## Evidence coverage",
    "",
    "| Field | Historical coverage | Study target |",
    "| --- | ---: | ---: |",
    `| Account scope | ${(100 * (coverage.accountKnownFraction ?? 0)).toFixed(1)}% | 90% |`,
    `| Standard/Fast state | ${(100 * (coverage.speedKnownEventFraction ?? 0)).toFixed(1)}% | 90% |`,
    `| Provider snapshot age | ${(100 * (coverage.providerSnapshotAgeKnownFraction ?? 0)).toFixed(1)}% | 90% |`,
    "",
    "The historical window predates reliable account and snapshot-age markers, so those targets are prospective. Privacy-safe activity markers distinguish ordinary Chat from the shared agentic surfaces: Work, Workspace Agents, ChatGPT for Excel, Codex Cloud, other-device Codex, Work Voice task activity, quiet periods, and controlled experiments. Ordinary Chat and ordinary Chat Voice are excluded from this pool.",
    "",
    "## Technical note on the sensitivity range",
    "",
    "The within-reset range is the 10th-to-90th-percentile spread of slopes formed from different pairs of observed quota boundaries. It is a disagreement diagnostic, not a confidence interval; the default conclusion above uses prediction errors on later observations instead.",
    "",
    "## Measurement boundary",
    "",
    ...report.interpretation.caveats.map((caveat) => `- ${caveat}`),
    "",
  ].join("\n");
}

export { CANDIDATES };
