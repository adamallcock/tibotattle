import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

import * as canonical from "../packages/telemetry-contract/index.js";
import {
  COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION,
  COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION,
  MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS,
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_BUCKET_SCHEME_VERSION_V2,
  PERFORMANCE_CONTRACT_STATE,
  PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION,
  PERFORMANCE_FIELD_DICTIONARIES,
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10,
  PERFORMANCE_LATEST_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  adaptTelemetryPerformanceRecord,
  buildCommunityModelPerformancePoint,
  buildPerformanceHistogram,
  canonicalTelemetryPerformanceJson,
  parseCommunityModelPerformance,
  parseTelemetryPerformanceRecord,
  poolPerformanceHistograms,
  telemetryPerformanceRowDigestInput,
} from "../packages/telemetry-contract/index.js";
import { telemetryPerformanceJsonSchemas } from "../packages/telemetry-contract/src/telemetry-performance-v1-schemas.js";
import { parseTelemetryV12Record, telemetryV12RequiredConsent } from "../packages/telemetry-contract/index.js";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";

const DAY = "2026-09-20";

function speedHistogram(values = [50, 50]) {
  return buildPerformanceHistogram("speed", values);
}

function ttftHistogram(values = [500]) {
  return buildPerformanceHistogram("ttft", values);
}

function completionHistogram(values = [1000, 1200]) {
  return buildPerformanceHistogram("turnDuration", values);
}

function performanceRecord(overrides = {}) {
  return {
    schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
    day: DAY,
    provider: "openai_codex",
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
    speedMethod: "receipt",
    speedMode: "standard",
    speedModeSource: "rollout_thread_settings",
    apiServiceTier: "standard",
    measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
    bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION,
    turns: 2,
    speedTurns: 2,
    ttftTurns: 1,
    completionTurns: 2,
    timedResponses: 2,
    speedTokens: 100,
    speedDurationMs: 2000,
    speedHistogram: speedHistogram(),
    ttftHistogram: ttftHistogram(),
    completionHistogram: completionHistogram(),
    ...overrides,
  };
}

function v2Record(overrides = {}) {
  return performanceRecord({
    bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION_V2,
    speedTokens: 600,
    speedDurationMs: 2000,
    speedHistogram: buildPerformanceHistogram("speed", [250, 350], PERFORMANCE_BUCKET_SCHEME_VERSION_V2),
    ttftHistogram: buildPerformanceHistogram("ttft", [500], PERFORMANCE_BUCKET_SCHEME_VERSION_V2),
    completionHistogram: buildPerformanceHistogram("turnDuration", [1000, 1200], PERFORMANCE_BUCKET_SCHEME_VERSION_V2),
    ...overrides,
  });
}

function speedPoint(day, values) {
  return buildCommunityModelPerformancePoint(day, poolPerformanceHistograms([
    buildPerformanceHistogram("speed", values),
  ]));
}

function ttftPoint(day, values) {
  return buildCommunityModelPerformancePoint(day, poolPerformanceHistograms([
    buildPerformanceHistogram("ttft", values),
  ]));
}

function communityPublication(overrides = {}) {
  const speed = [
    speedPoint("2026-10-08", [40, 42, 44, 46, 48, 50]),
    speedPoint("2026-10-10", [41, 130]),
  ];
  const ttft = [ttftPoint("2026-10-08", [800, 900, 1000, 1100, 1200])];
  return {
    schemaVersion: COMMUNITY_MODEL_PERFORMANCE_SCHEMA_VERSION,
    methodVersion: COMMUNITY_MODEL_PERFORMANCE_METHOD_VERSION,
    population: "reported_samples",
    approximate: true,
    revision: 3,
    generatedAt: "2026-10-11T01:00:00.000Z",
    period: "7",
    interval: "day",
    start: "2026-10-04",
    end: "2026-10-10",
    speedMode: "standard",
    excludedUnknownTurns: 4,
    contributors: 2,
    devices: 3,
    reports: 9,
    models: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-luna",
      turns: 9,
      speedTurns: 8,
      ttftTurns: 5,
      timedResponses: 7,
      toolFreeTurns: 1,
      contributors: 2,
      devices: 2,
      speed: { unit: "tokens_per_second", points: speed },
      ttft: { unit: "milliseconds", points: ttft },
    }],
    ...overrides,
  };
}

function expectPublicationInvalid(value, label) {
  assert.throws(
    () => parseCommunityModelPerformance(value),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID"
      || error?.code === "PRIVACY_CANARY_DETECTED",
    label,
  );
}

function expectInvalid(value, label, fieldDictionaryVersion = PERFORMANCE_FIELD_DICTIONARY_VERSION) {
  let failure = null;
  assert.throws(
    () => parseTelemetryPerformanceRecord(value, fieldDictionaryVersion),
    (error) => {
      failure = error;
      return error?.code === "TELEMETRY_RECORD_INVALID"
        || error?.code === "PRIVACY_CANARY_DETECTED";
    },
    label,
  );
  return failure;
}

// One fixture kit per registered dictionary: the base record and every
// histogram use that dictionary's own bucket scheme, so an invalid case built
// from the kit can fail only for the property it changes.
function dictionaryKit(fieldDictionaryVersion) {
  const scheme = PERFORMANCE_FIELD_DICTIONARIES[fieldDictionaryVersion].bucketSchemeVersion;
  const histogram = (metric, values) => buildPerformanceHistogram(metric, values, scheme);
  const speed = (values = [50, 50]) => histogram("speed", values);
  const ttft = (values = [500]) => histogram("ttft", values);
  const completion = (values = [1000, 1200]) => histogram("turnDuration", values);
  const record = (overrides = {}) => performanceRecord({
    bucketSchemeVersion: scheme,
    speedHistogram: speed(),
    ttftHistogram: ttft(),
    completionHistogram: completion(),
    ...overrides,
  });
  return { fieldDictionaryVersion, scheme, record, speed, ttft, completion };
}

const SCHEME_MISMATCH_DETAIL = "performance_histogram_scheme_mismatch";
const RECORD_INVALID = "performance_record_invalid";
const SOURCE_MISMATCH = "performance_speed_mode_source_mismatch";

// Each case names the detail it must fail with.  A function detail varies by
// dictionary only where the dictionary's vocabulary legitimately differs.
const INVALID_RECORD_CASES = Object.freeze([
  ["unknown top-level key", (kit) => ({ ...kit.record(), extra: 1 }), RECORD_INVALID],
  ["privacy canary", (kit) => ({ ...kit.record(), prompt: "private-synthetic-canary" }), "performance_privacy_canary"],
  ["invalid UTC day", (kit) => kit.record({ day: "2026-02-29" }), RECORD_INVALID],
  ["unreviewed provider/model", (kit) => kit.record({ provider: "private_provider", modelId: "private_model" }), RECORD_INVALID],
  ["cross-provider model", (kit) => kit.record({ provider: "anthropic_claude_code", modelId: "gpt-5.6-luna" }), RECORD_INVALID],
  ["unknown mode requires unobserved source", (kit) => kit.record({ speedMode: "unknown", speedModeSource: "mixed" }), SOURCE_MISMATCH],
  ["mixed mode requires mixed source", (kit) => kit.record({ speedMode: "mixed", speedModeSource: "unobserved" }), SOURCE_MISMATCH],
  ["known mode requires evidence source", (kit) => kit.record({ speedMode: "standard", speedModeSource: "unobserved" }), SOURCE_MISMATCH],
  ["fast mode requires own or inherited evidence", (kit) => kit.record({ speedMode: "fast", speedModeSource: "mixed" }), SOURCE_MISMATCH],
  // 2026-09-21.1 has no Ultrafast at all, so its vocabulary refuses first.
  ["ultrafast requires observed evidence", (kit) => kit.record({ speedMode: "ultrafast", speedModeSource: "unobserved" }),
    (kit) => (PERFORMANCE_FIELD_DICTIONARIES[kit.fieldDictionaryVersion].speedModes.includes("ultrafast")
      ? SOURCE_MISMATCH : RECORD_INVALID)],
  ["unreviewed speed mode", (kit) => kit.record({ speedMode: "ultrafast-private" }), RECORD_INVALID],
  ["unknown reasoning effort", (kit) => kit.record({ reasoningEffort: "not-known" }), RECORD_INVALID],
  ["unknown speed method", (kit) => kit.record({ speedMethod: "inferred" }), RECORD_INVALID],
  ["unknown measurement version", (kit) => kit.record({ measurementVersion: "model-performance-samples-v0" }), RECORD_INVALID],
  ["non-positive cohort", (kit) => kit.record({ turns: 0 }), RECORD_INVALID],
  ["receipt cohort must cover all turns", (kit) => kit.record({ speedTurns: 1 }), "performance_histogram_count_mismatch"],
  ["speed metric mismatch", (kit) => kit.record({ speedHistogram: kit.ttft() }), "performance_histogram_count_mismatch"],
  ["TTFT metric mismatch", (kit) => kit.record({ ttftHistogram: kit.speed() }), "performance_histogram_count_mismatch"],
  ["completion metric mismatch", (kit) => kit.record({ completionHistogram: kit.ttft() }), "performance_histogram_count_mismatch"],
  ["completion cohort cannot exceed turns", (kit) => kit.record({ completionTurns: 3 }), RECORD_INVALID],
  ["zero completion cohort must have empty histogram",
    (kit) => kit.record({ completionTurns: 0, completionHistogram: kit.completion() }), "performance_histogram_count_mismatch"],
  ["positive completion cohort must have samples",
    (kit) => kit.record({ completionTurns: 1, completionHistogram: kit.completion([]) }), "performance_histogram_count_mismatch"],
  ["summed speed ratio outside extrema", (kit) => kit.record({ speedTokens: 10 }), "performance_speed_sum_outside_extrema"],
  ["unavailable speed must have no timed response", (kit) => kit.record({
    speedMethod: "unavailable",
    speedTurns: 0,
    timedResponses: 1,
    speedTokens: 0,
    speedDurationMs: 0,
    speedHistogram: kit.speed([]),
  }), "performance_speed_unavailable_mismatch"],
  ["empty TTFT cohort must have empty histogram",
    (kit) => kit.record({ ttftTurns: 0, ttftHistogram: kit.ttft([0]) }), "performance_histogram_count_mismatch"],
  ["accessor-backed record", (kit) => {
    const value = kit.record();
    Object.defineProperty(value, "turns", { enumerable: true, configurable: true, get: () => 2 });
    return value;
  }, "accessor_or_hidden_field"],
]);

function v12Usage(overrides = {}) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: "event:v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    eventTime: `${DAY}T12:00:00.000Z`,
    sessionUuid: "session-fixture-1",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "unknown",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "unknown",
    totalInputContextTokens: 100,
    components: {
      inputUncachedTokens: 90,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 10,
      outputTextTokens: 10,
      outputReasoningTokens: 5,
      outputCombinedTokens: 15,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "unavailable",
      planType: "unknown",
      planEraId: null,
    },
    boundaryFlags: 0,
    tieOrder: 0,
    cacheWriteTtl: { fiveMinuteTokens: 4, oneHourTokens: 6 },
    ...overrides,
  };
}

test("staged performance contract exports and browser mirror stay in lockstep", () => {
  assert.equal(PERFORMANCE_CONTRACT_STATE, "staged");
  assert.deepEqual(Object.keys(browser), Object.keys(canonical));
  const record = performanceRecord();
  assert.deepEqual(
    browser.parseTelemetryPerformanceRecord(record),
    parseTelemetryPerformanceRecord(record),
  );
  assert.equal(
    browser.canonicalTelemetryPerformanceJson(record),
    canonicalTelemetryPerformanceJson(record),
  );
  assert.deepEqual(
    browser.buildPerformanceHistogram("ttft", [0, 500]),
    buildPerformanceHistogram("ttft", [0, 500]),
  );
  assert.deepEqual(
    browser.buildPerformanceHistogram("turnDuration", [1000, 1200]),
    buildPerformanceHistogram("turnDuration", [1000, 1200]),
  );
  const v2 = v2Record();
  assert.deepEqual(
    browser.adaptTelemetryPerformanceRecord(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10),
    adaptTelemetryPerformanceRecord(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10),
  );
  const publication = communityPublication();
  assert.deepEqual(
    browser.parseCommunityModelPerformance(publication),
    parseCommunityModelPerformance(publication),
  );
});

test("performance daily cohorts preserve the closed measurement shape", () => {
  const record = performanceRecord();
  assert.equal(parseTelemetryPerformanceRecord(record), record);
  const claude = performanceRecord({
    provider: "anthropic_claude_code",
    modelId: "claude-sonnet-5",
    speedMode: "fast",
    speedModeSource: "lineage_inherited",
    apiServiceTier: "priority",
  });
  assert.equal(parseTelemetryPerformanceRecord(claude), claude);
  const turnContext = performanceRecord({
    speedMode: "fast",
    speedModeSource: "turn_context_service_tier",
  });
  assert.equal(parseTelemetryPerformanceRecord(turnContext), turnContext);
  for (const speedModeSource of ["rollout_thread_settings", "turn_context_service_tier", "lineage_inherited"]) {
    const ultrafast = performanceRecord({ speedMode: "ultrafast", speedModeSource, apiServiceTier: "ultrafast" });
    assert.equal(parseTelemetryPerformanceRecord(ultrafast), ultrafast);
    assert.deepEqual(browser.parseTelemetryPerformanceRecord(ultrafast), ultrafast);
  }
  const mixed = performanceRecord({
    speedMode: "mixed",
    speedModeSource: "mixed",
    apiServiceTier: "flex",
  });
  assert.equal(parseTelemetryPerformanceRecord(mixed), mixed);
  const other = performanceRecord({
    speedMode: "other",
    speedModeSource: "rollout_thread_settings",
    apiServiceTier: "mixed",
  });
  assert.equal(parseTelemetryPerformanceRecord(other), other);
  const unavailable = performanceRecord({
    speedMethod: "unavailable",
    turns: 3,
    speedTurns: 0,
    ttftTurns: 1,
    completionTurns: 3,
    timedResponses: 0,
    speedTokens: 0,
    speedDurationMs: 0,
    speedHistogram: speedHistogram([]),
    ttftHistogram: ttftHistogram([0]),
    completionHistogram: completionHistogram([1000, 1200, 1400]),
  });
  assert.equal(parseTelemetryPerformanceRecord(unavailable), unavailable);
  assert.equal(unavailable.speedHistogram.min, null);
  assert.equal(unavailable.ttftHistogram.min, 0);
  assert.equal(unavailable.completionHistogram.min, 1000);
});

test("performance validation rejects privacy, version, bounds, and relation violations", () => {
  for (const [label, build, detail] of INVALID_RECORD_CASES) {
    const failure = expectInvalid(build(dictionaryKit(PERFORMANCE_FIELD_DICTIONARY_VERSION)), label);
    assert.equal(failure.detailCode, typeof detail === "function"
      ? detail(dictionaryKit(PERFORMANCE_FIELD_DICTIONARY_VERSION)) : detail, label);
  }
});

test("every invalid case fails for its own reason under each dictionary, never only for its scheme", () => {
  for (const fieldDictionaryVersion of Object.keys(PERFORMANCE_FIELD_DICTIONARIES)) {
    const kit = dictionaryKit(fieldDictionaryVersion);
    // The kit's base record is valid under this dictionary, so no case below
    // can owe its failure to a scheme the dictionary does not pair with.
    const base = kit.record();
    assert.equal(parseTelemetryPerformanceRecord(base, fieldDictionaryVersion), base, fieldDictionaryVersion);
    for (const [label, build, detail] of INVALID_RECORD_CASES) {
      const value = build(kit);
      for (const key of ["speedHistogram", "ttftHistogram", "completionHistogram"]) {
        assert.equal(value[key].schemaVersion, kit.scheme, `${fieldDictionaryVersion}: ${label}: ${key} scheme`);
      }
      assert.equal(value.bucketSchemeVersion, kit.scheme, `${fieldDictionaryVersion}: ${label}: record scheme`);
      const failure = expectInvalid(value, `${fieldDictionaryVersion}: ${label}`, fieldDictionaryVersion);
      assert.notEqual(failure.detailCode, SCHEME_MISMATCH_DETAIL, `${fieldDictionaryVersion}: ${label}`);
      assert.equal(failure.detailCode, typeof detail === "function" ? detail(kit) : detail,
        `${fieldDictionaryVersion}: ${label}`);
    }
  }
});

test("canonical performance bytes are deterministic, private-free, and accessor-safe", () => {
  const record = performanceRecord();
  const reordered = {
    ...record,
    speedHistogram: { ...record.speedHistogram, buckets: { ...record.speedHistogram.buckets } },
  };
  assert.equal(canonicalTelemetryPerformanceJson(record), canonicalTelemetryPerformanceJson(reordered));
  assert.equal(telemetryPerformanceRowDigestInput(record), canonicalTelemetryPerformanceJson(record));
  assert.equal(canonicalTelemetryPerformanceJson(speedHistogram()),
    canonicalTelemetryPerformanceJson({ ...speedHistogram() }));
  assert.throws(
    () => telemetryPerformanceRowDigestInput(speedHistogram()),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID",
    "row digest input requires a daily performance record",
  );

  const accessor = { ...record };
  Object.defineProperty(accessor, "turns", {
    enumerable: true,
    configurable: true,
    get() {
      return 2;
    },
  });
  expectInvalid(accessor, "accessor-backed record");
  assert.throws(() => canonicalTelemetryPerformanceJson(accessor), /accessor|ordinary|invalid/i);
});

test("performance JSON Schemas express closed shape and simple runtime relations", () => {
  const schemas = telemetryPerformanceJsonSchemas();
  assert.deepEqual(Object.keys(schemas).sort(), [
    "performance-histogram.schema.json",
    "performance-record.schema.json",
  ]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(schemas["performance-histogram.schema.json"]);
  const validateHistogram = ajv.getSchema(schemas["performance-histogram.schema.json"].$id);
  const validateRecord = ajv.compile(schemas["performance-record.schema.json"]);
  assert.equal(validateHistogram(speedHistogram()), true);
  assert.equal(validateHistogram(completionHistogram()), true);
  assert.equal(validateHistogram({ ...completionHistogram(), buckets: { 0: 1 }, min: 0, max: 0 }), false);
  assert.equal(validateHistogram({ ...speedHistogram(), min: null }), false);
  assert.equal(validateRecord(performanceRecord()), true);
  for (const speedMode of ["standard", "fast", "ultrafast", "other"]) {
    const record = performanceRecord({ speedMode, speedModeSource: "turn_context_service_tier", apiServiceTier: "ultrafast" });
    assert.equal(validateRecord(record), true, JSON.stringify(validateRecord.errors));
    assert.equal(parseTelemetryPerformanceRecord(record), record);
  }
  assert.equal(validateRecord(performanceRecord({ speedMode: "ultrafast", speedModeSource: "unobserved" })), false);
  assert.equal(validateRecord(performanceRecord({
    provider: "anthropic_claude_code",
    modelId: "claude-sonnet-5",
  })), true);
  assert.equal(validateRecord(performanceRecord({
    provider: "private_provider",
    modelId: "private_model",
  })), false);
  assert.equal(validateRecord(performanceRecord({
    provider: "anthropic_claude_code",
    modelId: "gpt-5.6-luna",
  })), false);
  assert.equal(validateRecord({
    ...performanceRecord(),
    speedHistogram: { ...performanceRecord().speedHistogram, sampleCount: 1, buckets: {}, min: null, max: null },
  }), false);
  assert.equal(validateRecord(performanceRecord({
    speedMode: "unknown",
    speedModeSource: "unobserved",
    apiServiceTier: "batch",
  })), true);
  assert.equal(validateRecord(performanceRecord({
    speedMode: "unknown",
    speedModeSource: "mixed",
  })), false);
  assert.equal(validateRecord(performanceRecord({
    completionTurns: 0,
    completionHistogram: completionHistogram(),
  })), false);
  assert.equal(validateRecord(performanceRecord({
    completionTurns: 1,
    completionHistogram: completionHistogram([]),
  })), false);
  assert.equal(validateRecord({
    ...performanceRecord(),
    speedMethod: "unavailable",
    speedTurns: 0,
    timedResponses: 0,
    speedTokens: 0,
    speedDurationMs: 0,
    speedHistogram: speedHistogram([50]),
  }), false);
  assert.equal(validateRecord(performanceRecord({ turns: 0 })), false);
  assert.equal(validateRecord(performanceRecord({ speedHistogram: ttftHistogram() })), false);
  assert.equal(validateRecord(performanceRecord({
    speedMethod: "unavailable",
    speedTurns: 0,
    timedResponses: 0,
    speedTokens: 0,
    speedDurationMs: 0,
    speedHistogram: speedHistogram([]),
  })), true);
});

test("performance additions do not widen the frozen v1.2 usage record", () => {
  const value = v12Usage();
  assert.doesNotThrow(() => parseTelemetryV12Record("usage", value));
  assert.throws(() => parseTelemetryV12Record("usage", {
    ...value,
    speedHistogram: speedHistogram(),
  }));
  assert.equal(telemetryV12RequiredConsent().telemetrySchemaVersion, "telemetry-contribution-v1.2");
});

test("every accepted field dictionary is registered with its bucket scheme", () => {
  assert.equal(PERFORMANCE_FIELD_DICTIONARY_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29);
  assert.equal(PERFORMANCE_LATEST_FIELD_DICTIONARY_VERSION, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10);
  assert.deepEqual(Object.keys(PERFORMANCE_FIELD_DICTIONARIES), [
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21,
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29,
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10,
  ]);
  const [legacy, current, next] = Object.values(PERFORMANCE_FIELD_DICTIONARIES);
  // 2026-10-10.1 is accepted server first, before any released client emits it.
  assert.deepEqual([legacy.state, current.state, next.state], ["accepted", "accepted", "accepted"]);
  assert.deepEqual(
    [legacy.bucketSchemeVersion, current.bucketSchemeVersion, next.bucketSchemeVersion],
    [PERFORMANCE_BUCKET_SCHEME_VERSION, PERFORMANCE_BUCKET_SCHEME_VERSION, PERFORMANCE_BUCKET_SCHEME_VERSION_V2],
  );
  // PERFORMANCE_BUCKET_SCHEME_VERSION keeps meaning v1; the emitted scheme is
  // derived from the emitted dictionary's registry pairing.
  assert.equal(PERFORMANCE_BUCKET_SCHEME_VERSION, "performance-histogram-v1");
  assert.equal(
    PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION,
    PERFORMANCE_FIELD_DICTIONARIES[PERFORMANCE_FIELD_DICTIONARY_VERSION].bucketSchemeVersion,
  );
  assert.equal(PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION, PERFORMANCE_BUCKET_SCHEME_VERSION);
  assert.equal(canonical.PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION, PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION);
  assert.equal(browser.PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION, PERFORMANCE_EMITTED_BUCKET_SCHEME_VERSION);
  assert.equal(legacy.speedModes.includes("ultrafast"), false);
  assert.equal(legacy.apiServiceTiers.includes("ultrafast"), false);
  for (const dictionary of [legacy, current]) {
    assert.ok(dictionary.speedModes.every((mode) => next.speedModes.includes(mode)));
    assert.ok(dictionary.apiServiceTiers.every((tier) => next.apiServiceTiers.includes(tier)));
  }
  assert.ok(Object.isFrozen(PERFORMANCE_FIELD_DICTIONARIES) && Object.isFrozen(legacy.speedModes));
});

test("records validate under their own dictionary and bucket scheme only", () => {
  const ultrafast = performanceRecord({ speedMode: "ultrafast", apiServiceTier: "ultrafast" });
  assert.equal(parseTelemetryPerformanceRecord(ultrafast, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29), ultrafast);
  assert.equal(parseTelemetryPerformanceRecord(ultrafast), ultrafast, "the default dictionary accepts ultrafast");
  assert.throws(() => parseTelemetryPerformanceRecord(ultrafast, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  assert.throws(() => parseTelemetryPerformanceRecord(
    performanceRecord({ apiServiceTier: "ultrafast" }), PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21,
  ), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  const v2 = v2Record({ speedMode: "ultrafast", speedModeSource: "turn_context_service_tier" });
  assert.equal(parseTelemetryPerformanceRecord(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10), v2);
  for (const version of [PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29]) {
    assert.throws(() => parseTelemetryPerformanceRecord(v2, version), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  }
  assert.throws(() => parseTelemetryPerformanceRecord(performanceRecord(), PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  // A record cannot mix schemes between its label and its histograms.
  assert.throws(() => parseTelemetryPerformanceRecord(
    v2Record({ ttftHistogram: ttftHistogram() }), PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10,
  ), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  for (const version of [null, "telemetry-performance-registry-2099-01-01.1", "__proto__", "toString"]) {
    assert.throws(() => parseTelemetryPerformanceRecord(performanceRecord(), version),
      (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  }
});

test("the thin adapter maps every accepted dictionary to the latest vocabulary by identity", () => {
  const legacy = performanceRecord({ speedMode: "fast", speedModeSource: "turn_context_service_tier" });
  const adapted = adaptTelemetryPerformanceRecord(legacy, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21);
  assert.deepEqual(Object.keys(adapted).sort(), [
    "bucketSchemeVersion", "labelVocabularyVersion", "record", "sourceFieldDictionaryVersion",
  ]);
  assert.equal(adapted.sourceFieldDictionaryVersion, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21);
  assert.equal(adapted.labelVocabularyVersion, PERFORMANCE_LATEST_FIELD_DICTIONARY_VERSION);
  // The adapted record still validates and digests under its source dictionary.
  assert.deepEqual(parseTelemetryPerformanceRecord(adapted.record, adapted.sourceFieldDictionaryVersion), legacy);
  assert.equal(
    canonicalTelemetryPerformanceJson(adapted.record, adapted.sourceFieldDictionaryVersion),
    canonicalTelemetryPerformanceJson(legacy, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21),
  );
  assert.equal(adapted.bucketSchemeVersion, PERFORMANCE_BUCKET_SCHEME_VERSION);
  assert.deepEqual(adapted.record, legacy);
  assert.notEqual(adapted.record, legacy);
  assert.ok(Object.isFrozen(adapted));
  const v2 = v2Record();
  const adaptedV2 = adaptTelemetryPerformanceRecord(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10);
  assert.equal(adaptedV2.bucketSchemeVersion, PERFORMANCE_BUCKET_SCHEME_VERSION_V2);
  assert.deepEqual(adaptedV2.record, v2);
  assert.throws(() => adaptTelemetryPerformanceRecord(
    performanceRecord({ speedMode: "ultrafast", apiServiceTier: "ultrafast" }),
    PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21,
  ), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  assert.throws(() => adaptTelemetryPerformanceRecord(legacy), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
  assert.throws(() => adaptTelemetryPerformanceRecord({ ...legacy, prompt: "x" }, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21),
    (error) => ["TELEMETRY_RECORD_INVALID", "PRIVACY_CANARY_DETECTED"].includes(error?.code));
});

test("canonical bytes and row digests accept a named dictionary without changing default bytes", () => {
  const record = performanceRecord();
  assert.equal(
    canonicalTelemetryPerformanceJson(record, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21),
    canonicalTelemetryPerformanceJson(record),
  );
  const v2 = v2Record();
  assert.match(canonicalTelemetryPerformanceJson(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10), /performance-histogram-v2/u);
  assert.equal(
    telemetryPerformanceRowDigestInput(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10),
    canonicalTelemetryPerformanceJson(v2, PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10),
  );
  assert.throws(() => canonicalTelemetryPerformanceJson(v2), (error) => error?.code === "TELEMETRY_RECORD_INVALID");
});

test("v2 records satisfy the generated JSON Schemas and cannot mix schemes", () => {
  const schemas = telemetryPerformanceJsonSchemas();
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(schemas["performance-histogram.schema.json"]);
  const validateHistogram = ajv.getSchema(schemas["performance-histogram.schema.json"].$id);
  const validateRecord = ajv.compile(schemas["performance-record.schema.json"]);
  const top = buildPerformanceHistogram("speed", [5000], PERFORMANCE_BUCKET_SCHEME_VERSION_V2);
  assert.equal(validateHistogram(top), true, JSON.stringify(validateHistogram.errors));
  assert.equal(validateHistogram({ ...top, schemaVersion: PERFORMANCE_BUCKET_SCHEME_VERSION }), false);
  assert.equal(validateHistogram({ ...top, buckets: { 96: 1 } }), false);
  assert.equal(validateRecord(v2Record()), true, JSON.stringify(validateRecord.errors));
  assert.equal(validateRecord(v2Record({ ttftHistogram: ttftHistogram() })), false);
  assert.equal(validateRecord(performanceRecord({ bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION_V2 })), false);
});

test("community publications are closed, bounded, and carry percentile bounds", () => {
  const publication = communityPublication();
  assert.equal(parseCommunityModelPerformance(publication), publication);
  const [banded, sparse] = publication.models[0].speed.points;
  assert.equal(banded.n, 6);
  assert.ok(["p10", "p25", "median", "p75", "p90"].every((name) => banded[name] !== null));
  assert.equal(sparse.n, 2);
  assert.equal(sparse.unresolved, 1);
  assert.deepEqual([sparse.p10, sparse.p25, sparse.p75, sparse.p90], [null, null, null, null]);
  assert.ok(sparse.median.lower <= sparse.median.estimate && sparse.median.estimate <= sparse.median.upper);
  assert.equal(parseCommunityModelPerformance(communityPublication({ models: [], contributors: 1, devices: 1, reports: 1 })).models.length, 0);
  const allTime = communityPublication({ period: "all", interval: "week", start: "2026-01-05", end: "2026-10-10" });
  allTime.models[0].speed.points = [speedPoint("2026-09-28", [40, 42, 44, 46, 48, 50]), speedPoint("2026-10-05", [41, 130])];
  allTime.models[0].ttft.points = [ttftPoint("2026-10-05", [800, 900, 1000, 1100, 1200])];
  assert.equal(parseCommunityModelPerformance(allTime), allTime);

  const mutate = (change) => {
    const value = structuredClone(publication);
    change(value);
    return value;
  };
  const invalid = {
    extraKey: mutate((value) => { value.extra = 1; }),
    exactNotApproximate: mutate((value) => { value.approximate = false; }),
    wrongPopulation: mutate((value) => { value.population = "unique_turns"; }),
    zeroRevision: mutate((value) => { value.revision = 0; }),
    badPeriod: mutate((value) => { value.period = "90"; }),
    sevenDayWeekly: mutate((value) => { value.interval = "week"; }),
    windowMismatch: mutate((value) => { value.start = "2026-10-03"; }),
    unknownMode: mutate((value) => { value.speedMode = "unknown"; }),
    devicesBelowContributors: mutate((value) => { value.devices = 1; }),
    reportsBelowDevices: mutate((value) => { value.reports = 2; }),
    unreviewedModel: mutate((value) => { value.models[0].modelId = "private-model"; }),
    duplicateModel: mutate((value) => { value.models.push(structuredClone(value.models[0])); }),
    modelAboveTotals: mutate((value) => { value.models[0].contributors = 3; value.models[0].devices = 3; }),
    toolFreeAboveSpeed: mutate((value) => { value.models[0].toolFreeTurns = 9; }),
    countMismatch: mutate((value) => { value.models[0].speedTurns = 7; }),
    wrongUnit: mutate((value) => { value.models[0].ttft.unit = "seconds"; }),
    sparseBand: mutate((value) => { value.models[0].speed.points[1].p10 = { estimate: 1, lower: 1, upper: 1 }; }),
    missingBand: mutate((value) => { value.models[0].speed.points[0].p90 = null; }),
    missingMedian: mutate((value) => { value.models[0].speed.points[1].median = null; }),
    estimateOutsideBounds: mutate((value) => { value.models[0].speed.points[0].median.estimate = 1e6; }),
    negativeBound: mutate((value) => { value.models[0].speed.points[0].p10.lower = -1; }),
    descendingBounds: mutate((value) => { value.models[0].speed.points[0].p90 = { estimate: 1, lower: 1, upper: 1 }; }),
    unresolvedTtft: mutate((value) => { value.models[0].ttft.points[0].unresolved = 1; }),
    unresolvedAboveN: mutate((value) => { value.models[0].speed.points[1].unresolved = 3; }),
    unorderedDays: mutate((value) => { value.models[0].speed.points.reverse(); }),
    dayOutsideWindow: mutate((value) => { value.models[0].speed.points[0].day = "2026-10-01"; }),
    zeroSamplePoint: mutate((value) => { value.models[0].ttft.points[0].n = 0; }),
    extraPointKey: mutate((value) => { value.models[0].speed.points[0].contributor = "a"; }),
    privateString: mutate((value) => { value.generatedAt = "/Users/someone/private"; }),
  };
  for (const [label, value] of Object.entries(invalid)) expectPublicationInvalid(value, label);
  const weekly = structuredClone(allTime);
  weekly.models[0].speed.points[0].day = "2026-09-29";
  expectPublicationInvalid(weekly, "weekly bins start on Monday");
  const tooMany = structuredClone(publication);
  tooMany.models[0].speed.points = Array.from({ length: MAX_COMMUNITY_MODEL_PERFORMANCE_POINTS + 1 }, () => sparse);
  expectPublicationInvalid(tooMany, "point count is bounded");
  assert.throws(() => buildCommunityModelPerformancePoint("2026-13-01", poolPerformanceHistograms([speedHistogram()])),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID");
});

test("published points round outward to three decimals and full-size windows fit the byte bound", () => {
  const pool = poolPerformanceHistograms([
    buildPerformanceHistogram("speed", [33.3333, 41.17, 47.0001, 52.9, 58.123, 61.4, 66.6667]),
  ]);
  const point = buildCommunityModelPerformancePoint("2026-10-10", pool);
  const exact = canonical.performanceHistogramPoolQuantiles(pool);
  for (const name of ["p10", "p25", "median", "p75", "p90"]) {
    const band = point[name];
    for (const key of ["estimate", "lower", "upper"]) {
      assert.equal(Number(band[key].toFixed(3)), band[key], `${name}.${key} has at most three decimals`);
    }
    assert.ok(band.lower <= exact[name].lower && exact[name].upper <= band.upper, name);
    assert.ok(band.lower <= band.estimate && band.estimate <= band.upper, name);
  }
  // 40 models with 366 daily points per series (an all-time daily window).
  const days = Array.from({ length: 366 }, (_, index) => new Date(Date.UTC(2025, 9, 10 + index)).toISOString().slice(0, 10));
  const banded = (day) => buildCommunityModelPerformancePoint(day, poolPerformanceHistograms([
    buildPerformanceHistogram("speed", [31.123, 37.77, 44.4, 51.05, 57.9, 63.21]),
  ]));
  const latency = (day) => buildCommunityModelPerformancePoint(day, poolPerformanceHistograms([
    buildPerformanceHistogram("ttft", [711, 1203, 2045, 3477, 5911]),
  ]));
  const models = canonical.REVIEWED_MODEL_CATALOG.filter(({ provider }) => provider === "openai_codex")
    .slice(0, 40).map(({ provider, id }) => ({
      provider,
      modelId: id,
      turns: 366 * 6,
      speedTurns: 366 * 6,
      ttftTurns: 366 * 5,
      timedResponses: 366 * 6,
      toolFreeTurns: 0,
      contributors: 1,
      devices: 1,
      speed: { unit: "tokens_per_second", points: days.map(banded) },
      ttft: { unit: "milliseconds", points: days.map(latency) },
    }));
  const large = communityPublication({
    period: "all", start: days[0], end: days.at(-1), contributors: 1, devices: 1, reports: 1, models,
  });
  assert.ok(JSON.stringify(large).length < 16 * 1024 * 1024);
  assert.equal(parseCommunityModelPerformance(large).models.length, 40);
});
