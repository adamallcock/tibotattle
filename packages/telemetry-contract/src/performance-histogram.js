import {
  isTelemetryRecord,
} from "./primitives.js";
import {
  telemetryContractFailure,
} from "./errors.js";

/**
 * A mergeable, content-free diagnostic distribution.  This module deliberately
 * has no source, upload, pricing, or cache-continuity authority.
 */
export const PERFORMANCE_HISTOGRAM_SCHEME_VERSION = "performance-histogram-v1";

const PERFORMANCE_HISTOGRAM_MAX_VALUES = 100_000;
const PERFORMANCE_HISTOGRAM_MAX_PAGES = 200;
const PERFORMANCE_HISTOGRAM_MAX_COUNT = Number.MAX_SAFE_INTEGER;
const PERFORMANCE_HISTOGRAM_MAX_SAFE_CENTI_TPS = Number.MAX_SAFE_INTEGER;
const PERFORMANCE_HISTOGRAM_PERCENTILES = Object.freeze([
  ["p10", 1, 10],
  ["p25", 1, 4],
  ["median", 1, 2],
  ["p75", 3, 4],
  ["p90", 9, 10],
]);

export const SPEED_BUCKET_UPPER_CENTI_TPS = Object.freeze(
  Array.from({ length: 60 }, (_, index) => (index + 1) * 200),
);

function performanceHistogramCeilRational(numerator, denominator) {
  return Number((numerator + denominator - 1n) / denominator);
}

// Bucket 0 is reserved for TTFT == 0.  The exported edge list starts with the
// positive lower edge (1ms), then the lower edge of the logarithmic range
// (500ms), followed by 55 upper-exclusive logarithmic edges.  Bucket 57 is
// the implicit overflow bucket at and above the final edge.
const performanceHistogramTtftLogUpperMs = [];
for (let performanceHistogramTtftK = 1; performanceHistogramTtftK <= 55; performanceHistogramTtftK += 1) {
  performanceHistogramTtftLogUpperMs.push(
    performanceHistogramCeilRational(
      500n * 115n ** BigInt(performanceHistogramTtftK),
      100n ** BigInt(performanceHistogramTtftK),
    ),
  );
}
export const TTFT_BUCKET_UPPER_MS = Object.freeze([
  1,
  500,
  ...performanceHistogramTtftLogUpperMs,
]);

// Turn duration uses the same fixed positive millisecond bins as TTFT.  Keep
// this as a named export so consumers cannot silently substitute client- or
// person-specific ranges.  Bucket 0 remains reserved for TTFT's real zero;
// turn duration values are strictly positive and therefore never occupy it.
export const TURN_DURATION_BUCKET_UPPER_MS = TTFT_BUCKET_UPPER_MS;

const PERFORMANCE_HISTOGRAM_METRICS = Object.freeze([
  "speed",
  "ttft",
  "turnDuration",
]);
const PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID = SPEED_BUCKET_UPPER_CENTI_TPS.length;
const PERFORMANCE_HISTOGRAM_TTFT_ZERO_ID = 0;
const PERFORMANCE_HISTOGRAM_TTFT_LOWER_ID = 1;
const PERFORMANCE_HISTOGRAM_TTFT_LOG_FIRST_EDGE_INDEX = 2;
const PERFORMANCE_HISTOGRAM_TTFT_OVERFLOW_ID = TTFT_BUCKET_UPPER_MS.length;
const PERFORMANCE_HISTOGRAM_TURN_DURATION_LOWER_ID = 1;
const PERFORMANCE_HISTOGRAM_TURN_DURATION_LOG_FIRST_EDGE_INDEX = 2;
const PERFORMANCE_HISTOGRAM_TURN_DURATION_OVERFLOW_ID = TURN_DURATION_BUCKET_UPPER_MS.length;

function performanceHistogramInvalid() {
  telemetryContractFailure(
    "TELEMETRY_RECORD_INVALID",
    "performance_histogram_invalid",
    "The performance histogram is invalid.",
  );
}

function performanceHistogramMetric(metric) {
  if (!PERFORMANCE_HISTOGRAM_METRICS.includes(metric)) performanceHistogramInvalid();
  return metric;
}

function performanceHistogramBucketCount(metric) {
  return metric === "speed"
    ? PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID + 1
    : metric === "ttft"
      ? PERFORMANCE_HISTOGRAM_TTFT_OVERFLOW_ID + 1
      : PERFORMANCE_HISTOGRAM_TURN_DURATION_OVERFLOW_ID + 1;
}

function performanceHistogramOwnDataObject(value) {
  if (!isTelemetryRecord(value)) return false;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return false;
  }
  return Reflect.ownKeys(descriptors).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return Object.hasOwn(descriptor, "value") && descriptor.enumerable === true;
  });
}

function performanceHistogramExactKeys(value, keys) {
  if (!performanceHistogramOwnDataObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function performanceHistogramSafeCount(value, allowZero = true) {
  return Number.isSafeInteger(value)
    && value >= (allowZero ? 0 : 1)
    && value <= PERFORMANCE_HISTOGRAM_MAX_COUNT;
}

function performanceHistogramSpeedCenti(value) {
  const scaled = value * 100;
  if (!Number.isFinite(scaled) || scaled < 0) performanceHistogramInvalid();
  return scaled;
}

function performanceHistogramSpeedBucket(value) {
  const centi = performanceHistogramSpeedCenti(value);
  const index = SPEED_BUCKET_UPPER_CENTI_TPS.findIndex((upper) => centi < upper);
  return index < 0 ? PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID : index;
}

function performanceHistogramTtftBucket(value) {
  if (value === 0) return PERFORMANCE_HISTOGRAM_TTFT_ZERO_ID;
  if (value < TTFT_BUCKET_UPPER_MS[1]) return PERFORMANCE_HISTOGRAM_TTFT_LOWER_ID;
  const index = TTFT_BUCKET_UPPER_MS.findIndex((upper, edgeIndex) =>
    edgeIndex >= PERFORMANCE_HISTOGRAM_TTFT_LOG_FIRST_EDGE_INDEX && value < upper);
  return index < 0 ? PERFORMANCE_HISTOGRAM_TTFT_OVERFLOW_ID : index;
}

function performanceHistogramTurnDurationBucket(value) {
  if (value < TURN_DURATION_BUCKET_UPPER_MS[1]) {
    return PERFORMANCE_HISTOGRAM_TURN_DURATION_LOWER_ID;
  }
  const index = TURN_DURATION_BUCKET_UPPER_MS.findIndex((upper, edgeIndex) =>
    edgeIndex >= PERFORMANCE_HISTOGRAM_TURN_DURATION_LOG_FIRST_EDGE_INDEX
      && value < upper);
  return index < 0 ? PERFORMANCE_HISTOGRAM_TURN_DURATION_OVERFLOW_ID : index;
}

function performanceHistogramBucket(metric, value) {
  if (metric === "speed") return performanceHistogramSpeedBucket(value);
  if (metric === "ttft") return performanceHistogramTtftBucket(value);
  return performanceHistogramTurnDurationBucket(value);
}

function performanceHistogramValidateBuildValue(metric, value) {
  if (metric === "speed") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      performanceHistogramInvalid();
    }
    const scaled = value * 100;
    if (!Number.isFinite(scaled) || scaled > PERFORMANCE_HISTOGRAM_MAX_SAFE_CENTI_TPS) {
      performanceHistogramInvalid();
    }
    return;
  }
  if (!Number.isSafeInteger(value) || value < (metric === "ttft" ? 0 : 1)) {
    performanceHistogramInvalid();
  }
}

function performanceHistogramOutputBounds(metric, values) {
  if (metric === "ttft" || metric === "turnDuration") {
    let minimum = Number.MAX_SAFE_INTEGER;
    let maximum = 0;
    for (const value of values) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return { min: minimum, max: maximum };
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    minimum = Math.min(minimum, Math.floor(value * 100));
    maximum = Math.max(maximum, Math.ceil(value * 100));
  }
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
    performanceHistogramInvalid();
  }
  return { min: minimum, max: maximum };
}

function performanceHistogramBucketsFromValues(metric, values) {
  const buckets = {};
  for (const value of values) {
    const key = String(performanceHistogramBucket(metric, value));
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return buckets;
}

function performanceHistogramCreate(metric, sampleCount, buckets, min, max) {
  return {
    schemaVersion: PERFORMANCE_HISTOGRAM_SCHEME_VERSION,
    metric,
    sampleCount,
    buckets,
    min,
    max,
  };
}

/** Build one bounded histogram from already-qualified local measurements. */
export function buildPerformanceHistogram(metric, values) {
  performanceHistogramMetric(metric);
  if (!Array.isArray(values) || values.length > PERFORMANCE_HISTOGRAM_MAX_VALUES) {
    performanceHistogramInvalid();
  }
  // Validate the caller's values before doing any work and never sort/mutate
  // their array.  The source authority and qualification gate live elsewhere.
  const snapshot = values.slice();
  for (const value of snapshot) performanceHistogramValidateBuildValue(metric, value);
  if (snapshot.length === 0) {
    return performanceHistogramCreate(metric, 0, {}, null, null);
  }
  const bounds = performanceHistogramOutputBounds(metric, snapshot);
  const result = performanceHistogramCreate(
    metric,
    snapshot.length,
    performanceHistogramBucketsFromValues(metric, snapshot),
    bounds.min,
    bounds.max,
  );
  return parsePerformanceHistogram(result);
}

function performanceHistogramBucketForStoredBound(metric, value) {
  if (metric === "speed") {
    const index = SPEED_BUCKET_UPPER_CENTI_TPS.findIndex((upper) => value < upper);
    return index < 0 ? PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID : index;
  }
  if (metric === "ttft") {
    if (value === 0) return PERFORMANCE_HISTOGRAM_TTFT_ZERO_ID;
    if (value < TTFT_BUCKET_UPPER_MS[1]) return PERFORMANCE_HISTOGRAM_TTFT_LOWER_ID;
    const index = TTFT_BUCKET_UPPER_MS.findIndex((upper, edgeIndex) =>
      edgeIndex >= PERFORMANCE_HISTOGRAM_TTFT_LOG_FIRST_EDGE_INDEX && value < upper);
    return index < 0 ? PERFORMANCE_HISTOGRAM_TTFT_OVERFLOW_ID : index;
  }
  return performanceHistogramTurnDurationBucket(value);
}

function performanceHistogramStoredBucketBounds(metric, bucket) {
  if (metric === "ttft") {
    if (bucket === PERFORMANCE_HISTOGRAM_TTFT_ZERO_ID) return [0, 0];
    if (bucket === PERFORMANCE_HISTOGRAM_TTFT_OVERFLOW_ID) {
      return [TTFT_BUCKET_UPPER_MS.at(-1), Number.MAX_SAFE_INTEGER];
    }
    if (bucket === PERFORMANCE_HISTOGRAM_TTFT_LOWER_ID) {
      return [1, TTFT_BUCKET_UPPER_MS[1] - 1];
    }
    return [TTFT_BUCKET_UPPER_MS[bucket - 1], TTFT_BUCKET_UPPER_MS[bucket] - 1];
  }
  if (metric === "turnDuration") {
    if (bucket === PERFORMANCE_HISTOGRAM_TURN_DURATION_OVERFLOW_ID) {
      return [TURN_DURATION_BUCKET_UPPER_MS.at(-1), Number.MAX_SAFE_INTEGER];
    }
    if (bucket === PERFORMANCE_HISTOGRAM_TURN_DURATION_LOWER_ID) {
      return [1, TURN_DURATION_BUCKET_UPPER_MS[1] - 1];
    }
    return [
      TURN_DURATION_BUCKET_UPPER_MS[bucket - 1],
      TURN_DURATION_BUCKET_UPPER_MS[bucket] - 1,
    ];
  }
  if (bucket === PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID) {
    return [SPEED_BUCKET_UPPER_CENTI_TPS.at(-1), Number.MAX_SAFE_INTEGER];
  }
  return [
    bucket === 0 ? 0 : SPEED_BUCKET_UPPER_CENTI_TPS[bucket - 1],
    SPEED_BUCKET_UPPER_CENTI_TPS[bucket],
  ];
}

function performanceHistogramValidateBounds(metric, histogram, occupied) {
  const { min, max } = histogram;
  if (histogram.sampleCount === 0) {
    if (min !== null || max !== null || occupied.length !== 0) performanceHistogramInvalid();
    return;
  }
  if (min === null || max === null || occupied.length === 0 || min > max) {
    performanceHistogramInvalid();
  }
  if (metric === "speed") {
    if (!Number.isSafeInteger(min) || min < 0
        || !Number.isSafeInteger(max) || max < 1
        || max > PERFORMANCE_HISTOGRAM_MAX_SAFE_CENTI_TPS) performanceHistogramInvalid();
  } else if (!Number.isSafeInteger(min) || min < (metric === "ttft" ? 0 : 1)
      || !Number.isSafeInteger(max) || max < (metric === "ttft" ? 0 : 1)) {
    performanceHistogramInvalid();
  }
  if (histogram.sampleCount === 1
      && (metric === "ttft" || metric === "turnDuration"
        ? min !== max : max - min > 1)) {
    performanceHistogramInvalid();
  }
  const lowerBucket = performanceHistogramBucketForStoredBound(
    metric,
    min,
  );
  const upperBucket = performanceHistogramBucketForStoredBound(
    metric,
    max,
  );
  const firstBounds = performanceHistogramStoredBucketBounds(metric, occupied[0]);
  const lastBounds = performanceHistogramStoredBucketBounds(metric, occupied.at(-1));
  if (occupied[0] < lowerBucket || occupied.at(-1) > upperBucket
      || min < firstBounds[0] || min > firstBounds[1]
      || max < lastBounds[0] || max > lastBounds[1]) {
    performanceHistogramInvalid();
  }
}

/** Parse and validate a closed sparse histogram without retaining source data. */
export function parsePerformanceHistogram(value) {
  if (!performanceHistogramExactKeys(value, [
    "schemaVersion", "metric", "sampleCount", "buckets", "min", "max",
  ]) || value.schemaVersion !== PERFORMANCE_HISTOGRAM_SCHEME_VERSION
      || !PERFORMANCE_HISTOGRAM_METRICS.includes(value.metric)
      || !performanceHistogramSafeCount(value.sampleCount)
      || !performanceHistogramOwnDataObject(value.buckets)) {
    performanceHistogramInvalid();
  }
  const bucketCount = performanceHistogramBucketCount(value.metric);
  const bucketKeys = Object.keys(value.buckets);
  if (bucketKeys.length > bucketCount) performanceHistogramInvalid();
  let total = 0;
  const occupied = [];
  for (const key of bucketKeys) {
    if (!/^(?:0|[1-9]\d*)$/u.test(key)) performanceHistogramInvalid();
    const index = Number(key);
    const count = value.buckets[key];
    if (!Number.isSafeInteger(index) || index < 0 || index >= bucketCount
        || (value.metric === "turnDuration" && index === 0)
        || !performanceHistogramSafeCount(count, false)) performanceHistogramInvalid();
    total += count;
    if (!Number.isSafeInteger(total)) performanceHistogramInvalid();
    occupied.push(index);
  }
  occupied.sort((left, right) => left - right);
  if (total !== value.sampleCount) performanceHistogramInvalid();
  performanceHistogramValidateBounds(value.metric, value, occupied);
  if (value.metric === "speed") {
    if (!(value.min === null || Number.isSafeInteger(value.min))
        || !(value.max === null || Number.isSafeInteger(value.max))) performanceHistogramInvalid();
  } else if (!(value.min === null || Number.isSafeInteger(value.min))
      || !(value.max === null || Number.isSafeInteger(value.max))) {
    performanceHistogramInvalid();
  }
  return value;
}

/** Merge at most one bounded page tree; this function performs no deduplication. */
export function mergePerformanceHistograms(histograms) {
  if (!Array.isArray(histograms) || histograms.length < 1
      || histograms.length > PERFORMANCE_HISTOGRAM_MAX_PAGES) performanceHistogramInvalid();
  const parsed = histograms.map((histogram) => parsePerformanceHistogram(histogram));
  const metric = parsed[0].metric;
  const buckets = {};
  let sampleCount = 0;
  let min = null;
  let max = null;
  for (const histogram of parsed) {
    if (histogram.metric !== metric
        || histogram.schemaVersion !== PERFORMANCE_HISTOGRAM_SCHEME_VERSION) {
      performanceHistogramInvalid();
    }
    sampleCount += histogram.sampleCount;
    if (!Number.isSafeInteger(sampleCount)) performanceHistogramInvalid();
    for (const [key, count] of Object.entries(histogram.buckets)) {
      const next = (buckets[key] ?? 0) + count;
      if (!Number.isSafeInteger(next)) performanceHistogramInvalid();
      buckets[key] = next;
    }
    if (histogram.min !== null) min = min === null ? histogram.min : Math.min(min, histogram.min);
    if (histogram.max !== null) max = max === null ? histogram.max : Math.max(max, histogram.max);
  }
  return parsePerformanceHistogram(performanceHistogramCreate(metric, sampleCount, buckets, min, max));
}

function performanceHistogramBucketBounds(histogram, bucket) {
  const { metric, min, max } = histogram;
  if (metric === "ttft" || metric === "turnDuration") {
    const [lower, upper] = performanceHistogramStoredBucketBounds(metric, bucket);
    return [Math.max(lower, min), Math.min(upper, max)];
  }
  if (bucket === PERFORMANCE_HISTOGRAM_SPEED_OVERFLOW_ID) {
    return [
      Math.max(SPEED_BUCKET_UPPER_CENTI_TPS.at(-1) / 100, min / 100),
      max / 100,
    ];
  }
  const [lowerCenti, upperCenti] = performanceHistogramStoredBucketBounds(metric, bucket);
  return [
    Math.max(lowerCenti / 100, min / 100),
    Math.min(upperCenti / 100, max / 100),
  ];
}

function performanceHistogramRankBucket(histogram, rank) {
  let cumulative = 0;
  for (const [key, count] of Object.entries(histogram.buckets)) {
    cumulative += count;
    if (rank < cumulative) return Number(key);
  }
  performanceHistogramInvalid();
}

function performanceHistogramRankBounds(histogram, lowerRank, remainder, denominator) {
  const upperRank = remainder === 0 ? lowerRank : lowerRank + 1;
  const weight = remainder / denominator;
  const lowerBucket = performanceHistogramRankBucket(histogram, lowerRank);
  const upperBucket = performanceHistogramRankBucket(histogram, upperRank);
  const [lowerLow, lowerHigh] = performanceHistogramBucketBounds(histogram, lowerBucket);
  const [upperLow, upperHigh] = performanceHistogramBucketBounds(histogram, upperBucket);
  const lower = lowerLow + (upperLow - lowerLow) * weight;
  const upper = lowerHigh + (upperHigh - lowerHigh) * weight;
  return { lower, upper };
}

/**
 * Return approximate quantiles and conservative bounds.  Histograms preserve
 * mergeable rank intervals, not exact local samples; estimates are interval
 * midpoints and must not be presented as exact percentiles.
 */
export function performanceHistogramQuantiles(value) {
  const histogram = parsePerformanceHistogram(value);
  const result = {};
  for (const [name, numerator, denominator] of PERFORMANCE_HISTOGRAM_PERCENTILES) {
    if (histogram.sampleCount === 0 || (histogram.sampleCount < 5 && name !== "median")) {
      result[name] = null;
      continue;
    }
    const rankNumerator = BigInt(histogram.sampleCount - 1) * BigInt(numerator);
    const rankDenominator = BigInt(denominator);
    const lowerRank = Number(rankNumerator / rankDenominator);
    const remainder = Number(rankNumerator % rankDenominator);
    const bounds = performanceHistogramRankBounds(histogram, lowerRank, remainder, denominator);
    result[name] = {
      estimate: bounds.lower + (bounds.upper - bounds.lower) / 2,
      lower: bounds.lower,
      upper: bounds.upper,
    };
  }
  return {
    methodVersion: "performance-histogram-type7-bounds-v1",
    approximate: true,
    unit: histogram.metric === "speed" ? "tokens_per_second" : "milliseconds",
    sampleCount: histogram.sampleCount,
    ...result,
  };
}
