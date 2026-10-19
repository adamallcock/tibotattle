import { isTelemetryContractError, telemetryContractFailure } from "./errors.js";
import { REVIEWED_MODEL_CATALOG } from "./model-catalog.js";
import {
  PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2,
  parsePerformanceHistogram,
  performanceHistogramPoolQuantiles,
} from "./performance-histogram.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryInstant,
  telemetryPrivacyCanary,
} from "./primitives.js";

// Measurement availability is not permission to send.  This contract is a
// dormant, content-free daily measurement shape; transport and source
// coverage authority are deliberately outside this module.
export const PERFORMANCE_RECORD_SCHEMA_VERSION = "model-performance-daily-v1";
export const PERFORMANCE_MEASUREMENT_VERSION = "model-performance-samples-v1";
export const PERFORMANCE_BUCKET_SCHEME_VERSION = "performance-histogram-v1";
export const PERFORMANCE_BUCKET_SCHEME_VERSION_V2 = PERFORMANCE_HISTOGRAM_SCHEME_VERSION_V2;
export const PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21 =
  "telemetry-performance-registry-2026-09-21.1";
export const PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29 =
  "telemetry-performance-registry-2026-09-29.1";
export const PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10 =
  "telemetry-performance-registry-2026-10-10.1";
// The dictionary this client emits.  It moves only with a client change that
// also moves its bucket scheme; readers accept PERFORMANCE_FIELD_DICTIONARIES.
export const PERFORMANCE_FIELD_DICTIONARY_VERSION =
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29;
// Every accepted record is adapted to this vocabulary before aggregation.
export const PERFORMANCE_LATEST_FIELD_DICTIONARY_VERSION =
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10;
export const PERFORMANCE_PRIVACY_CONTRACT_VERSION =
  "privacy-safe-model-performance-v1";
export const PERFORMANCE_CONTRACT_STATE = "staged";
export const PERFORMANCE_HISTOGRAM_SCHEMA_VERSION = "performance-histogram-v1";
export const MAX_PERFORMANCE_RECORD_CANONICAL_BYTES = 32 * 1024;
export const MAX_PERFORMANCE_HISTOGRAM_BUCKETS = 61;
export const MAX_PERFORMANCE_HISTOGRAM_BUCKETS_V2 = 96;
export const MAX_PERFORMANCE_COUNT = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_TTFT_MILLISECONDS = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS = Number.MAX_SAFE_INTEGER;

export const PERFORMANCE_SPEED_METHODS = Object.freeze([
  "receipt", "legacy", "tool_free", "unavailable",
]);
export const PERFORMANCE_SPEED_MODES = Object.freeze([
  "fast", "standard", "unknown", "other", "mixed", "ultrafast",
]);
export const PERFORMANCE_SPEED_MODE_SOURCES = Object.freeze([
  "rollout_thread_settings", "turn_context_service_tier", "lineage_inherited",
  "unobserved", "mixed",
]);
export const PERFORMANCE_API_SERVICE_TIERS = Object.freeze([
  "standard", "priority", "flex", "batch", "unknown", "other", "mixed", "ultrafast",
]);
export const PERFORMANCE_REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);

function performanceV1Dictionary(fieldDictionaryVersion, state, bucketSchemeVersion, withUltrafast) {
  return Object.freeze({
    fieldDictionaryVersion,
    state,
    bucketSchemeVersion,
    speedModes: Object.freeze(PERFORMANCE_SPEED_MODES.filter((mode) => withUltrafast || mode !== "ultrafast")),
    apiServiceTiers: Object.freeze(PERFORMANCE_API_SERVICE_TIERS.filter((tier) => withUltrafast || tier !== "ultrafast")),
  });
}

/**
 * Every field dictionary a reader accepts.  Each is a strict vocabulary subset
 * of the latest, so its records adapt by identity; the reviewed model catalog
 * only grows.  `accepted` means intake accepts the dictionary: either a
 * released client emits it, or a merged client change emits it and the servers
 * deploy before that client release (server first).  `draft` means no client
 * change emits it yet, so intake must not accept it.  In every state, transport
 * never advertises a dictionary the device did not declare.
 *
 * - 2026-09-21.1: clients 0.1.24-0.1.26 (no Ultrafast; such turns are `other`).
 * - 2026-09-29.1: clients 0.1.27+.
 * - 2026-10-10.1: the v2 bucket scheme (speed resolved above 120 tokens/second).
 */
export const PERFORMANCE_FIELD_DICTIONARIES = Object.freeze({
  [PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21]: performanceV1Dictionary(
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21, "accepted", PERFORMANCE_BUCKET_SCHEME_VERSION, false,
  ),
  [PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29]: performanceV1Dictionary(
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29, "accepted", PERFORMANCE_BUCKET_SCHEME_VERSION, true,
  ),
  [PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10]: performanceV1Dictionary(
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10, "accepted", PERFORMANCE_BUCKET_SCHEME_VERSION_V2, true,
  ),
});

// The bucket scheme this client emits, derived from the registry pairing so it
// moves with PERFORMANCE_FIELD_DICTIONARY_VERSION.  PERFORMANCE_BUCKET_SCHEME_VERSION
// keeps meaning v1: registry rows, schema enums and stored SQL checks rely on it.
export const PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION =
  PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_FIELD_DICTIONARY_VERSION].bucketSchemeVersion;

const performanceV1RecordKeys = Object.freeze([
  "schemaVersion", "day", "provider", "modelId", "reasoningEffort",
  "speedMethod", "speedMode", "speedModeSource", "apiServiceTier",
  "measurementVersion", "bucketSchemeVersion", "turns", "speedTurns",
  "ttftTurns", "completionTurns", "timedResponses", "speedTokens",
  "speedDurationMs", "speedHistogram", "ttftHistogram", "completionHistogram",
]);
const performanceV1TokenPattern = /^[A-Za-z0-9._:-]{1,64}$/u;
const performanceV1DayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const performanceV1ReviewedModelPairs = new Set(
  REVIEWED_MODEL_CATALOG.map(({ provider, id }) => `${provider}\u0000${id}`),
);

function performanceV1Invalid(detail = "performance_record_invalid") {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", detail);
}

function performanceV1Integer(value, maximum = MAX_PERFORMANCE_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function performanceV1Token(value) {
  return typeof value === "string" && performanceV1TokenPattern.test(value);
}

function performanceV1ReviewedModelPair(provider, modelId) {
  return performanceV1ReviewedModelPairs.has(`${provider}\u0000${modelId}`);
}

function performanceV1UtcDay(value) {
  return typeof value === "string"
    && performanceV1DayPattern.test(value)
    && isTelemetryInstant(`${value}T00:00:00.000Z`);
}

function performanceV1DictionaryFor(fieldDictionaryVersion) {
  if (typeof fieldDictionaryVersion !== "string"
      || !Object.hasOwn(PERFORMANCE_FIELD_DICTIONARIES, fieldDictionaryVersion)) {
    performanceV1Invalid("performance_field_dictionary_unknown");
  }
  return PERFORMANCE_FIELD_DICTIONARIES[fieldDictionaryVersion];
}

function performanceV1Guard(value, operation, { maxArrayItems = MAX_PERFORMANCE_HISTOGRAM_BUCKETS } = {}) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_PERFORMANCE_RECORD_CANONICAL_BYTES,
      maxDepth: 6,
      maxArrayItems,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "performance_privacy_canary");
    }
    return operation();
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    performanceV1Invalid();
  }
}

export function parseTelemetryPerformanceHistogram(value) {
  return performanceV1Guard(value, () => parsePerformanceHistogram(value));
}

function performanceV1RateBoundsInCentiTokensPerSecond(tokens, duration) {
  const numerator = BigInt(tokens) * 100_000n;
  const denominator = BigInt(duration);
  return {
    floor: Number(numerator / denominator),
    ceil: Number((numerator + denominator - 1n) / denominator),
  };
}

function performanceV1ValidateRecord(value, dictionary) {
  if (!hasTelemetryExactKeys(value, performanceV1RecordKeys)
      || value.schemaVersion !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || !performanceV1UtcDay(value.day)
      || ![value.provider, value.modelId].every(performanceV1Token)
      || !performanceV1ReviewedModelPair(value.provider, value.modelId)
      || !PERFORMANCE_REASONING_EFFORTS.includes(value.reasoningEffort)
      || !PERFORMANCE_SPEED_METHODS.includes(value.speedMethod)
      || !dictionary.speedModes.includes(value.speedMode)
      || !PERFORMANCE_SPEED_MODE_SOURCES.includes(value.speedModeSource)
      || !dictionary.apiServiceTiers.includes(value.apiServiceTier)
      || value.measurementVersion !== PERFORMANCE_MEASUREMENT_VERSION
      || value.bucketSchemeVersion !== dictionary.bucketSchemeVersion
      || ![value.turns, value.speedTurns, value.ttftTurns, value.completionTurns,
        value.timedResponses, value.speedTokens, value.speedDurationMs]
        .every((item) => performanceV1Integer(item))
      || value.turns < 1
      || value.speedTurns > value.turns || value.ttftTurns > value.turns
      || value.completionTurns > value.turns
      || value.timedResponses < value.speedTurns) {
    performanceV1Invalid();
  }
  if ((value.speedMode === "unknown" && value.speedModeSource !== "unobserved")
      || (value.speedMode === "mixed" && value.speedModeSource !== "mixed")
      || (["fast", "standard", "ultrafast", "other"].includes(value.speedMode)
        && !["rollout_thread_settings", "turn_context_service_tier", "lineage_inherited"]
          .includes(value.speedModeSource))) {
    performanceV1Invalid("performance_speed_mode_source_mismatch");
  }
  const speed = parsePerformanceHistogram(value.speedHistogram);
  const ttft = parsePerformanceHistogram(value.ttftHistogram);
  const completion = parsePerformanceHistogram(value.completionHistogram);
  if ([speed, ttft, completion].some((histogram) => histogram.schemaVersion !== dictionary.bucketSchemeVersion)) {
    performanceV1Invalid("performance_histogram_scheme_mismatch");
  }
  if (speed.metric !== "speed" || ttft.metric !== "ttft"
      || completion.metric !== "turnDuration"
      || speed.sampleCount !== value.speedTurns
      || ttft.sampleCount !== value.ttftTurns
      || completion.sampleCount !== value.completionTurns) {
    performanceV1Invalid("performance_histogram_count_mismatch");
  }
  if (value.speedMethod === "unavailable") {
    if (value.speedTurns !== 0 || value.timedResponses !== 0
        || value.speedTokens !== 0 || value.speedDurationMs !== 0
        || speed.min !== null || speed.max !== null) {
      performanceV1Invalid("performance_speed_unavailable_mismatch");
    }
  } else if (value.turns < 1 || value.speedTurns !== value.turns
      || value.speedTokens < value.speedTurns
      || value.speedDurationMs < value.speedTurns) {
    performanceV1Invalid("performance_speed_method_mismatch");
  }
  if (value.speedTurns > 0) {
    if (speed.min === null || speed.max === null) performanceV1Invalid("performance_speed_extrema_missing");
    const ratio = performanceV1RateBoundsInCentiTokensPerSecond(value.speedTokens, value.speedDurationMs);
    if (ratio.floor < speed.min || ratio.ceil > speed.max) {
      performanceV1Invalid("performance_speed_sum_outside_extrema");
    }
  } else if (speed.sampleCount !== 0 || speed.min !== null || speed.max !== null) {
    performanceV1Invalid("performance_speed_histogram_nonempty");
  }
  if (value.ttftTurns === 0) {
    if (ttft.min !== null || ttft.max !== null) performanceV1Invalid("performance_ttft_extrema_nonempty");
  } else if (ttft.min === null || ttft.max === null) {
    performanceV1Invalid("performance_ttft_extrema_missing");
  }
  if (value.completionTurns === 0) {
    if (completion.min !== null || completion.max !== null) {
      performanceV1Invalid("performance_completion_extrema_nonempty");
    }
  } else if (completion.min === null || completion.max === null) {
    performanceV1Invalid("performance_completion_extrema_missing");
  }
  return value;
}

/**
 * Validate one record under a named field dictionary.  The default is the
 * dictionary this client emits, so existing callers keep their behaviour.
 */
export function parseTelemetryPerformanceRecord(
  value,
  fieldDictionaryVersion = PERFORMANCE_FIELD_DICTIONARY_VERSION,
) {
  const dictionary = performanceV1DictionaryFor(fieldDictionaryVersion);
  return performanceV1Guard(value, () => performanceV1ValidateRecord(value, dictionary));
}

/**
 * Thin reader adapter: validate under the record's own dictionary, then return
 * it with labels read in the latest vocabulary.  Every accepted dictionary is a
 * vocabulary subset of the latest, so labels map by identity.  The record keeps
 * its own bucket scheme and therefore still validates, canonicalizes and
 * digests only under `sourceFieldDictionaryVersion`; `labelVocabularyVersion`
 * names the vocabulary its labels are read in, not a dictionary it satisfies.
 * Histograms of different schemes are combined by poolPerformanceHistograms.
 * An older dictionary's `other` can include modes it did not know (0.1.24-0.1.26
 * report Ultrafast turns as `other`), so `other` is never comparable across
 * source dictionaries.
 */
export function adaptTelemetryPerformanceRecord(value, fieldDictionaryVersion) {
  const dictionary = performanceV1DictionaryFor(fieldDictionaryVersion);
  const latest = PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_LATEST_FIELD_DICTIONARY_VERSION];
  const record = performanceV1Guard(value, () => performanceV1ValidateRecord(value, dictionary));
  if (!latest.speedModes.includes(record.speedMode)
      || !latest.apiServiceTiers.includes(record.apiServiceTier)) {
    performanceV1Invalid("performance_field_dictionary_not_adaptable");
  }
  return Object.freeze({
    sourceFieldDictionaryVersion: dictionary.fieldDictionaryVersion,
    labelVocabularyVersion: latest.fieldDictionaryVersion,
    bucketSchemeVersion: record.bucketSchemeVersion,
    record: performanceV1RecordSnapshot(record, dictionary),
  });
}

function performanceV1CanonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(performanceV1CanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${performanceV1CanonicalJson(value[key])}`).join(",")}}`;
}

// The bounds/privacy walk rejects accessors and hidden fields before this
// snapshot is read.  Canonicalization then validates this one stable ordinary
// data tree, so a caller cannot change the bytes through a getter between
// validation and serialization.
function performanceV1CloneData(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(performanceV1CloneData);
  return Object.fromEntries(Object.keys(value).map((key) => [
    key,
    performanceV1CloneData(value[key]),
  ]));
}

function performanceV1StableSnapshot(value) {
  return performanceV1Guard(value, () => performanceV1CloneData(value));
}

function performanceV1HistogramSnapshot(value) {
  parsePerformanceHistogram(value);
  return {
    schemaVersion: value.schemaVersion,
    metric: value.metric,
    sampleCount: value.sampleCount,
    buckets: Object.fromEntries(Object.keys(value.buckets).map((key) => [key, value.buckets[key]])),
    min: value.min,
    max: value.max,
  };
}

function performanceV1RecordSnapshot(value, dictionary) {
  performanceV1ValidateRecord(value, dictionary);
  return Object.fromEntries(performanceV1RecordKeys.map((key) => [
    key,
    key.endsWith("Histogram") ? performanceV1HistogramSnapshot(value[key]) : value[key],
  ]));
}

/** Canonical bytes for a validated measurement record or histogram only. */
export function canonicalTelemetryPerformanceJson(
  value,
  fieldDictionaryVersion = PERFORMANCE_FIELD_DICTIONARY_VERSION,
) {
  const dictionary = performanceV1DictionaryFor(fieldDictionaryVersion);
  const stable = performanceV1StableSnapshot(value);
  const snapshot = hasTelemetryExactKeys(stable, performanceV1RecordKeys)
    ? performanceV1RecordSnapshot(stable, dictionary)
    : performanceV1HistogramSnapshot(stable);
  return performanceV1CanonicalJson(snapshot);
}

/** Measurement identity only; this carries no owner, device, or authority claim. */
export function telemetryPerformanceRowDigestInput(
  value,
  fieldDictionaryVersion = PERFORMANCE_FIELD_DICTIONARY_VERSION,
) {
  const dictionary = performanceV1DictionaryFor(fieldDictionaryVersion);
  const stable = performanceV1StableSnapshot(value);
  if (!hasTelemetryExactKeys(stable, performanceV1RecordKeys)) {
    performanceV1Invalid("performance_record_required");
  }
  return performanceV1CanonicalJson(performanceV1RecordSnapshot(stable, dictionary));
}

// ---------------------------------------------------------------------------
// Community publication.  A closed, content-free read model that mirrors the
// desktop Model performance view, computed from pooled reported samples.
// Percentiles are approximate and always carry conservative bounds; a point
// below five samples keeps only its median, as the local view does.  There is
// no contributor minimum (owner decision 2026-10-10).

export const COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION = "community-model-performance-v1";
export const COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION = "performance-histogram-pool-type7-bounds-v1";
export const COMMUNITY_MODEL_PERFORMANCE_POPULATION = "reported_samples";
export const COMMUNITY_MODEL_PERFORMANCE_PERIODS = Object.freeze(["1", "7", "30", "all"]);
export const COMMUNITY_MODEL_PERFORMANCE_INTERVALS = Object.freeze(["day", "week"]);
export const COMMUNITY_MODEL_PERFORMANCE_SPEED_MODES = Object.freeze(["standard", "fast", "ultrafast"]);
export const COMMUNITY_MODEL_PERFORMANCE_PERCENTILES = Object.freeze(["p10", "p25", "median", "p75", "p90"]);
export const MAX_COMMUNITY_MODEL_PERFORMANCE_MODELS = 64;
export const MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS = 600;
export const MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES = 16 * 1024 * 1024;

const performanceV1CommunityKeys = Object.freeze([
  "schemaVersion", "methodVersion", "population", "approximate", "revision",
  "generatedAt", "period", "interval", "start", "end", "speedMode",
  "excludedUnknownTurns", "contributors", "devices", "reports", "models",
]);
const performanceV1CommunityModelKeys = Object.freeze([
  "provider", "modelId", "turns", "speedTurns", "ttftTurns", "timedResponses",
  "toolFreeTurns", "contributors", "devices", "speed", "ttft",
]);
const performanceV1CommunitySeriesKeys = Object.freeze(["unit", "points"]);
const performanceV1CommunityPointKeys = Object.freeze([
  "day", "n", "unresolved", ...COMMUNITY_MODEL_PERFORMANCE_PERCENTILES,
]);
const performanceV1CommunityQuantileKeys = Object.freeze(["estimate", "lower", "upper"]);

function performanceV1CommunityInvalid(detail = "community_model_performance_invalid") {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", detail);
}

function performanceV1CommunityNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function performanceV1CommunityQuantile(value) {
  if (!hasTelemetryExactKeys(value, performanceV1CommunityQuantileKeys)
      || ![value.estimate, value.lower, value.upper].every(performanceV1CommunityNumber)
      || value.lower > value.estimate || value.estimate > value.upper) {
    performanceV1CommunityInvalid("community_model_performance_quantile_invalid");
  }
  return value;
}

function performanceV1CommunityPoint(value, metric) {
  if (!hasTelemetryExactKeys(value, performanceV1CommunityPointKeys)
      || !performanceV1UtcDay(value.day)
      || !Number.isSafeInteger(value.n) || value.n < 1
      || !Number.isSafeInteger(value.unresolved) || value.unresolved < 0
      || value.unresolved > value.n
      || (metric !== "speed" && value.unresolved !== 0)) {
    performanceV1CommunityInvalid("community_model_performance_point_invalid");
  }
  const banded = value.n >= 5;
  let previous = null;
  for (const name of COMMUNITY_MODEL_PERFORMANCE_PERCENTILES) {
    const quantile = value[name];
    if (quantile === null) {
      if (banded || name === "median") performanceV1CommunityInvalid("community_model_performance_band_invalid");
      continue;
    }
    if (!banded && name !== "median") performanceV1CommunityInvalid("community_model_performance_band_invalid");
    performanceV1CommunityQuantile(quantile);
    // Bounds are monotone in the percentile; allow only floating-point rounding.
    if (previous !== null
        && (quantile.lower < previous.lower - 1e-9 * Math.max(1, previous.lower)
          || quantile.upper < previous.upper - 1e-9 * Math.max(1, previous.upper))) {
      performanceV1CommunityInvalid("community_model_performance_quantile_order_invalid");
    }
    previous = quantile;
  }
  return value;
}

function performanceV1CommunityDayEpoch(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function performanceV1CommunitySeries(value, metric, unit, interval, startEpoch, endEpoch) {
  if (!hasTelemetryExactKeys(value, performanceV1CommunitySeriesKeys)
      || value.unit !== unit
      || !Array.isArray(value.points)
      || value.points.length > MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS) {
    performanceV1CommunityInvalid("community_model_performance_series_invalid");
  }
  let previousEpoch = -Infinity;
  let total = 0;
  for (const point of value.points) {
    performanceV1CommunityPoint(point, metric);
    const epoch = performanceV1CommunityDayEpoch(point.day);
    const binEnd = interval === "week" ? epoch + 6 * 86_400_000 : epoch;
    if (epoch <= previousEpoch || epoch > endEpoch || binEnd < startEpoch
        || (interval === "day" && epoch < startEpoch)
        || (interval === "week" && new Date(epoch).getUTCDay() !== 1)) {
      performanceV1CommunityInvalid("community_model_performance_point_order_invalid");
    }
    previousEpoch = epoch;
    total += point.n;
    if (!Number.isSafeInteger(total)) performanceV1CommunityInvalid();
  }
  return total;
}

function performanceV1CommunityCount(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function performanceV1CommunityModel(value, interval, startEpoch, endEpoch) {
  if (!hasTelemetryExactKeys(value, performanceV1CommunityModelKeys)
      || ![value.provider, value.modelId].every(performanceV1Token)
      || !performanceV1ReviewedModelPair(value.provider, value.modelId)
      || ![value.turns, value.speedTurns, value.ttftTurns, value.timedResponses,
        value.toolFreeTurns].every((count) => performanceV1CommunityCount(count))
      || !performanceV1CommunityCount(value.contributors, 1)
      || !performanceV1CommunityCount(value.devices, 1)
      || value.devices < value.contributors
      || value.turns < 1
      || value.speedTurns > value.turns || value.ttftTurns > value.turns
      || value.toolFreeTurns > value.speedTurns) {
    performanceV1CommunityInvalid("community_model_performance_model_invalid");
  }
  const speedSamples = performanceV1CommunitySeries(
    value.speed, "speed", "tokens_per_second", interval, startEpoch, endEpoch,
  );
  const ttftSamples = performanceV1CommunitySeries(
    value.ttft, "ttft", "milliseconds", interval, startEpoch, endEpoch,
  );
  if (speedSamples !== value.speedTurns || ttftSamples !== value.ttftTurns) {
    performanceV1CommunityInvalid("community_model_performance_count_mismatch");
  }
  return value;
}

function performanceV1CommunityValidate(value) {
  if (!hasTelemetryExactKeys(value, performanceV1CommunityKeys)
      || value.schemaVersion !== COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION
      || value.methodVersion !== COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION
      || value.population !== COMMUNITY_MODEL_PERFORMANCE_POPULATION
      || value.approximate !== true
      || !performanceV1CommunityCount(value.revision, 1)
      || !isTelemetryInstant(value.generatedAt)
      || !COMMUNITY_MODEL_PERFORMANCE_PERIODS.includes(value.period)
      || !COMMUNITY_MODEL_PERFORMANCE_INTERVALS.includes(value.interval)
      || (value.period !== "all" && value.interval !== "day")
      || !performanceV1UtcDay(value.start) || !performanceV1UtcDay(value.end)
      || value.start > value.end
      || !COMMUNITY_MODEL_PERFORMANCE_SPEED_MODES.includes(value.speedMode)
      || !performanceV1CommunityCount(value.excludedUnknownTurns)
      || ![value.contributors, value.devices, value.reports]
        .every((count) => performanceV1CommunityCount(count))
      || value.devices < value.contributors || value.reports < value.devices
      || !Array.isArray(value.models)
      || value.models.length > MAX_COMMUNITY_MODEL_PERFORMANCE_MODELS) {
    performanceV1CommunityInvalid();
  }
  const startEpoch = performanceV1CommunityDayEpoch(value.start);
  const endEpoch = performanceV1CommunityDayEpoch(value.end);
  if (value.period !== "all"
      && endEpoch - startEpoch !== (Number(value.period) - 1) * 86_400_000) {
    performanceV1CommunityInvalid("community_model_performance_window_invalid");
  }
  const seen = new Set();
  for (const model of value.models) {
    performanceV1CommunityModel(model, value.interval, startEpoch, endEpoch);
    const key = `${model.provider}\u0000${model.modelId}`;
    if (seen.has(key) || model.contributors > value.contributors || model.devices > value.devices) {
      performanceV1CommunityInvalid("community_model_performance_model_invalid");
    }
    seen.add(key);
  }
  return value;
}

/** Validate one closed community model-performance publication. */
export function parseCommunityModelPerformance(value) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_COMMUNITY_MODEL_PERFORMANCE_BYTES,
      maxDepth: 8,
      maxArrayItems: MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "community_model_performance_privacy_canary");
    }
    return performanceV1CommunityValidate(value);
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    performanceV1CommunityInvalid();
  }
}

// Published values keep three decimals.  Bounds round outward, so a rounded
// interval still contains the unrounded one, and the estimate stays inside it.
function performanceV1CommunityRoundDown(value) {
  const rounded = Math.floor(value * 1000) / 1000;
  return rounded > value ? rounded - 0.001 : rounded;
}

function performanceV1CommunityRoundUp(value) {
  const rounded = Math.ceil(value * 1000) / 1000;
  return rounded < value ? rounded + 0.001 : rounded;
}

/**
 * Build one publication point from a pool (see poolPerformanceHistograms).  The
 * caller selects which compatible records were pooled; this only projects the
 * pool's bounded quantiles into the closed point shape.
 */
export function buildCommunityModelPerformancePoint(day, pool) {
  if (!performanceV1UtcDay(day)) performanceV1CommunityInvalid("community_model_performance_point_invalid");
  const quantiles = performanceHistogramPoolQuantiles(pool);
  if (quantiles.sampleCount < 1) performanceV1CommunityInvalid("community_model_performance_point_invalid");
  const point = {
    day,
    n: quantiles.sampleCount,
    unresolved: quantiles.unresolvedCount,
    ...Object.fromEntries(COMMUNITY_MODEL_PERFORMANCE_PERCENTILES.map((name) => {
      const quantile = quantiles[name];
      if (quantile === null) return [name, null];
      const lower = Math.max(0, performanceV1CommunityRoundDown(quantile.lower));
      const upper = performanceV1CommunityRoundUp(quantile.upper);
      const estimate = Math.min(Math.max(Math.round(quantile.estimate * 1000) / 1000, lower), upper);
      return [name, { estimate, lower, upper }];
    })),
  };
  return performanceV1CommunityPoint(point, pool.metric);
}
