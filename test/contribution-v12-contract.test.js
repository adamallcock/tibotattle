import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";

import {
  MAX_TELEMETRY_V12_TIE_ORDER,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION,
  TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  canonicalTelemetryV12Json,
  isTelemetryV12ConsentCurrent,
  parseTelemetryV11Record,
  parseTelemetryV12Attribution,
  parseTelemetryV12Chunk,
  parseTelemetryV12DayManifest,
  parseTelemetryV12DomainManifest,
  parseTelemetryV12Record,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  validateTelemetryV12DayUsageOrder,
  validateTelemetryV12Envelope,
} from "../packages/telemetry-contract/index.js";
import * as canonical from "../packages/telemetry-contract/index.js";
import { telemetryV12JsonSchemas } from "../packages/telemetry-contract/src/telemetry-v1.2-schemas.js";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";

const DAY = "2026-09-20";
const ATTRIBUTION = Object.freeze({
  accountBasis: "unavailable",
  accountTrackId: null,
  planBasis: "unavailable",
  planType: "unknown",
  planEraId: null,
});

function usage(overrides = {}) {
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
    accountPlanAttribution: { ...ATTRIBUTION },
    boundaryFlags: 0,
    tieOrder: 0,
    cacheWriteTtl: { fiveMinuteTokens: 4, oneHourTokens: 6 },
    ...overrides,
  };
}

function quota() {
  return {
    schemaVersion: "quota-observation-v1.2",
    observationId: "quota:v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    observedTime: `${DAY}T12:00:00.000Z`,
    provider: "openai_codex",
    planType: "unknown",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: null,
    windowDurationMinutes: null,
    resetsAt: null,
    accountPlanAttribution: { ...ATTRIBUTION },
  };
}

function session() {
  return {
    schemaVersion: "session-dimension-v1.2",
    sessionUuid: "session-fixture-1",
    firstEventTime: `${DAY}T12:00:00.000Z`,
    provider: "openai_codex",
    toolClassCounts: { localShell: 1 },
  };
}

function chunk(record, stream = "usage") {
  return {
    schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    manifestDigest: "b".repeat(64),
    chunkId: `${stream}:${DAY}:0`,
    chunkRevision: 1,
    chunkDigest: "c".repeat(64),
    parserVersion: "typed-v12-test",
    consent: telemetryV12RequiredConsent(),
    records: [record],
  };
}

function dayManifest() {
  return {
    schemaVersion: TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION,
    day: DAY,
    parserVersion: "typed-v12-test",
    consent: telemetryV12RequiredConsent(),
    chunks: [{ chunkId: `usage:${DAY}:0`, chunkDigest: "c".repeat(64), recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "d".repeat(64),
  };
}

function domainManifest() {
  return {
    schemaVersion: TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
    fromDay: DAY,
    throughDay: DAY,
    predecessor: {
      token: "00000000-0000-4000-8000-000000000000",
      previousGenerationId: null,
      legacyFingerprint: "e".repeat(64),
    },
    days: [{
      day: DAY,
      manifestId: "11111111-1111-4111-8111-111111111111",
      manifestDigest: "f".repeat(64),
    }],
    manifestDigest: "0".repeat(64),
  };
}

test("v1.2 exports stay in lockstep with the generated browser mirror", () => {
  assert.deepEqual(Object.keys(browser), Object.keys(canonical));
  assert.deepEqual(browser.telemetryV12RequiredConsent(), telemetryV12RequiredConsent());
  const record = usage();
  const usageChunk = chunk(record);
  assert.deepEqual(browser.parseTelemetryV12Record("usage", record), parseTelemetryV12Record("usage", record));
  assert.deepEqual(browser.parseTelemetryV12Attribution(record.accountPlanAttribution), parseTelemetryV12Attribution(record.accountPlanAttribution));
});

test("v1.2 validates the complete record, chunk, day, domain, and envelope family", () => {
  const record = usage();
  const usageChunk = chunk(record);
  assert.equal(parseTelemetryV12Record("usage", record), record);
  assert.equal(parseTelemetryV12Record("quota", quota()).schemaVersion, "quota-observation-v1.2");
  assert.equal(parseTelemetryV12Record("session", session()).schemaVersion, "session-dimension-v1.2");
  assert.equal(parseTelemetryV12Chunk(usageChunk), usageChunk);
  assert.equal(parseTelemetryV12Chunk(chunk(quota(), "quota")).chunkId, `quota:${DAY}:0`);
  assert.equal(parseTelemetryV12Chunk(chunk(session(), "session")).chunkId, `session:${DAY}:0`);
  assert.equal(parseTelemetryV12DayManifest(dayManifest()).day, DAY);
  assert.equal(parseTelemetryV12DomainManifest(domainManifest()).fromDay, DAY);
  assert.equal(validateTelemetryV12Envelope({
    schemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    keyId: "key:v12-test",
    wrappedKey: "a".repeat(342),
    iv: "b".repeat(16),
    ciphertext: "c".repeat(16),
  }).schemaVersion, TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION);
  assert.equal(isTelemetryV12ConsentCurrent(telemetryV12RequiredConsent()), true);
  assert.equal(canonicalTelemetryV12Json({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(typeof telemetryV12DayManifestDigestInput(dayManifest()), "string");
  assert.equal(typeof telemetryV12DomainManifestDigestInput(domainManifest()), "string");
});

test("v1.2 keeps exact closed keys, privacy, bounds, and TTL reconciliation", () => {
  const invalid = [
    ["missing boundaryFlags", (() => { const value = usage(); delete value.boundaryFlags; return value; })()],
    ["unknown nested field", (() => { const value = usage(); value.cacheWriteTtl.prompt = "private-synthetic-canary"; return value; })()],
    ["boundary mask too high", usage({ boundaryFlags: 4 })],
    ["boundary mask negative", usage({ boundaryFlags: -1 })],
    ["tie rank too high", usage({ tieOrder: MAX_TELEMETRY_V12_TIE_ORDER + 1 })],
    ["TTL without aggregate", usage({ components: { ...usage().components, inputCacheWriteTokens: null } })],
    ["TTL does not reconcile", usage({ cacheWriteTtl: { fiveMinuteTokens: 5, oneHourTokens: 6 } })],
    ["TTL missing split", usage({ cacheWriteTtl: { fiveMinuteTokens: 10 } })],
  ];
  for (const [label, value] of invalid) {
    assert.throws(() => parseTelemetryV12Record("usage", value), undefined, label);
  }
  const privacy = usage();
  privacy.prompt = "private-synthetic-canary";
  assert.throws(
    () => parseTelemetryV12Record("usage", privacy),
    (error) => error?.code === "PRIVACY_CANARY_DETECTED",
  );
});

test("v1.2 instants match the four-digit UTC wire schema", () => {
  const extended = "+010000-01-01T00:00:00.000Z";
  assert.throws(() => parseTelemetryV12Record("usage", usage({ eventTime: extended })));
  assert.throws(() => browser.parseTelemetryV12Record("usage", usage({ eventTime: extended })));
  assert.throws(() => parseTelemetryV12Record("quota", { ...quota(), observedTime: extended }));
  assert.throws(() => parseTelemetryV12Record("quota", { ...quota(), resetsAt: extended }));
  assert.throws(() => parseTelemetryV12Record("session", { ...session(), firstEventTime: extended }));
});

test("v1.2 envelope validation rejects hidden/accessor/private data and keeps its size bound", () => {
  const envelope = {
    schemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    keyId: "key:v12-test",
    wrappedKey: "a".repeat(342),
    iv: "b".repeat(16),
    ciphertext: "c".repeat(16),
  };
  const hidden = { ...envelope };
  Object.defineProperty(hidden, "prompt", { value: "private-hidden", enumerable: false });
  assert.throws(() => validateTelemetryV12Envelope(hidden),
    (error) => error?.code === "ENVELOPE_INVALID");

  let touched = 0;
  const accessor = { ...envelope };
  Object.defineProperty(accessor, "ciphertext", {
    enumerable: true,
    get() {
      touched += 1;
      return envelope.ciphertext;
    },
  });
  assert.throws(() => validateTelemetryV12Envelope(accessor),
    (error) => error?.code === "ENVELOPE_INVALID");
  assert.equal(touched, 0);

  const privateField = { ...envelope, prompt: "private-synthetic-canary" };
  assert.throws(() => validateTelemetryV12Envelope(privateField),
    (error) => error?.code === "ENVELOPE_INVALID");

  // Ciphertext is opaque base64url, so a canary-looking substring is valid
  // until the envelope is decrypted and its plaintext is checked.
  const opaqueCanary = { ...envelope, ciphertext: `um_session_${"c".repeat(16)}` };
  assert.equal(validateTelemetryV12Envelope(opaqueCanary), opaqueCanary);

  const largest = {
    ...envelope,
    keyId: `key:${"a".repeat(64)}`,
    ciphertext: "c".repeat(2_000_000),
  };
  assert.equal(validateTelemetryV12Envelope(largest), largest);
  assert.throws(() => validateTelemetryV12Envelope({
    ...largest,
    ciphertext: `${largest.ciphertext}c`,
  }), (error) => error?.code === "ENVELOPE_INVALID");
  assert.throws(() => browser.validateTelemetryV12Envelope(hidden),
    (error) => error?.code === "ENVELOPE_INVALID");
});

test("v1.2 is a successor: frozen v1.1 rejects v1.2 keys and v1.2 rejects old rows", () => {
  const successor = usage();
  const legacy = { ...successor };
  delete legacy.boundaryFlags;
  delete legacy.tieOrder;
  delete legacy.cacheWriteTtl;
  legacy.schemaVersion = "usage-event-v1.1";
  assert.equal(parseTelemetryV11Record("usage", legacy), legacy);
  assert.throws(() => parseTelemetryV12Record("usage", legacy));
  assert.throws(() => parseTelemetryV11Record("usage", successor));
});

test("full-day order validation permits all-null or complete contiguous ranks", () => {
  const unique = usage();
  assert.equal(validateTelemetryV12DayUsageOrder(DAY, [unique])[0], unique);
  const tied = [
    usage({ eventId: "event:v2:" + "1".repeat(64), tieOrder: 0 }),
    usage({ eventId: "event:v2:" + "2".repeat(64), tieOrder: 1 }),
  ];
  assert.equal(validateTelemetryV12DayUsageOrder(DAY, tied).length, 2);
  assert.equal(validateTelemetryV12DayUsageOrder(DAY, tied.map((row) => ({ ...row, tieOrder: null }))).length, 2);
  for (const change of [
    { tieOrder: null },
    { tieOrder: 2 },
  ]) {
    assert.throws(() => validateTelemetryV12DayUsageOrder(DAY, [
      tied[0], { ...tied[1], ...change },
    ]));
  }
  assert.throws(() => validateTelemetryV12DayUsageOrder("2026-09-21", [unique]));
});

test("generated v1.2 schemas match runtime keys and enforce closed shape", () => {
  const schemas = telemetryV12JsonSchemas();
  const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  const usageValidate = ajv.getSchema(schemas["usage-event.schema.json"].$id);
  const contributionValidate = ajv.getSchema(schemas["contribution.schema.json"].$id);
  const manifestValidate = ajv.getSchema(schemas["day-manifest.schema.json"].$id);
  assert.equal(usageValidate(usage()), true, JSON.stringify(usageValidate.errors));
  assert.equal(contributionValidate(chunk(usage())), true, JSON.stringify(contributionValidate.errors));
  assert.equal(manifestValidate(dayManifest()), true, JSON.stringify(manifestValidate.errors));
  assert.equal(usageValidate({ ...usage(), unexpected: true }), false);
  assert.deepEqual(
    schemas["contribution.schema.json"].properties.consent.properties,
    Object.fromEntries(Object.entries(telemetryV12RequiredConsent()).map(([key, value]) => [key, { const: value }])),
  );
});
