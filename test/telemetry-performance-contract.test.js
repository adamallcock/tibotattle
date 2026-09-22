import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

import * as canonical from "../packages/telemetry-contract/index.js";
import {
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_CONTRACT_STATE,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  buildPerformanceHistogram,
  canonicalTelemetryPerformanceJson,
  parseTelemetryPerformanceRecord,
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

function expectInvalid(value, label) {
  assert.throws(
    () => parseTelemetryPerformanceRecord(value),
    (error) => error?.code === "TELEMETRY_RECORD_INVALID"
      || error?.code === "PRIVACY_CANARY_DETECTED",
    label,
  );
}

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
  const extra = performanceRecord();
  extra.extra = 1;
  expectInvalid(extra, "unknown top-level key");

  const privateValue = performanceRecord();
  privateValue.prompt = "private-synthetic-canary";
  expectInvalid(privateValue, "privacy canary");

  expectInvalid(performanceRecord({ day: "2026-02-29" }), "invalid UTC day");
  expectInvalid(performanceRecord({ provider: "private_provider", modelId: "private_model" }), "unreviewed provider/model");
  expectInvalid(performanceRecord({ provider: "anthropic_claude_code", modelId: "gpt-5.6-luna" }), "cross-provider model");
  expectInvalid(performanceRecord({ speedMode: "unknown", speedModeSource: "mixed" }), "unknown mode requires unobserved source");
  expectInvalid(performanceRecord({ speedMode: "mixed", speedModeSource: "unobserved" }), "mixed mode requires mixed source");
  expectInvalid(performanceRecord({ speedMode: "standard", speedModeSource: "unobserved" }), "known mode requires evidence source");
  expectInvalid(performanceRecord({ speedMode: "fast", speedModeSource: "mixed" }), "fast mode requires own or inherited evidence");
  expectInvalid(performanceRecord({ reasoningEffort: "not-known" }), "unknown reasoning effort");
  expectInvalid(performanceRecord({ speedMethod: "inferred" }), "unknown speed method");
  expectInvalid(performanceRecord({ measurementVersion: "model-performance-samples-v0" }), "unknown measurement version");
  expectInvalid(performanceRecord({ turns: 0 }), "non-positive cohort");
  expectInvalid(performanceRecord({ speedTurns: 1 }), "receipt cohort must cover all turns");
  expectInvalid(performanceRecord({ speedHistogram: ttftHistogram() }), "speed metric mismatch");
  expectInvalid(performanceRecord({ ttftHistogram: speedHistogram() }), "TTFT metric mismatch");
  expectInvalid(performanceRecord({ completionHistogram: ttftHistogram() }), "completion metric mismatch");
  expectInvalid(performanceRecord({ completionTurns: 3 }), "completion cohort cannot exceed turns");
  expectInvalid(performanceRecord({ completionTurns: 0, completionHistogram: completionHistogram() }), "zero completion cohort must have empty histogram");
  expectInvalid(performanceRecord({ completionTurns: 1, completionHistogram: completionHistogram([]) }), "positive completion cohort must have samples");
  expectInvalid(performanceRecord({ speedTokens: 10 }), "summed speed ratio outside extrema");
  expectInvalid(performanceRecord({
    speedMethod: "unavailable",
    speedTurns: 0,
    timedResponses: 1,
    speedTokens: 0,
    speedDurationMs: 0,
    speedHistogram: speedHistogram([]),
  }), "unavailable speed must have no timed response");
  expectInvalid(performanceRecord({
    ttftTurns: 0,
    ttftHistogram: ttftHistogram([0]),
  }), "empty TTFT cohort must have empty histogram");
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
