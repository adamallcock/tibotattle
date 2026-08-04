import { isSupportedQuotaWindowDuration } from "./quota-windows.js";

const ROLLING_HOURS = Object.freeze([1, 2, 3]);
const MAXIMUM_ENDPOINT_BRACKET_MS = 5 * 60_000;

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
const FORECAST_KEYS = [
  "method",
  "priorResetCount",
  "priorResetKeys",
  "trainedThrough",
  "capacityNanousd",
];
const QUOTA_POINT_KEYS = ["observedAt", "receivedAt", "usedPercent"];
const USAGE_POINT_KEYS = ["observedAt", "costNanousd"];

function invalidInput() {
  throw new TypeError("quota_rolling_invalid_input");
}

function plainExact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidInput();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalidInput();
  }
}

function validInstant(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateEvidence(value) {
  plainExact(value, EVIDENCE_KEYS);
  if (value.schemaVersion !== "quota-reset-evidence-v0.1"
      || !["eligible", "refused"].includes(value.status)
      || !Array.isArray(value.refusalCodes)
      || !Array.isArray(value.boundaries)
      || !Array.isArray(value.slots)
      || !isSupportedQuotaWindowDuration(value.windowDurationMinutes)
      || !validInstant(value.resetsAt)
      || !validInstant(value.firstObservedAt)
      || !validInstant(value.lastObservedAt)
      || !Array.isArray(value.quotaSeries)
      || !Array.isArray(value.usageSeries)) invalidInput();
  const quotaSeries = value.quotaSeries.map((row) => {
    plainExact(row, QUOTA_POINT_KEYS);
    if (!validInstant(row.observedAt)
        || !validInstant(row.receivedAt)
        || !Number.isFinite(row.usedPercent)
        || row.usedPercent < 0
        || row.usedPercent > 100) invalidInput();
    return { ...row };
  });
  const usageSeries = value.usageSeries.map((row) => {
    plainExact(row, USAGE_POINT_KEYS);
    if (!validInstant(row.observedAt)
        || !Number.isSafeInteger(row.costNanousd)
        || row.costNanousd < 0) invalidInput();
    return { ...row };
  });
  return { ...value, quotaSeries, usageSeries };
}

function validateForecast(value) {
  plainExact(value, FORECAST_KEYS);
  if (value.method !== "median_of_prior_completed_resets"
      || !Number.isSafeInteger(value.priorResetCount)
      || value.priorResetCount < 2
      || value.priorResetCount > 3
      || !Array.isArray(value.priorResetKeys)
      || value.priorResetKeys.length !== value.priorResetCount
      || value.priorResetKeys.some((key) => typeof key !== "string" || key.length === 0)
      || new Set(value.priorResetKeys).size !== value.priorResetKeys.length
      || !validInstant(value.trainedThrough)
      || !Number.isFinite(value.capacityNanousd)
      || value.capacityNanousd <= 0) invalidInput();
  return { ...value, priorResetKeys: [...value.priorResetKeys] };
}

function floorUtcHour(timestampMs) {
  return timestampMs - (timestampMs % 3_600_000);
}

function ceilUtcHour(timestampMs) {
  const floor = floorUtcHour(timestampMs);
  return floor === timestampMs ? floor : floor + 3_600_000;
}

function endpointValue(series, endpointMs) {
  let before = null;
  let after = null;
  for (const row of series) {
    const timestamp = Date.parse(row.observedAt);
    if (timestamp <= endpointMs && (!before || timestamp > before.timestamp)) {
      before = { timestamp, value: row.usedPercent };
    }
    if (timestamp >= endpointMs && (!after || timestamp < after.timestamp)) {
      after = { timestamp, value: row.usedPercent };
    }
  }
  if (!before || !after
      || endpointMs - before.timestamp > MAXIMUM_ENDPOINT_BRACKET_MS
      || after.timestamp - endpointMs > MAXIMUM_ENDPOINT_BRACKET_MS
      || before.value !== after.value) return null;
  return before.value;
}

function usageCost(series, startMs, endMs) {
  return series.reduce((sum, row) => {
    const timestamp = Date.parse(row.observedAt);
    return timestamp > startMs && timestamp <= endMs ? sum + row.costNanousd : sum;
  }, 0);
}

function round(value, places = 6) {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function buildRollingQuotaComparisons(input) {
  plainExact(input, ["resetEvidence", "capacityForecast"]);
  const evidence = validateEvidence(input.resetEvidence);
  const forecast = validateForecast(input.capacityForecast);
  const refusalCodes = [];
  if (evidence.status !== "eligible") refusalCodes.push("source_evidence_refused");
  if (forecast.trainedThrough > evidence.firstObservedAt) {
    refusalCodes.push("forecast_not_strictly_prior");
  }
  if (forecast.priorResetKeys.includes(evidence.resetKey)) {
    refusalCodes.push("forecast_includes_current_reset");
  }

  const resetEndMs = Date.parse(evidence.resetsAt);
  const resetStartMs =
    resetEndMs - evidence.windowDurationMinutes * 60_000;
  const firstEndMs = ceilUtcHour(
    Math.max(Date.parse(evidence.firstObservedAt), resetStartMs),
  );
  const lastEndMs = floorUtcHour(
    Math.min(Date.parse(evidence.lastObservedAt), resetEndMs),
  );
  const quota = [...evidence.quotaSeries].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
  ));
  const usage = [...evidence.usageSeries].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
  ));
  const comparisons = [];

  if (refusalCodes.length === 0) {
    for (const smoothingHours of ROLLING_HOURS) {
      const widthMs = smoothingHours * 3_600_000;
      for (let windowEndMs = firstEndMs;
        windowEndMs <= lastEndMs;
        windowEndMs += 3_600_000) {
        const windowStartMs = windowEndMs - widthMs;
        if (windowStartMs < resetStartMs || windowEndMs > resetEndMs) continue;
        const startPercent = endpointValue(quota, windowStartMs);
        const endPercent = endpointValue(quota, windowEndMs);
        if (startPercent === null || endPercent === null || endPercent < startPercent) continue;
        const costNanousd = usageCost(usage, windowStartMs, windowEndMs);
        const observedMovementPp = endPercent - startPercent;
        const expectedMovementPp = 100 * costNanousd / forecast.capacityNanousd;
        comparisons.push({
          smoothingHours,
          windowStart: new Date(windowStartMs).toISOString(),
          windowEnd: new Date(windowEndMs).toISOString(),
          costNanousd,
          observedMovementPp: round(observedMovementPp),
          expectedMovementPp: round(expectedMovementPp),
          differencePp: round(expectedMovementPp - observedMovementPp),
        });
      }
    }
  }
  if (refusalCodes.length === 0 && comparisons.length === 0) {
    refusalCodes.push("endpoint_brackets_unavailable");
  }
  return {
    schemaVersion: "quota-rolling-comparisons-v0.1",
    status: refusalCodes.length === 0 ? "conditional_comparison" : "not_testable",
    refusalCodes,
    continuityKey: evidence.continuityKey,
    resetKey: evidence.resetKey,
    windowDurationMinutes: evidence.windowDurationMinutes,
    resetWindowStart: new Date(resetStartMs).toISOString(),
    resetWindowEnd: evidence.resetsAt,
    forecastTrainedThrough: forecast.trainedThrough,
    forecastCapacityNanousd: forecast.capacityNanousd,
    comparisons,
  };
}

export const QUOTA_ROLLING_POLICY = Object.freeze({
  rollingHours: ROLLING_HOURS,
  maximumEndpointBracketMs: MAXIMUM_ENDPOINT_BRACKET_MS,
});
