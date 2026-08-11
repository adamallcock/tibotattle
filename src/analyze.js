function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function ordinaryLeastSquares(points) {
  if (points.length < 2) return null;
  const meanX = mean(points.map((point) => point.x));
  const meanY = mean(points.map((point) => point.y));
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) return null;
  const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = points.map((point) => point.y - (intercept + slope * point.x));
  const ssResidual = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const ssTotal = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  return {
    slope,
    intercept,
    capacityUsd: slope > 0 ? 100 / slope : null,
    rSquared: ssTotal === 0 ? null : 1 - ssResidual / ssTotal,
    rmsePercent: Math.sqrt(ssResidual / points.length),
  };
}

export function roundedPercentageCapacityInterval(points) {
  if (points.length < 2 || new Set(points.map((point) => point.x)).size < 2) {
    return {
      feasible: false,
      assumption: "Each displayed integer percentage represents a one-percentage-point interval",
      capacityUsd: null,
    };
  }
  let lowerSlope = 0;
  let upperSlope = Number.POSITIVE_INFINITY;
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const left = points[leftIndex];
      const right = points[rightIndex];
      const deltaX = right.x - left.x;
      if (deltaX <= 0) continue;
      const deltaY = right.y - left.y;
      lowerSlope = Math.max(lowerSlope, (deltaY - 1) / deltaX);
      upperSlope = Math.min(upperSlope, (deltaY + 1) / deltaX);
    }
  }
  lowerSlope = Math.max(0, lowerSlope);
  const feasible = lowerSlope <= upperSlope && upperSlope > 0;
  return {
    feasible,
    assumption: "Each displayed integer percentage represents a one-percentage-point interval",
    capacityUsd: feasible
      ? {
          min: Number.isFinite(upperSlope) ? 100 / upperSlope : null,
          max: lowerSlope > 0 ? 100 / lowerSlope : null,
        }
      : null,
  };
}

function holdoutDiagnostics(points) {
  if (points.length < 6) return null;
  const trainCount = Math.max(4, Math.floor(points.length * 0.8));
  const train = points.slice(0, trainCount);
  const holdout = points.slice(trainCount);
  const fit = ordinaryLeastSquares(train);
  if (!fit || fit.slope <= 0 || holdout.length === 0) return null;
  const errors = holdout.map((point) => Math.abs(point.y - (fit.intercept + fit.slope * point.x)));
  return {
    trainCount,
    holdoutCount: holdout.length,
    meanAbsoluteErrorPercent: mean(errors),
    maxAbsoluteErrorPercent: Math.max(...errors),
  };
}

function originAlignedEstimate(points) {
  const point = [...points].reverse().find((candidate) => candidate.x > 0 && candidate.y > 0);
  if (!point) return null;
  const lowerPercent = Math.max(0.000001, point.y - 0.5);
  const upperPercent = point.y + 0.5;
  return {
    capturedAt: point.capturedAt,
    capacityUsd: point.x * 100 / point.y,
    roundingIntervalUsd: {
      min: point.x * 100 / upperPercent,
      max: point.x * 100 / lowerPercent,
    },
    assumption: "Local cumulative cost is complete and starts at zero at the provider-reported window boundary",
  };
}

export function analyzeSeries(points, { originAligned = false } = {}) {
  const sorted = [...points].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  const fit = ordinaryLeastSquares(sorted);
  const usedSpan = sorted.length ? Math.max(...sorted.map((point) => point.y)) - Math.min(...sorted.map((point) => point.y)) : 0;
  const costSpan = sorted.length ? Math.max(...sorted.map((point) => point.x)) - Math.min(...sorted.map((point) => point.x)) : 0;
  let decreasingUsageSteps = 0;
  let decreasingCostSteps = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].y < sorted[index - 1].y) decreasingUsageSteps += 1;
    if (sorted[index].x < sorted[index - 1].x) decreasingCostSteps += 1;
  }
  const warnings = [];
  if (sorted.length < 20) warnings.push("fewer_than_20_observations");
  if (usedSpan < 5) warnings.push("quota_span_below_5_percent");
  if (decreasingUsageSteps > 0) warnings.push("used_percentage_decreased_within_reset_identity");
  if (decreasingCostSteps > 0) warnings.push("local_cumulative_cost_decreased_within_reset_identity");
  if (!fit || fit.slope <= 0) warnings.push("regression_capacity_not_identified");
  if (sorted.filter((point) => point.controlled).length < 8) warnings.push("fewer_than_8_controlled_observations");
  warnings.push("legacy_snapshot_report_is_diagnostic_use_transitions_and_infer");
  const roundedInterval = roundedPercentageCapacityInterval(sorted);

  return {
    observations: sorted.length,
    controlledObservations: sorted.filter((point) => point.controlled).length,
    usedPercentSpan: usedSpan,
    costUsdSpan: costSpan,
    fit: null,
    originAlignedEstimate: null,
    roundedInterval: { ...roundedInterval, capacityUsd: null },
    holdout: null,
    diagnosticsSuppressed: fit !== null || (originAligned && originAlignedEstimate(sorted) !== null),
    warnings: [...new Set(warnings)],
    identifiability: {
      verdict: "non_identifiable",
      failures: [...new Set(warnings)],
      reportedCapacityUsd: null,
      boundary: "This snapshot summary never reports a capacity; use the interval-censored transitions and infer commands.",
    },
  };
}

export function analyzeObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    if (observation.kind !== "codex_quota_observation") continue;
    const accountScopeId = observation.accountScope?.status === "available" && typeof observation.accountScope.scopeId === "string"
      ? observation.accountScope.scopeId
      : "unattributed";
    const planVariant = typeof observation.planVariant === "string" ? observation.planVariant : "unknown";
    for (const window of observation.windows ?? []) {
      // Recompute the partition from the window's own fields instead of the
      // stored identity string: older captures embedded the provider's UI
      // slot in `identity`, and the weekly window flipped secondary ->
      // primary around 2026-07-06. Identity is (limit, duration, resetsAt).
      const partitionKey = [
        accountScopeId,
        planVariant,
        window.limitId,
        window.windowDurationMins,
        window.resetsAt,
      ].join("|");
      const group = groups.get(partitionKey) ?? {
        identity: window.identity,
        accountScopeId,
        planVariant,
        limitId: window.limitId,
        slot: window.slot,
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
        apiPricing: [],
        ccusage: [],
        apiPricingIncomplete: false,
      };
      const common = {
        capturedAt: observation.capturedAt,
        y: window.usedPercent,
        controlled: observation.controlled === true,
      };
      const apiPricing = window.local?.apiPricing ?? window.local?.runcost;
      if (Number.isFinite(apiPricing?.totalUsd)) {
        group.apiPricing.push({ ...common, x: apiPricing.totalUsd });
        group.apiPricingIncomplete ||= Object.keys(apiPricing.warningCounts ?? {}).length > 0;
      }
      if (Number.isFinite(window.local?.ccusage?.totals?.costUsd)) {
        group.ccusage.push({ ...common, x: window.local.ccusage.totals.costUsd });
      }
      groups.set(partitionKey, group);
    }
  }
  return [...groups.values()].map((group) => {
    const controlledApiPricing = group.apiPricing.filter((point) => point.controlled);
    const controlledCcusage = group.ccusage.filter((point) => point.controlled);
    const apiPricing = analyzeSeries(controlledApiPricing.length >= 2 ? controlledApiPricing : group.apiPricing, { originAligned: true });
    if (group.apiPricingIncomplete) apiPricing.warnings.push("api_pricing_incomplete_or_unknown_model");
    apiPricing.warnings.push("local_log_coverage_not_proven_complete");
    apiPricing.warnings = [...new Set(apiPricing.warnings)];
    apiPricing.identifiability.failures = [...apiPricing.warnings];
    return {
      identity: group.identity,
      accountScopeId: group.accountScopeId,
      planVariant: group.planVariant,
      limitId: group.limitId,
      slot: group.slot,
      windowDurationMins: group.windowDurationMins,
      resetsAt: group.resetsAt,
      apiPricing,
      ccusage: analyzeSeries(controlledCcusage.length >= 2 ? controlledCcusage : group.ccusage),
    };
  });
}
