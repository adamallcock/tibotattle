import {
  isValidQuotaWindowDuration,
  SEVEN_DAY_WINDOW_MINUTES,
} from "./quota-windows.js";

// v0.2 (2026-08-19): the forecast carries two named rates instead of one
// ambiguous `percentagePointsPerHour`, and the ETA is derived from the
// wall-clock rate rather than the working-time one. The old key is removed
// rather than redefined so a reader that never validated the shape gets
// `undefined` instead of a silently different number.
const SCHEMA_VERSION = "quota-pace-forecast-v0.2";
// Names how the ACTIVE rate is derived. The overall rate is a plain
// movement-over-elapsed quotient and needs no method label.
const METHOD = "median_adjacent_quota_slope";
// Which of the two rates `etaAt`, `hoursToExhaustion` and `status` are built
// from. Stated on the policy object so a consumer never has to infer it.
const ETA_BASIS = "overall_percentage_points_per_hour";
const MAXIMUM_RECEIPT_LAG_MS = 5 * 60_000;
const MAXIMUM_PACE_PP_PER_HOUR = 100;
const HOUR_MS = 3_600_000;

const SNAPSHOT_KEYS = [
  "accountTrackId",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "slot",
  "windowDurationMinutes",
  "resetsAt",
  "observedAt",
  "receivedAt",
  "usedPercent",
  "policyEpoch",
];

// Track compatibility is judged by (limit, duration) plus account/plan/reset
// facets. `slot` stays in the snapshot shape as visible metadata but is NOT a
// track key: it is a server-assigned UI role, and the provider flipped the
// weekly window from `secondary` to `primary` around 2026-07-06 without the
// window itself changing.
const TRACK_KEYS = [
  "accountTrackId",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "windowDurationMinutes",
  "resetsAt",
  "policyEpoch",
];

const INPUT_KEYS = ["currentSnapshot", "observations"];

const REFUSAL_ORDER = [
  "reset_elapsed",
  "stale_observation",
  "future_observation",
  "incompatible_observation",
  "ambiguous_observation",
  "backward_observation",
  "insufficient_observations",
  "non_positive_pace",
  "implausible_pace",
];

function invalidInput() {
  throw new TypeError("quota_pace_invalid_input");
}

function plainExact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidInput();
  const actual = Object.keys(value);
  if (actual.length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) invalidInput();
}

function validInstant(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validNonEmptyText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validateSnapshot(value) {
  plainExact(value, SNAPSHOT_KEYS);
  if (!validNonEmptyText(value.accountTrackId)
      || !validNonEmptyText(value.provider)
      || !validNonEmptyText(value.planType)
      || !validNonEmptyText(value.planVariant)
      || !validNonEmptyText(value.limitId)
      || !validNonEmptyText(value.slot)
      || !isValidQuotaWindowDuration(value.windowDurationMinutes)
      || !validInstant(value.resetsAt)
      || !validInstant(value.observedAt)
      || !validInstant(value.receivedAt)
      || !validNonEmptyText(value.policyEpoch)
      || !Number.isFinite(value.usedPercent)
      || value.usedPercent < 0
      || value.usedPercent > 100) {
    invalidInput();
  }
  const observedMs = Date.parse(value.observedAt);
  const receivedMs = Date.parse(value.receivedAt);
  if (receivedMs < observedMs) invalidInput();
  return { ...value };
}

function sameTrack(left, right) {
  return TRACK_KEYS.every((key) => left[key] === right[key]);
}

function orderedRefusals(values) {
  const unique = new Set(values);
  return REFUSAL_ORDER.filter((code) => unique.has(code));
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function emptyPace() {
  return {
    method: METHOD,
    sampleCount: 0,
    elapsedHours: null,
    movementPp: null,
    activePercentagePointsPerHour: null,
    overallPercentagePointsPerHour: null,
  };
}

function resultBase(current, status, refusalCodes, pace) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    refusalCodes: orderedRefusals(refusalCodes),
    accountTrackId: current.accountTrackId,
    provider: current.provider,
    planType: current.planType,
    planVariant: current.planVariant,
    limitId: current.limitId,
    slot: current.slot,
    windowDurationMinutes: current.windowDurationMinutes,
    policyEpoch: current.policyEpoch,
    resetsAt: current.resetsAt,
    currentObservedAt: current.observedAt,
    currentUsedPercent: round(current.usedPercent),
    remainingPercent: round(Math.max(0, 100 - current.usedPercent)),
    pace,
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: round(Math.max(
      0,
      (Date.parse(current.resetsAt) - Date.parse(current.observedAt)) / HOUR_MS,
    )),
  };
}

function finalResult(current, points, refusalCodes) {
  const sorted = [...points].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.receivedAt.localeCompare(right.receivedAt)
    || left.usedPercent - right.usedPercent
  ));
  const first = sorted[0];
  const currentMs = Date.parse(current.observedAt);
  const firstMs = Date.parse(first.observedAt);
  const elapsedHours = (currentMs - firstMs) / HOUR_MS;
  const movementPp = current.usedPercent - first.usedPercent;
  const rates = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const prior = sorted[index - 1];
    const next = sorted[index];
    const elapsedMs = Date.parse(next.observedAt) - Date.parse(prior.observedAt);
    const movement = next.usedPercent - prior.usedPercent;
    if (elapsedMs > 0 && movement > 0) {
      rates.push(movement / (elapsedMs / HOUR_MS));
    }
  }
  // Two rates, because they answer two different questions and routinely
  // disagree by an order of magnitude.
  //
  // The ACTIVE rate is the median of the adjacent slopes that actually moved.
  // Dropping the still intervals is load-bearing, not incidental: at a
  // five-minute polling cadence a normal week has far more still intervals
  // than moving ones, so an unfiltered median would be exactly zero, trip
  // `non_positive_pace`, and no forecast would ever be produced. Taking the
  // median rather than a mean is equally deliberate - it keeps one burst from
  // defining the working rate.
  //
  // The OVERALL rate is total movement over total elapsed time, idle included.
  //
  // The ETA is built from the overall rate and never from the active one. The
  // active rate is measured per *working* hour, so dividing a remaining
  // allowance by it and reporting the quotient as *wall-clock* hours is a unit
  // error: it silently assumes the reader never stops. That is what made every
  // published ETA arrive early (community report, 2026-08-18; 11.3pp/hour
  // active against 0.97pp/hour overall on 1,109 observations over 4d 4h).
  const activePercentagePointsPerHour = median(rates);
  // Both rates are reported only when they are a real, positive rate. A
  // backward observation makes `movementPp` negative and a still window makes
  // it zero; neither is a pace, and a negative one would be read downstream as
  // a rate rather than as the refusal it actually is. The active rate is
  // already null in both cases - no adjacent interval moved forwards - so this
  // just keeps the two fields agreeing.
  const overallPercentagePointsPerHour = elapsedHours > 0 && movementPp > 0
    ? movementPp / elapsedHours
    : null;
  const pace = {
    method: METHOD,
    sampleCount: Math.max(0, sorted.length - 1),
    elapsedHours: round(elapsedHours),
    movementPp: round(movementPp),
    // A working rate above the cap is reported as "not stateable" rather than
    // taken as grounds to refuse the forecast. Over a five-minute poll the cap
    // is only 8.3pp, which an ordinary burst clears easily, and this rate no
    // longer decides anything: it is the without-pausing marker, and the ETA
    // is built from the wall-clock rate below. Refusing here would blank a
    // card whose actual forecast is sound.
    activePercentagePointsPerHour:
      activePercentagePointsPerHour !== null
        && activePercentagePointsPerHour > 0
        && activePercentagePointsPerHour <= MAXIMUM_PACE_PP_PER_HOUR
        ? round(activePercentagePointsPerHour)
        : null,
    overallPercentagePointsPerHour: round(overallPercentagePointsPerHour),
  };
  const result = resultBase(current, "unavailable", refusalCodes, pace);
  if (refusalCodes.length > 0) return result;
  if (sorted.length < 2) {
    result.status = "insufficient_observations";
    result.refusalCodes = ["insufficient_observations"];
    return result;
  }
  // Positive movement over positive elapsed time implies a positive working
  // rate too, so the wall-clock rate is the only one worth guarding here.
  if (!(elapsedHours > 0)
      || !(movementPp > 0)
      || !(overallPercentagePointsPerHour > 0)) {
    result.refusalCodes = ["non_positive_pace"];
    return result;
  }
  // Only the rate the ETA is built from can make the ETA implausible.
  if (overallPercentagePointsPerHour > MAXIMUM_PACE_PP_PER_HOUR) {
    result.refusalCodes = ["implausible_pace"];
    return result;
  }
  const remainingPp = Math.max(0, 100 - current.usedPercent);
  const hoursToExhaustion = remainingPp / overallPercentagePointsPerHour;
  const resetMs = Date.parse(current.resetsAt);
  const etaMs = currentMs + hoursToExhaustion * HOUR_MS;
  const etaDate = new Date(etaMs);
  if (!Number.isFinite(hoursToExhaustion)
      || !Number.isFinite(etaMs)
      || !Number.isFinite(etaDate.getTime())) {
    result.refusalCodes = ["implausible_pace"];
    return result;
  }
  result.hoursToExhaustion = round(hoursToExhaustion);
  result.etaAt = etaDate.toISOString();
  result.status = etaMs < resetMs ? "available" : "will_reach_reset_first";
  return result;
}

/**
 * Estimate quota-window allowance exhaustion from provider quota percentage movement.
 * This is intentionally a deterministic pace/ETA calculation, not a probability.
 */
export function analyzeQuotaPace(input) {
  plainExact(input, INPUT_KEYS);
  if (!Array.isArray(input.observations)) invalidInput();
  const current = validateSnapshot(input.currentSnapshot);
  const currentReceiptLagMs =
    Date.parse(current.receivedAt) - Date.parse(current.observedAt);
  if (currentReceiptLagMs > MAXIMUM_RECEIPT_LAG_MS) {
    return resultBase(current, "unavailable", ["stale_observation"], emptyPace());
  }
  if (Date.parse(current.resetsAt) <= Date.parse(current.observedAt)) {
    return resultBase(current, "unavailable", ["reset_elapsed"], emptyPace());
  }
  const rawObservations = input.observations.map(validateSnapshot);
  const refusalCodes = [];
  const points = [current];
  const byObservedAt = new Map([[current.observedAt, current]]);
  for (const row of rawObservations) {
    if (Date.parse(row.receivedAt) - Date.parse(row.observedAt) > MAXIMUM_RECEIPT_LAG_MS) {
      refusalCodes.push("stale_observation");
      continue;
    }
    if (Date.parse(row.observedAt) > Date.parse(current.observedAt)) {
      refusalCodes.push("future_observation");
      continue;
    }
    if (!sameTrack(row, current)) {
      refusalCodes.push("incompatible_observation");
      continue;
    }
    const prior = byObservedAt.get(row.observedAt);
    if (prior) {
      if (prior.usedPercent !== row.usedPercent
          || prior.receivedAt !== row.receivedAt) {
        refusalCodes.push("ambiguous_observation");
      }
      continue;
    }
    byObservedAt.set(row.observedAt, row);
    points.push(row);
  }
  const sorted = [...points].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
  ));
  if (sorted.some((row, index) => (
    index > 0 && row.usedPercent < sorted[index - 1].usedPercent
  ))) {
    refusalCodes.push("backward_observation");
  }
  if (refusalCodes.length > 0) {
    const result = finalResult(current, points, refusalCodes);
    if (result.pace.sampleCount < 1 && !refusalCodes.includes("insufficient_observations")) {
      result.pace = emptyPace();
    }
    return result;
  }
  return finalResult(current, points, []);
}

export const QUOTA_PACE_POLICY = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  method: METHOD,
  etaBasis: ETA_BASIS,
  windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
  maximumReceiptLagMs: MAXIMUM_RECEIPT_LAG_MS,
  maximumPacePpPerHour: MAXIMUM_PACE_PP_PER_HOUR,
  minimumObservations: 2,
});
