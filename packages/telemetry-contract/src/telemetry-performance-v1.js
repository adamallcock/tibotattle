import { isTelemetryContractError, telemetryContractFailure } from "./errors.js";
import { REVIEWED_MODEL_CATALOG } from "./model-catalog.js";
import { parsePerformanceHistogram } from "./performance-histogram.js";
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
export const PERFORMANCE_FIELD_DICTIONARY_VERSION =
  "telemetry-performance-registry-2026-09-21.1";
export const PERFORMANCE_PRIVACY_CONTRACT_VERSION =
  "privacy-safe-model-performance-v1";
export const PERFORMANCE_CONTRACT_STATE = "staged";
export const PERFORMANCE_HISTOGRAM_SCHEMA_VERSION = "performance-histogram-v1";
export const MAX_PERFORMANCE_RECORD_CANONICAL_BYTES = 32 * 1024;
export const MAX_PERFORMANCE_HISTOGRAM_BUCKETS = 61;
export const MAX_PERFORMANCE_COUNT = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_TTFT_MILLISECONDS = Number.MAX_SAFE_INTEGER;
export const MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS = Number.MAX_SAFE_INTEGER;

export const PERFORMANCE_SPEED_METHODS = Object.freeze([
  "receipt", "legacy", "tool_free", "unavailable",
]);
export const PERFORMANCE_SPEED_MODES = Object.freeze([
  "fast", "standard", "unknown", "other", "mixed",
]);
export const PERFORMANCE_SPEED_MODE_SOURCES = Object.freeze([
  "rollout_thread_settings", "lineage_inherited", "unobserved", "mixed",
]);
export const PERFORMANCE_API_SERVICE_TIERS = Object.freeze([
  "standard", "priority", "flex", "batch", "unknown", "other", "mixed",
]);
export const PERFORMANCE_REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);

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

function performanceV1ValidateRecord(value) {
  if (!hasTelemetryExactKeys(value, performanceV1RecordKeys)
      || value.schemaVersion !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || !performanceV1UtcDay(value.day)
      || ![value.provider, value.modelId].every(performanceV1Token)
      || !performanceV1ReviewedModelPair(value.provider, value.modelId)
      || !PERFORMANCE_REASONING_EFFORTS.includes(value.reasoningEffort)
      || !PERFORMANCE_SPEED_METHODS.includes(value.speedMethod)
      || !PERFORMANCE_SPEED_MODES.includes(value.speedMode)
      || !PERFORMANCE_SPEED_MODE_SOURCES.includes(value.speedModeSource)
      || !PERFORMANCE_API_SERVICE_TIERS.includes(value.apiServiceTier)
      || value.measurementVersion !== PERFORMANCE_MEASUREMENT_VERSION
      || value.bucketSchemeVersion !== PERFORMANCE_BUCKET_SCHEME_VERSION
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
      || (["fast", "standard", "other"].includes(value.speedMode)
        && !["rollout_thread_settings", "lineage_inherited"].includes(value.speedModeSource))) {
    performanceV1Invalid("performance_speed_mode_source_mismatch");
  }
  const speed = parsePerformanceHistogram(value.speedHistogram);
  const ttft = parsePerformanceHistogram(value.ttftHistogram);
  const completion = parsePerformanceHistogram(value.completionHistogram);
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

export function parseTelemetryPerformanceRecord(value) {
  return performanceV1Guard(value, () => performanceV1ValidateRecord(value));
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

function performanceV1RecordSnapshot(value) {
  performanceV1ValidateRecord(value);
  return Object.fromEntries(performanceV1RecordKeys.map((key) => [
    key,
    key.endsWith("Histogram") ? performanceV1HistogramSnapshot(value[key]) : value[key],
  ]));
}

/** Canonical bytes for a validated measurement record or histogram only. */
export function canonicalTelemetryPerformanceJson(value) {
  const stable = performanceV1StableSnapshot(value);
  const snapshot = hasTelemetryExactKeys(stable, performanceV1RecordKeys)
    ? performanceV1RecordSnapshot(stable)
    : performanceV1HistogramSnapshot(stable);
  return performanceV1CanonicalJson(snapshot);
}

/** Measurement identity only; this carries no owner, device, or authority claim. */
export function telemetryPerformanceRowDigestInput(value) {
  const stable = performanceV1StableSnapshot(value);
  if (!hasTelemetryExactKeys(stable, performanceV1RecordKeys)) {
    performanceV1Invalid("performance_record_required");
  }
  return performanceV1CanonicalJson(performanceV1RecordSnapshot(stable));
}
