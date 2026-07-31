const MINIMUM_BOUNDARIES = 8;
const MINIMUM_SPAN_PP = 5;
const MINIMUM_TRAIN_BOUNDARIES = 5;
const MINIMUM_HOLDOUT_BOUNDARIES = 2;
const MAXIMUM_RELATIVE_SENSITIVITY_WIDTH = 1;
const MINIMUM_PRIOR_RESETS = 2;
const MAXIMUM_PRIOR_RESETS = 3;
const MINIMUM_RESETS_FOR_UNCERTAINTY = 3;
const MINIMUM_SCORED_RESETS_FOR_EMPIRICAL_ERROR = 3;

const EVIDENCE_KEYS = [
  "schemaVersion",
  "status",
  "refusalCodes",
  "continuityKey",
  "resetKey",
  "accountTrackId",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "windowDurationMinutes",
  "policyEpoch",
  "resetsAt",
  "slots",
  "firstObservedAt",
  "lastObservedAt",
  "snapshotCount",
  "usageEventCount",
  "totalCostNanousd",
  "sourceDatasetCount",
  "boundaries",
  "quotaSeries",
  "usageSeries",
];
const BOUNDARY_KEYS = [
  "usedPercent",
  "lowerCostNanousd",
  "upperCostNanousd",
  "observedAt",
];

const CALIBRATION_REFUSAL_ORDER = [
  "source_evidence_refused",
  "too_few_boundaries",
  "insufficient_displayed_span",
  "insufficient_training_boundaries",
  "insufficient_holdout_boundaries",
  "capacity_not_estimable",
  "sensitivity_too_wide",
];

function invalidInput() {
  throw new TypeError("quota_calibration_invalid_input");
}

function plainExact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidInput();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalidInput();
  }
}

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
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}

function median(values) {
  return quantile(values, 0.5);
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0
    ? null
    : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function validateEvidence(row) {
  plainExact(row, EVIDENCE_KEYS);
  if (row.schemaVersion !== "quota-reset-evidence-v0.1"
      || !["eligible", "refused"].includes(row.status)
      || !Array.isArray(row.refusalCodes)
      || !Array.isArray(row.boundaries)
      || !Array.isArray(row.quotaSeries)
      || !Array.isArray(row.usageSeries)
      || ![300, 10_080].includes(row.windowDurationMinutes)
      || !Number.isFinite(Date.parse(row.firstObservedAt))
      || !Number.isFinite(Date.parse(row.lastObservedAt))) invalidInput();
  const boundaries = row.boundaries.map((point) => {
    plainExact(point, BOUNDARY_KEYS);
    if (!Number.isFinite(point.usedPercent)
        || !Number.isSafeInteger(point.lowerCostNanousd)
        || !Number.isSafeInteger(point.upperCostNanousd)
        || point.lowerCostNanousd < 0
        || point.upperCostNanousd < point.lowerCostNanousd
        || !Number.isFinite(Date.parse(point.observedAt))) invalidInput();
    return { ...point };
  });
  return { ...row, boundaries };
}

function midpoint(point) {
  return (point.lowerCostNanousd + point.upperCostNanousd) / 2;
}

function capacityCandidates(points) {
  const values = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const percentDelta = points[right].usedPercent - points[left].usedPercent;
      const costDelta = midpoint(points[right]) - midpoint(points[left]);
      if (percentDelta > 0 && costDelta > 0) values.push(100 * costDelta / percentDelta);
    }
  }
  return values;
}

function fitPoints(points) {
  const candidates = capacityCandidates(points);
  const capacityNanousd = median(candidates);
  if (!(capacityNanousd > 0)) return null;
  const lower = quantile(candidates, 0.1);
  const upper = quantile(candidates, 0.9);
  return {
    capacityNanousd,
    sensitivityRangeNanousd: {
      lower,
      upper,
    },
    boundaryCombinationCount: candidates.length,
    relativeSensitivityWidth: (upper - lower) / capacityNanousd,
  };
}

function scorePoints(points, capacityNanousd, anchor) {
  if (!(capacityNanousd > 0) || points.length === 0) return null;
  const anchorCost = midpoint(anchor);
  const rows = points.map((point) => {
    const observedMovementPp = point.usedPercent - anchor.usedPercent;
    const predictedMovementPp = 100 * (midpoint(point) - anchorCost) / capacityNanousd;
    const differencePp = predictedMovementPp - observedMovementPp;
    return {
      observedAt: point.observedAt,
      observedMovementPp: round(observedMovementPp),
      predictedMovementPp: round(predictedMovementPp),
      differencePp: round(differencePp),
      absoluteErrorPp: round(Math.abs(differencePp)),
    };
  });
  return {
    pointCount: rows.length,
    meanAbsoluteErrorPp: round(mean(rows.map((row) => row.absoluteErrorPp))),
    signedBiasPp: round(mean(rows.map((row) => row.differencePp))),
    finalDifferencePp: rows.at(-1).differencePp,
    rows,
  };
}

function splitPoints(points) {
  if (points.length === 0) return { training: [], holdout: [] };
  const firstPercent = points[0].usedPercent;
  const span = points.at(-1).usedPercent - firstPercent;
  const cutoff = firstPercent + span * 0.7;
  let training = points.filter((point) => point.usedPercent <= cutoff);
  let holdout = points.filter((point) => point.usedPercent > cutoff);
  if (training.length < MINIMUM_TRAIN_BOUNDARIES
      || holdout.length < MINIMUM_HOLDOUT_BOUNDARIES) {
    const split = Math.max(
      MINIMUM_TRAIN_BOUNDARIES,
      Math.min(
        points.length - MINIMUM_HOLDOUT_BOUNDARIES,
        Math.floor(points.length * 0.7),
      ),
    );
    training = points.slice(0, split);
    holdout = points.slice(split);
  }
  return { training, holdout };
}

function orderedRefusals(values) {
  const unique = new Set(values);
  return CALIBRATION_REFUSAL_ORDER.filter((code) => unique.has(code));
}

export function fitResetCapacity(input) {
  const evidence = validateEvidence(input);
  const refusals = [];
  if (evidence.status !== "eligible") refusals.push("source_evidence_refused");
  const points = [...evidence.boundaries].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.usedPercent - right.usedPercent
  ));
  const spanPp = points.length > 0
    ? points.at(-1).usedPercent - points[0].usedPercent
    : 0;
  if (points.length < MINIMUM_BOUNDARIES) refusals.push("too_few_boundaries");
  if (spanPp < MINIMUM_SPAN_PP) refusals.push("insufficient_displayed_span");
  const { training, holdout } = splitPoints(points);
  if (training.length < MINIMUM_TRAIN_BOUNDARIES) {
    refusals.push("insufficient_training_boundaries");
  }
  if (holdout.length < MINIMUM_HOLDOUT_BOUNDARIES) {
    refusals.push("insufficient_holdout_boundaries");
  }

  const trainingFit = refusals.length === 0 ? fitPoints(training) : null;
  if (refusals.length === 0 && !trainingFit) {
    refusals.push("capacity_not_estimable");
  }
  if (trainingFit?.relativeSensitivityWidth > MAXIMUM_RELATIVE_SENSITIVITY_WIDTH) {
    refusals.push("sensitivity_too_wide");
  }
  const refusalCodes = orderedRefusals(refusals);
  const eligible = refusalCodes.length === 0;
  const holdoutScore = eligible
    ? scorePoints(holdout, trainingFit.capacityNanousd, training.at(-1))
    : null;
  return {
    schemaVersion: "quota-reset-calibration-v0.1",
    status: eligible ? "conditional_estimate" : "not_testable",
    refusalCodes,
    continuityKey: evidence.continuityKey,
    resetKey: evidence.resetKey,
    accountTrackId: evidence.accountTrackId,
    provider: evidence.provider,
    planType: evidence.planType,
    planVariant: evidence.planVariant,
    limitId: evidence.limitId,
    windowDurationMinutes: evidence.windowDurationMinutes,
    policyEpoch: evidence.policyEpoch,
    resetsAt: evidence.resetsAt,
    firstObservedAt: evidence.firstObservedAt,
    lastObservedAt: evidence.lastObservedAt,
    boundaryCount: points.length,
    displayedSpanPp: round(spanPp),
    capacityNanousd: eligible ? round(trainingFit.capacityNanousd) : null,
    sensitivityRangeNanousd: eligible ? {
      lower: round(trainingFit.sensitivityRangeNanousd.lower),
      upper: round(trainingFit.sensitivityRangeNanousd.upper),
    } : null,
    relativeSensitivityWidth: eligible
      ? round(trainingFit.relativeSensitivityWidth)
      : null,
    training: eligible ? {
      boundaryCount: training.length,
      displayedSpanPp: round(training.at(-1).usedPercent - training[0].usedPercent),
      capacityNanousd: round(trainingFit.capacityNanousd),
    } : null,
    holdout: eligible ? {
      boundaryCount: holdout.length,
      ...holdoutScore,
    } : null,
    priorForecast: null,
  };
}

export function forecastCapacityFromPriorResets(priorResetFits, currentResetFit) {
  if (!Array.isArray(priorResetFits)
      || !currentResetFit
      || typeof currentResetFit !== "object") invalidInput();
  const prior = priorResetFits
    .filter((row) => (
      row?.schemaVersion === "quota-reset-calibration-v0.1"
      && row.status === "conditional_estimate"
      && row.continuityKey === currentResetFit.continuityKey
      && row.lastObservedAt <= currentResetFit.firstObservedAt
      && Number.isFinite(row.capacityNanousd)
      && row.capacityNanousd > 0
    ))
    .sort((left, right) => (
      left.lastObservedAt.localeCompare(right.lastObservedAt)
      || left.resetKey.localeCompare(right.resetKey)
    ))
    .slice(-MAXIMUM_PRIOR_RESETS);
  if (prior.length < MINIMUM_PRIOR_RESETS) return null;
  return {
    method: "median_of_prior_completed_resets",
    priorResetCount: prior.length,
    priorResetKeys: prior.map((row) => row.resetKey),
    trainedThrough: prior.at(-1).lastObservedAt,
    capacityNanousd: round(median(prior.map((row) => row.capacityNanousd))),
  };
}

function scorePriorForecast(evidence, forecast) {
  if (!forecast || evidence.boundaries.length < 2) return null;
  const points = [...evidence.boundaries].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.usedPercent - right.usedPercent
  ));
  return scorePoints(points.slice(1), forecast.capacityNanousd, points[0]);
}

function summarizeTrack(resetFits) {
  const estimates = resetFits.filter((row) => row.status === "conditional_estimate");
  const capacities = estimates.map((row) => row.capacityNanousd);
  const scoredForecasts = estimates.filter((row) => row.priorForecast?.score);
  const forecastRows = scoredForecasts.flatMap((row) => row.priorForecast.score.rows);
  const enoughResetUncertainty = estimates.length >= MINIMUM_RESETS_FOR_UNCERTAINTY;
  const enoughForecastEvidence =
    scoredForecasts.length >= MINIMUM_SCORED_RESETS_FOR_EMPIRICAL_ERROR;
  return {
    continuityKey: resetFits[0].continuityKey,
    accountTrackId: resetFits[0].accountTrackId,
    provider: resetFits[0].provider,
    planType: resetFits[0].planType,
    planVariant: resetFits[0].planVariant,
    limitId: resetFits[0].limitId,
    windowDurationMinutes: resetFits[0].windowDurationMinutes,
    policyEpoch: resetFits[0].policyEpoch,
    totalResetCount: resetFits.length,
    estimatedResetCount: estimates.length,
    medianCapacityNanousd: capacities.length > 0 ? round(median(capacities)) : null,
    acrossResetSensitivityRangeNanousd: enoughResetUncertainty ? {
      lower: round(quantile(capacities, 0.1)),
      upper: round(quantile(capacities, 0.9)),
    } : null,
    empiricalForecastError: enoughForecastEvidence ? {
      scoredResetCount: scoredForecasts.length,
      scoredPointCount: forecastRows.length,
      meanAbsoluteErrorPp: round(mean(forecastRows.map((row) => row.absoluteErrorPp))),
      signedBiasPp: round(mean(forecastRows.map((row) => row.differencePp))),
      central80SignedPp: {
        lower: round(quantile(forecastRows.map((row) => row.differencePp), 0.1)),
        upper: round(quantile(forecastRows.map((row) => row.differencePp), 0.9)),
      },
      p80AbsoluteErrorPp: round(
        quantile(forecastRows.map((row) => row.absoluteErrorPp), 0.8),
      ),
      p90AbsoluteErrorPp: round(
        quantile(forecastRows.map((row) => row.absoluteErrorPp), 0.9),
      ),
    } : null,
    resets: resetFits,
  };
}

export function analyzeQuotaCalibration(input) {
  plainExact(input, ["schemaVersion", "resetCount", "resets"]);
  if (input.schemaVersion !== "quota-track-evidence-v0.1"
      || !Number.isSafeInteger(input.resetCount)
      || !Array.isArray(input.resets)
      || input.resetCount !== input.resets.length) invalidInput();
  const evidence = input.resets.map(validateEvidence).sort((left, right) => (
    left.firstObservedAt.localeCompare(right.firstObservedAt)
    || left.resetKey.localeCompare(right.resetKey)
  ));
  const fits = [];
  for (const currentEvidence of evidence) {
    const current = fitResetCapacity(currentEvidence);
    const forecast = forecastCapacityFromPriorResets(fits, current);
    if (forecast && current.status === "conditional_estimate") {
      current.priorForecast = {
        ...forecast,
        score: scorePriorForecast(currentEvidence, forecast),
      };
    }
    fits.push(current);
  }
  const grouped = new Map();
  for (const fit of fits) {
    const values = grouped.get(fit.continuityKey) ?? [];
    values.push(fit);
    grouped.set(fit.continuityKey, values);
  }
  const tracks = [...grouped.values()]
    .map(summarizeTrack)
    .sort((left, right) => left.continuityKey.localeCompare(right.continuityKey));
  return {
    schemaVersion: "quota-calibration-v0.1",
    trackCount: tracks.length,
    tracks,
  };
}

export const QUOTA_CALIBRATION_POLICY = Object.freeze({
  minimumBoundaries: MINIMUM_BOUNDARIES,
  minimumDisplayedSpanPp: MINIMUM_SPAN_PP,
  minimumTrainingBoundaries: MINIMUM_TRAIN_BOUNDARIES,
  minimumHoldoutBoundaries: MINIMUM_HOLDOUT_BOUNDARIES,
  maximumRelativeSensitivityWidth: MAXIMUM_RELATIVE_SENSITIVITY_WIDTH,
  minimumPriorResets: MINIMUM_PRIOR_RESETS,
  maximumPriorResets: MAXIMUM_PRIOR_RESETS,
  minimumResetsForUncertainty: MINIMUM_RESETS_FOR_UNCERTAINTY,
  minimumScoredResetsForEmpiricalError: MINIMUM_SCORED_RESETS_FOR_EMPIRICAL_ERROR,
});
