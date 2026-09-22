import {
  MAX_PERFORMANCE_COUNT,
  PERFORMANCE_API_SERVICE_TIERS,
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_REASONING_EFFORTS,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  buildPerformanceHistogram,
  parseTelemetryPerformanceRecord,
  reviewedModelIdentity,
  REVIEWED_MODEL_CATALOG,
} from "@app-usagemonitor/telemetry-contract";

const MAX_PERFORMANCE_ROWS = 100_000;
const MAX_PERFORMANCE_COHORTS = 1_024;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MILLISECONDS = 86_400_000;
const PERFORMANCE_COHORT_FIELDS = Object.freeze([
  "provider",
  "modelId",
  "reasoningEffort",
  "speedMethod",
  "speedMode",
  "speedModeSource",
  "apiServiceTier",
]);
const PERFORMANCE_SPEED_METHOD_SET = new Set(["receipt", "legacy"]);
const PERFORMANCE_API_SERVICE_TIER_SET = new Set(PERFORMANCE_API_SERVICE_TIERS);
const PERFORMANCE_REASONING_EFFORT_SET = new Set(PERFORMANCE_REASONING_EFFORTS);

function performanceDailyInvalid() {
  const error = new TypeError("invalid_performance_day");
  error.code = "TELEMETRY_RECORD_INVALID";
  throw error;
}

function performanceDailySafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PERFORMANCE_COUNT;
}

function performanceDailyPositiveInteger(value) {
  return performanceDailySafeInteger(value) && value > 0;
}

function performanceDailyCheckedAdd(left, right) {
  if (!performanceDailySafeInteger(left)
      || !performanceDailySafeInteger(right)
      || right > MAX_PERFORMANCE_COUNT - left) {
    performanceDailyInvalid();
  }
  return left + right;
}

function performanceDailyOwnDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}

function performanceDailySnapshotRow(value) {
  if (!performanceDailyOwnDataObject(value)) performanceDailyInvalid();
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    performanceDailyInvalid();
  }
  // Keep only the parser's bounded scalar vocabulary.  In particular, source
  // offsets, keys and private fields never cross into a daily record.
  const allowed = [
    "at", "model", "provider", "effort", "sample_method", "sample_tokens", "sample_duration",
    "sample_responses", "sample_total_responses", "ttft", "turn_duration",
    "speed_mode", "speed_mode_source", "api_service_tier", "tool_free_tokens", "tool_free_duration",
  ];
  const snapshot = Object.create(null);
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined) snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function performanceDailySnapshotRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_PERFORMANCE_ROWS) {
    performanceDailyInvalid();
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(rows);
  } catch {
    performanceDailyInvalid();
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string") performanceDailyInvalid();
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) performanceDailyInvalid();
  }
  const snapshots = [];
  for (let index = 0; index < rows.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      performanceDailyInvalid();
    }
    snapshots.push(performanceDailySnapshotRow(descriptor.value));
  }
  return snapshots;
}

function performanceDailySnapshotOptions(options) {
  if (!performanceDailyOwnDataObject(options)) performanceDailyInvalid();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const snapshot = Object.create(null);
  for (const key of ["day", "provider", "now"]) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined) snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function performanceDailyCanonicalDay(day) {
  if (typeof day !== "string" || !DAY_PATTERN.test(day)) return false;
  const epoch = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === `${day}T00:00:00.000Z`;
}

function performanceDailyValidEpoch(value) {
  return performanceDailySafeInteger(value)
    && Number.isFinite(new Date(value).getTime());
}

function performanceDailyField(row, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(row, key)) return row[key];
  }
  return undefined;
}

function performanceDailyMode(row) {
  const mode = performanceDailyField(row, "speed_mode");
  const source = performanceDailyField(row, "speed_mode_source");
  if ((mode === undefined || mode === null)
      && (source === undefined || source === null)) {
    return { speedMode: "unknown", speedModeSource: "unobserved" };
  }
  if (mode === "unknown" && source === "unobserved") {
    return { speedMode: mode, speedModeSource: source };
  }
  if (mode === "mixed" && source === "mixed") {
    return { speedMode: mode, speedModeSource: source };
  }
  if (["fast", "standard", "other"].includes(mode)
      && ["rollout_thread_settings", "turn_context_service_tier", "lineage_inherited"]
        .includes(source)) {
    return { speedMode: mode, speedModeSource: source };
  }
  return { speedMode: "unknown", speedModeSource: "unobserved" };
}

function performanceDailyApiServiceTier(row, provider) {
  // The Codex timing source deliberately has no API-tier proof.  A local
  // subscription setting must not become a hosted API service-tier claim.
  if (provider === "openai_codex") return "unknown";
  const value = performanceDailyField(row, "api_service_tier");
  return PERFORMANCE_API_SERVICE_TIER_SET.has(value) ? value : "unknown";
}

function performanceDailySpeedSample(row) {
  const checked = (method, tokens, duration, responses, totalResponses) => {
    if (!method || !performanceDailyPositiveInteger(tokens)
        || !performanceDailyPositiveInteger(duration)
        || !performanceDailyPositiveInteger(responses)
        || !performanceDailySafeInteger(totalResponses)
        || totalResponses < responses) return null;

    // BigInt keeps the fixed-point eligibility check exact even when the source
    // fields are individually safe but their scaled rate would exceed the cap.
    const centiNumerator = BigInt(tokens) * 100_000n;
    const durationInteger = BigInt(duration);
    const centiCeil = (centiNumerator + durationInteger - 1n) / durationInteger;
    if (centiCeil > BigInt(MAX_PERFORMANCE_COUNT)) return null;
    const rate = (Number(tokens) / duration) * 1_000;
    const centiRate = rate * 100;
    if (!Number.isFinite(rate) || !Number.isFinite(centiRate)
        || centiRate <= 0
        || !Number.isSafeInteger(Math.floor(centiRate))
        || !Number.isSafeInteger(Math.ceil(centiRate))) {
      return null;
    }
    return { method, tokens, duration, responses, rate };
  };

  // A turn contributes exactly one speed observation. Response timing wins
  // whenever it is eligible; the supplemental tool-free timing is only a
  // fallback for rows where the response sample is unavailable or invalid.
  const method = performanceDailyField(row, "sample_method");
  const primary = checked(
    PERFORMANCE_SPEED_METHOD_SET.has(method) ? method : null,
    performanceDailyField(row, "sample_tokens"),
    performanceDailyField(row, "sample_duration"),
    performanceDailyField(row, "sample_responses"),
    performanceDailyField(row, "sample_total_responses"),
  );
  if (primary !== null) return primary;
  const fallbackTokens = performanceDailyField(row, "tool_free_tokens")
    ?? (method === "tool_free" ? performanceDailyField(row, "sample_tokens") : undefined);
  const fallbackDuration = performanceDailyField(row, "tool_free_duration")
    ?? (method === "tool_free" ? performanceDailyField(row, "sample_duration") : undefined);
  return checked(
    "tool_free",
    fallbackTokens,
    fallbackDuration,
    1,
    1,
  );
}

function performanceDailyModel(row, provider) {
  const rawProvider = performanceDailyField(row, "provider");
  if (rawProvider !== undefined && rawProvider !== provider) return null;
  const identity = reviewedModelIdentity(performanceDailyField(row, "model"));
  if (identity === null || identity.provider !== provider) return null;
  return identity;
}

function performanceDailyRecordSort(left, right) {
  for (const field of PERFORMANCE_COHORT_FIELDS) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function performanceDailyFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) performanceDailyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Project already-qualified local timing rows into closed daily records.
 * This function performs no source scan, identity join, deduplication, or
 * upload authorization; callers supply a bounded unique row selection.
 */
export function projectTelemetryPerformanceDay(rows, options = {}) {
  const sourceRows = performanceDailySnapshotRows(rows);
  const input = performanceDailySnapshotOptions(options);
  const day = input.day;
  const provider = input.provider;
  const now = input.now;
  if (!Object.hasOwn(input, "now")
      || !performanceDailyCanonicalDay(day)
      || typeof provider !== "string"
      || !REVIEWED_MODEL_CATALOG.some((entry) => entry.provider === provider)
      || !performanceDailyValidEpoch(now)) {
    performanceDailyInvalid();
  }

  const chosenDayStart = Date.parse(`${day}T00:00:00.000Z`);
  const chosenDayEnd = chosenDayStart + DAY_MILLISECONDS;
  if (chosenDayStart > now) performanceDailyInvalid();
  const cohorts = new Map();
  for (const row of sourceRows) {
    const at = performanceDailyField(row, "at");
    if (!performanceDailyValidEpoch(at) || at > now
        || at < chosenDayStart || at >= chosenDayEnd) continue;
    const model = performanceDailyModel(row, provider);
    if (model === null) continue;
    const effortValue = performanceDailyField(row, "effort");
    const reasoningEffort = PERFORMANCE_REASONING_EFFORT_SET.has(effortValue)
      ? effortValue : "unknown";
    const speed = performanceDailySpeedSample(row);
    const speedMethod = speed?.method ?? "unavailable";
    const mode = performanceDailyMode(row);
    const apiServiceTier = performanceDailyApiServiceTier(row, provider);
    const dimensions = {
      provider,
      modelId: model.id,
      reasoningEffort,
      speedMethod,
      speedMode: mode.speedMode,
      speedModeSource: mode.speedModeSource,
      apiServiceTier,
    };
    const key = PERFORMANCE_COHORT_FIELDS.map((field) => dimensions[field]).join("\u0000");
    let cohort = cohorts.get(key);
    if (cohort === undefined) {
      if (cohorts.size >= MAX_PERFORMANCE_COHORTS) performanceDailyInvalid();
      cohort = {
        ...dimensions,
        turns: 0,
        speedTurns: 0,
        ttftTurns: 0,
        completionTurns: 0,
        timedResponses: 0,
        speedTokens: 0,
        speedDurationMs: 0,
        speedValues: [],
        ttftValues: [],
        completionValues: [],
      };
      cohorts.set(key, cohort);
    }
    cohort.turns = performanceDailyCheckedAdd(cohort.turns, 1);
    if (speed !== null) {
      cohort.speedTurns = performanceDailyCheckedAdd(cohort.speedTurns, 1);
      cohort.timedResponses = performanceDailyCheckedAdd(cohort.timedResponses, speed.responses);
      cohort.speedTokens = performanceDailyCheckedAdd(cohort.speedTokens, speed.tokens);
      cohort.speedDurationMs = performanceDailyCheckedAdd(cohort.speedDurationMs, speed.duration);
      cohort.speedValues.push(speed.rate);
    }
    const ttft = performanceDailyField(row, "ttft");
    if (performanceDailySafeInteger(ttft)) {
      cohort.ttftTurns = performanceDailyCheckedAdd(cohort.ttftTurns, 1);
      cohort.ttftValues.push(ttft);
    }
    const completion = performanceDailyField(row, "turn_duration");
    if (performanceDailyPositiveInteger(completion)) {
      cohort.completionTurns = performanceDailyCheckedAdd(cohort.completionTurns, 1);
      cohort.completionValues.push(completion);
    }
  }

  const records = [...cohorts.values()]
    .sort(performanceDailyRecordSort)
    .map((cohort) => {
      const record = {
        schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
        day,
        provider: cohort.provider,
        modelId: cohort.modelId,
        reasoningEffort: cohort.reasoningEffort,
        speedMethod: cohort.speedMethod,
        speedMode: cohort.speedMode,
        speedModeSource: cohort.speedModeSource,
        apiServiceTier: cohort.apiServiceTier,
        measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
        bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION,
        turns: cohort.turns,
        speedTurns: cohort.speedTurns,
        ttftTurns: cohort.ttftTurns,
        completionTurns: cohort.completionTurns,
        timedResponses: cohort.timedResponses,
        speedTokens: cohort.speedTokens,
        speedDurationMs: cohort.speedDurationMs,
        speedHistogram: buildPerformanceHistogram("speed", cohort.speedValues),
        ttftHistogram: buildPerformanceHistogram("ttft", cohort.ttftValues),
        completionHistogram: buildPerformanceHistogram("turnDuration", cohort.completionValues),
      };
      // Validation goes through the package's public facade so this projector
      // cannot drift from the staged allowlisted record contract.
      parseTelemetryPerformanceRecord(record);
      return performanceDailyFreeze(record);
    });
  return Object.freeze(records);
}
