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
// The second scheme keeps every v1 edge and extends only the speed range above
// 120 tokens/second.  Millisecond metrics are identical in both schemes.
export const PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2 = "performance-histogram-v2";
export const PERFORMANCE_HISTOGRAM_SCHEME_VERSIONS = Object.freeze([
  PERFORMANCE_HISTOGRAM_SCHEME_VERSION,
  PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2,
]);
// A pool is an internal aggregation result, never a wire record: it carries
// v1 and v2 evidence in the v2 index space plus any v1 speed overflow that the
// v1 scheme cannot place above 120 tokens/second.
export const PERFORMANCE_HISTOGRAM_POOL_VERSION = "performance-histogram-pool-v1";

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

// v2 speed, in centi-tokens/second: the 60 v1 edges unchanged, 18 edges of
// 1,000 (10 tokens/second) through 30,000, then 17 logarithmic edges
// ceil(30,000 * 1.15^k) for k = 1..17, through 322,838 (about 3,228
// tokens/second).  Bucket 95 is the implicit overflow bucket.
const performanceHistogramSpeedV2LogUpperCenti = [];
for (let performanceHistogramSpeedK = 1; performanceHistogramSpeedK <= 17; performanceHistogramSpeedK += 1) {
  performanceHistogramSpeedV2LogUpperCenti.push(
    performanceHistogramCeilRational(
      30_000n * 115n ** BigInt(performanceHistogramSpeedK),
      100n ** BigInt(performanceHistogramSpeedK),
    ),
  );
}
export const SPEED_BUCKET_UPPER_CENTI_TPS_V2 = Object.freeze([
  ...SPEED_BUCKET_UPPER_CENTI_TPS,
  ...Array.from({ length: 18 }, (_, index) => 12_000 + (index + 1) * 1_000),
  ...performanceHistogramSpeedV2LogUpperCenti,
]);

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
const PERFORMANCE_HISTOGRAM_SPEED_EDGES = new Map([
  [PERFORMANCE_HISTOGRAM_SCHEME_VERSION, SPEED_BUCKET_UPPER_CENTI_TPS],
  [PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2, SPEED_BUCKET_UPPER_CENTI_TPS_V2],
]);
const PERFORMANCE_HISTOGRAM_V1_SPEED_OVERFLOW_ID = SPEED_BUCKET_UPPER_CENTI_TPS.length;
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

function performanceHistogramScheme(scheme) {
  if (!PERFORMANCE_HISTOGRAM_SCHEME_VERSIONS.includes(scheme)) performanceHistogramInvalid();
  return scheme;
}

function performanceHistogramSpeedEdges(scheme) {
  return PERFORMANCE_HISTOGRAM_SPEED_EDGES.get(performanceHistogramScheme(scheme));
}

function performanceHistogramSpeedOverflowId(scheme) {
  return performanceHistogramSpeedEdges(scheme).length;
}

function performanceHistogramBucketCount(metric, scheme) {
  return metric === "speed"
    ? performanceHistogramSpeedOverflowId(scheme) + 1
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

function performanceHistogramSpeedBucket(value, scheme) {
  const centi = performanceHistogramSpeedCenti(value);
  const edges = performanceHistogramSpeedEdges(scheme);
  const index = edges.findIndex((upper) => centi < upper);
  return index < 0 ? edges.length : index;
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

function performanceHistogramBucket(metric, value, scheme) {
  if (metric === "speed") return performanceHistogramSpeedBucket(value, scheme);
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

function performanceHistogramBucketsFromValues(metric, values, scheme) {
  const buckets = {};
  for (const value of values) {
    const key = String(performanceHistogramBucket(metric, value, scheme));
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return buckets;
}

function performanceHistogramCreate(metric, sampleCount, buckets, min, max, scheme) {
  return {
    schemaVersion: scheme,
    metric,
    sampleCount,
    buckets,
    min,
    max,
  };
}

/**
 * Build one bounded histogram from already-qualified local measurements.  The
 * scheme defaults to v1 so existing callers keep their exact wire bytes.
 */
export function buildPerformanceHistogram(
  metric,
  values,
  schemeVersion = PERFORMANCE_HISTOGRAM_SCHEME_VERSION,
) {
  performanceHistogramMetric(metric);
  performanceHistogramScheme(schemeVersion);
  if (!Array.isArray(values) || values.length > PERFORMANCE_HISTOGRAM_MAX_VALUES) {
    performanceHistogramInvalid();
  }
  // Validate the caller's values before doing any work and never sort/mutate
  // their array.  The source authority and qualification gate live elsewhere.
  const snapshot = values.slice();
  for (const value of snapshot) performanceHistogramValidateBuildValue(metric, value);
  if (snapshot.length === 0) {
    return performanceHistogramCreate(metric, 0, {}, null, null, schemeVersion);
  }
  const bounds = performanceHistogramOutputBounds(metric, snapshot);
  const result = performanceHistogramCreate(
    metric,
    snapshot.length,
    performanceHistogramBucketsFromValues(metric, snapshot, schemeVersion),
    bounds.min,
    bounds.max,
    schemeVersion,
  );
  return parsePerformanceHistogram(result);
}

function performanceHistogramBucketForStoredBound(metric, value, scheme) {
  if (metric === "speed") {
    const edges = performanceHistogramSpeedEdges(scheme);
    const index = edges.findIndex((upper) => value < upper);
    return index < 0 ? edges.length : index;
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

function performanceHistogramStoredBucketBounds(metric, bucket, scheme) {
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
  const edges = performanceHistogramSpeedEdges(scheme);
  if (bucket === edges.length) {
    return [edges.at(-1), Number.MAX_SAFE_INTEGER];
  }
  return [
    bucket === 0 ? 0 : edges[bucket - 1],
    edges[bucket],
  ];
}

function performanceHistogramValidateBounds(metric, histogram, occupied) {
  const { min, max } = histogram;
  const scheme = histogram.schemaVersion;
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
    scheme,
  );
  const upperBucket = performanceHistogramBucketForStoredBound(
    metric,
    max,
    scheme,
  );
  const firstBounds = performanceHistogramStoredBucketBounds(metric, occupied[0], scheme);
  const lastBounds = performanceHistogramStoredBucketBounds(metric, occupied.at(-1), scheme);
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
  ]) || !PERFORMANCE_HISTOGRAM_SCHEME_VERSIONS.includes(value.schemaVersion)
      || !PERFORMANCE_HISTOGRAM_METRICS.includes(value.metric)
      || !performanceHistogramSafeCount(value.sampleCount)
      || !performanceHistogramOwnDataObject(value.buckets)) {
    performanceHistogramInvalid();
  }
  const bucketCount = performanceHistogramBucketCount(value.metric, value.schemaVersion);
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

/**
 * Merge at most one bounded page tree of one scheme; this function performs no
 * deduplication.  Mixed-scheme evidence is pooled with poolPerformanceHistograms.
 */
export function mergePerformanceHistograms(histograms) {
  if (!Array.isArray(histograms) || histograms.length < 1
      || histograms.length > PERFORMANCE_HISTOGRAM_MAX_PAGES) performanceHistogramInvalid();
  const parsed = histograms.map((histogram) => parsePerformanceHistogram(histogram));
  const metric = parsed[0].metric;
  const scheme = parsed[0].schemaVersion;
  const buckets = {};
  let sampleCount = 0;
  let min = null;
  let max = null;
  for (const histogram of parsed) {
    if (histogram.metric !== metric || histogram.schemaVersion !== scheme) {
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
  return parsePerformanceHistogram(
    performanceHistogramCreate(metric, sampleCount, buckets, min, max, scheme),
  );
}

function performanceHistogramBucketBounds(histogram, bucket) {
  const { metric, min, max } = histogram;
  const scheme = histogram.schemaVersion;
  if (metric === "ttft" || metric === "turnDuration") {
    const [lower, upper] = performanceHistogramStoredBucketBounds(metric, bucket, scheme);
    return [Math.max(lower, min), Math.min(upper, max)];
  }
  const edges = performanceHistogramSpeedEdges(scheme);
  if (bucket === edges.length) {
    return [
      Math.max(edges.at(-1) / 100, min / 100),
      max / 100,
    ];
  }
  const [lowerCenti, upperCenti] = performanceHistogramStoredBucketBounds(metric, bucket, scheme);
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

// ---------------------------------------------------------------------------
// Cross-scheme pools.  v1 and v2 share every bucket below 120 tokens/second and
// every millisecond bucket, so those counts add exactly.  A v1 speed overflow
// count is evidence only that each sample was at or above 120 tokens/second;
// it is carried as unresolved mass and widens bounds instead of being guessed
// into a v2 bucket.

const PERFORMANCE_HISTOGRAM_POOL_KEYS = Object.freeze([
  "schemaVersion", "metric", "sampleCount", "buckets", "unresolvedCount", "min", "max",
]);

function performanceHistogramPoolCreate(metric, sampleCount, buckets, unresolvedCount, min, max) {
  return {
    schemaVersion: PERFORMANCE_HISTOGRAM_POOL_VERSION,
    metric,
    sampleCount,
    buckets,
    unresolvedCount,
    min,
    max,
  };
}

function performanceHistogramPoolValidate(value) {
  if (!performanceHistogramExactKeys(value, PERFORMANCE_HISTOGRAM_POOL_KEYS)
      || value.schemaVersion !== PERFORMANCE_HISTOGRAM_POOL_VERSION
      || !PERFORMANCE_HISTOGRAM_METRICS.includes(value.metric)
      || !performanceHistogramSafeCount(value.sampleCount)
      || !performanceHistogramSafeCount(value.unresolvedCount)
      || (value.metric !== "speed" && value.unresolvedCount !== 0)
      || !performanceHistogramOwnDataObject(value.buckets)) {
    performanceHistogramInvalid();
  }
  const resolvedCount = value.sampleCount - value.unresolvedCount;
  if (resolvedCount < 0) performanceHistogramInvalid();
  // The resolved part uses v2 bucket indexes.  Its counts must sum exactly;
  // extrema are the pool's own envelope across resolved and unresolved mass.
  const scheme = PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2;
  const bucketCount = performanceHistogramBucketCount(value.metric, scheme);
  let total = 0;
  const occupied = [];
  for (const key of Object.keys(value.buckets)) {
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
  if (total !== resolvedCount) performanceHistogramInvalid();
  const { min, max } = value;
  if (value.sampleCount === 0) {
    if (min !== null || max !== null) performanceHistogramInvalid();
    return value;
  }
  const minimumValue = value.metric === "turnDuration" ? 1 : 0;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)
      || min < minimumValue || min > max
      || (value.metric === "speed" && max < 1)) {
    performanceHistogramInvalid();
  }
  if (value.sampleCount === 1
      && (value.metric === "speed" ? max - min > 1 : min !== max)) {
    performanceHistogramInvalid();
  }
  // Extrema must agree with the occupied evidence exactly as in a histogram.
  // Unresolved mass lies at or above 120 tokens/second and may hold either
  // extreme, so it relaxes only the side it can supply.
  const unresolvedFloor = SPEED_BUCKET_UPPER_CENTI_TPS.at(-1);
  if (value.unresolvedCount > 0 && max < unresolvedFloor) performanceHistogramInvalid();
  if (occupied.length === 0) {
    if (min < unresolvedFloor) performanceHistogramInvalid();
    return value;
  }
  const [firstLow, firstHigh] = performanceHistogramStoredBucketBounds(value.metric, occupied[0], scheme);
  const [lastLow, lastHigh] = performanceHistogramStoredBucketBounds(value.metric, occupied.at(-1), scheme);
  if (min > firstHigh || max < lastLow) performanceHistogramInvalid();
  if (value.unresolvedCount === 0) {
    if (min < firstLow || max > lastHigh) performanceHistogramInvalid();
  } else if (min < Math.min(firstLow, unresolvedFloor)) {
    performanceHistogramInvalid();
  }
  return value;
}

function performanceHistogramPoolFromHistogram(histogram) {
  if (histogram.schemaVersion === PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2
      || histogram.metric !== "speed") {
    return performanceHistogramPoolCreate(
      histogram.metric,
      histogram.sampleCount,
      { ...histogram.buckets },
      0,
      histogram.min,
      histogram.max,
    );
  }
  const buckets = {};
  let unresolvedCount = 0;
  for (const [key, count] of Object.entries(histogram.buckets)) {
    if (Number(key) === PERFORMANCE_HISTOGRAM_V1_SPEED_OVERFLOW_ID) {
      unresolvedCount = count;
    } else {
      buckets[key] = count;
    }
  }
  return performanceHistogramPoolCreate(
    histogram.metric,
    histogram.sampleCount,
    buckets,
    unresolvedCount,
    histogram.min,
    histogram.max,
  );
}

/**
 * Pool v1 histograms, v2 histograms and earlier pools of one metric.  Like a
 * merge, a call accepts at most one bounded page and performs no deduplication.
 */
export function poolPerformanceHistograms(items) {
  if (!Array.isArray(items) || items.length < 1
      || items.length > PERFORMANCE_HISTOGRAM_MAX_PAGES) performanceHistogramInvalid();
  const pools = items.map((item) => (
    item?.schemaVersion === PERFORMANCE_HISTOGRAM_POOL_VERSION
      ? performanceHistogramPoolValidate(item)
      : performanceHistogramPoolFromHistogram(parsePerformanceHistogram(item))
  ));
  const metric = pools[0].metric;
  const buckets = {};
  let sampleCount = 0;
  let unresolvedCount = 0;
  let min = null;
  let max = null;
  for (const pool of pools) {
    if (pool.metric !== metric) performanceHistogramInvalid();
    sampleCount += pool.sampleCount;
    unresolvedCount += pool.unresolvedCount;
    if (!Number.isSafeInteger(sampleCount) || !Number.isSafeInteger(unresolvedCount)) {
      performanceHistogramInvalid();
    }
    for (const [key, count] of Object.entries(pool.buckets)) {
      const next = (buckets[key] ?? 0) + count;
      if (!Number.isSafeInteger(next)) performanceHistogramInvalid();
      buckets[key] = next;
    }
    if (pool.min !== null) min = min === null ? pool.min : Math.min(min, pool.min);
    if (pool.max !== null) max = max === null ? pool.max : Math.max(max, pool.max);
  }
  const ordered = Object.fromEntries(Object.keys(buckets)
    .map(Number).sort((left, right) => left - right)
    .map((index) => [String(index), buckets[String(index)]]));
  return performanceHistogramPoolValidate(
    performanceHistogramPoolCreate(metric, sampleCount, ordered, unresolvedCount, min, max),
  );
}

function performanceHistogramPoolResolvedBounds(pool, bucket) {
  return performanceHistogramBucketBounds({
    schemaVersion: PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2,
    metric: pool.metric,
    min: pool.min,
    max: pool.max,
  }, bucket);
}

// Each sample has an interval [low, high].  The k-th smallest true value is at
// least the k-th smallest low and at most the k-th smallest high.  Unresolved
// mass has low = 120 tokens/second (it sorts before every resolved bucket at or
// above 120) and high = the pool maximum (it sorts after every resolved bucket).
function performanceHistogramPoolRankInterval(pool, rank, side) {
  const unresolvedLow = Math.max(SPEED_BUCKET_UPPER_CENTI_TPS.at(-1) / 100, pool.min / 100);
  const unresolvedHigh = pool.max / 100;
  const entries = Object.keys(pool.buckets).map(Number).sort((left, right) => left - right)
    .map((index) => {
      const [low, high] = performanceHistogramPoolResolvedBounds(pool, index);
      return { count: pool.buckets[String(index)], value: side === "low" ? low : high };
    });
  if (pool.unresolvedCount > 0) {
    entries.push({
      count: pool.unresolvedCount,
      value: side === "low" ? unresolvedLow : unresolvedHigh,
    });
    entries.sort((left, right) => left.value - right.value);
  }
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.count;
    if (rank < cumulative) return entry.value;
  }
  performanceHistogramInvalid();
}

/**
 * Approximate quantiles with conservative bounds for a cross-scheme pool.  With
 * no unresolved mass this equals performanceHistogramQuantiles on v2 edges.
 */
export function performanceHistogramPoolQuantiles(value) {
  const pool = performanceHistogramPoolValidate(value);
  const result = {};
  for (const [name, numerator, denominator] of PERFORMANCE_HISTOGRAM_PERCENTILES) {
    if (pool.sampleCount === 0 || (pool.sampleCount < 5 && name !== "median")) {
      result[name] = null;
      continue;
    }
    const rankNumerator = BigInt(pool.sampleCount - 1) * BigInt(numerator);
    const rankDenominator = BigInt(denominator);
    const lowerRank = Number(rankNumerator / rankDenominator);
    const remainder = Number(rankNumerator % rankDenominator);
    const upperRank = remainder === 0 ? lowerRank : lowerRank + 1;
    const weight = remainder / denominator;
    const lowLow = performanceHistogramPoolRankInterval(pool, lowerRank, "low");
    const highLow = performanceHistogramPoolRankInterval(pool, upperRank, "low");
    const lowHigh = performanceHistogramPoolRankInterval(pool, lowerRank, "high");
    const highHigh = performanceHistogramPoolRankInterval(pool, upperRank, "high");
    const lower = lowLow + (highLow - lowLow) * weight;
    const upper = lowHigh + (highHigh - lowHigh) * weight;
    result[name] = {
      estimate: lower + (upper - lower) / 2,
      lower,
      upper,
    };
  }
  return {
    methodVersion: "performance-histogram-pool-type7-bounds-v1",
    approximate: true,
    unit: pool.metric === "speed" ? "tokens_per_second" : "milliseconds",
    sampleCount: pool.sampleCount,
    unresolvedCount: pool.unresolvedCount,
    ...result,
  };
}
