import { TELEMETRY_PLAN_TYPES } from "./constants.js";
import {
  TELEMETRY_V11_ACCOUNT_BASES,
  TELEMETRY_V11_PLAN_BASES,
  telemetryV11RequiredConsent,
} from "./telemetry-v1.1.js";

const root = "https://tibotattle.com/schemas/telemetry-contribution-v1.1/";
const closed = (properties) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
const text = (pattern) => ({ type: "string", pattern });
const token = text("^[A-Za-z0-9._:-]{1,64}$");
const occurrence = text("^[A-Za-z0-9._:-]{8,128}$");
const digest = text("^[0-9a-f]{64}$");
const instant = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };
const day = { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const count = (max) => ({ type: "integer", minimum: 0, maximum: max });
const component = { anyOf: [{ type: "null" }, count(1_000_000_000_000)] };
const consent = closed(Object.fromEntries(Object.entries(telemetryV11RequiredConsent())
  .map(([key, value]) => [key, { const: value }])));
const ref = (name) => ({ $ref: `${root}${name}.schema.json` });
const attribution = {
  ...closed({
    accountBasis: { enum: TELEMETRY_V11_ACCOUNT_BASES },
    accountTrackId: { anyOf: [{ type: "null" }, text("^account-track:v2:[0-9a-f]{64}$")] },
    planBasis: { enum: TELEMETRY_V11_PLAN_BASES },
    planType: { enum: TELEMETRY_PLAN_TYPES },
    planEraId: { anyOf: [{ type: "null" }, text("^plan-era:v1:[0-9a-f]{64}$")] },
  }),
  allOf: [
    { if: { properties: { accountBasis: { const: "unavailable" } } },
      then: { properties: { accountTrackId: { type: "null" } } },
      else: { properties: { accountTrackId: text("^account-track:v2:[0-9a-f]{64}$") } } },
    { if: { properties: { planBasis: { enum: ["unavailable", "conflicted"] } } },
      then: { properties: { planType: { const: "unknown" }, planEraId: { type: "null" } } },
      else: { properties: { planType: { enum: TELEMETRY_PLAN_TYPES.filter((value) => value !== "unknown") } } } },
  ],
  $comment: "Independent plan/account proof; provisional is never source-exact. Null era never proves continuity.",
};

const usage = closed({
  schemaVersion: { const: "usage-event-v1.1" }, eventId: occurrence, eventTime: instant,
  sessionUuid: occurrence, provider: token, modelId: token, speedMode: token,
  apiServiceTier: token, surface: token, billingSurface: token, reasoningEffort: token,
  agentScope: token, outcome: token, totalInputContextTokens: component,
  components: closed(Object.fromEntries([
    "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
    "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
  ].map((name) => [name, component]))),
  accountPlanAttribution: ref("account-plan-attribution"),
});
const quota = {
  ...closed({
    schemaVersion: { const: "quota-observation-v1.1" }, observationId: occurrence,
    observedTime: instant, provider: token, planType: { enum: TELEMETRY_PLAN_TYPES },
    planVariant: token, limitId: token, slot: token,
    usedPercent: { anyOf: [{ type: "null" }, { type: "number", minimum: 0, maximum: 100 }] },
    windowDurationMinutes: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 527_040 }] },
    resetsAt: { anyOf: [{ type: "null" }, instant] }, accountPlanAttribution: ref("account-plan-attribution"),
  }),
  allOf: TELEMETRY_PLAN_TYPES.map((plan) => ({
    if: { properties: { planType: { const: plan } } },
    then: { properties: { accountPlanAttribution: { properties: { planType: { const: plan } } } } },
  })),
};
const session = closed({
  schemaVersion: { const: "session-dimension-v1.1" }, sessionUuid: occurrence,
  firstEventTime: instant, provider: token,
  toolClassCounts: { type: "object", minProperties: 1, maxProperties: 32,
    propertyNames: text("^[a-zA-Z][A-Za-z0-9]{0,31}$"), additionalProperties: count(1_000_000_000) },
});
const chunk = {
  ...closed({
    schemaVersion: { const: "telemetry-contribution-v1.1" }, manifestDigest: digest,
    chunkId: text("^(quota|session|usage):\\d{4}-\\d{2}-\\d{2}:(0|[1-9]\\d{0,4})$"),
    chunkRevision: { const: 1 }, chunkDigest: digest, parserVersion: text("^[A-Za-z0-9._-]{1,64}$"),
    consent, records: { type: "array", minItems: 1, maxItems: 200 },
  }),
  allOf: [["usage", "usage-event"], ["quota", "quota-observation"], ["session", "session-dimension"]]
    .map(([stream, name]) => ({
      if: { properties: { chunkId: { pattern: `^${stream}:` } } },
      then: { properties: { records: { items: ref(name) } } },
    })),
  $comment: "Runtime additionally verifies same UTC day, unique occurrences, exact canonical digest and complete manifest membership.",
};
const manifest = closed({
  schemaVersion: { const: "telemetry-day-manifest-v1.1" }, day,
  parserVersion: text("^[A-Za-z0-9._-]{1,64}$"), consent,
  chunks: { type: "array", maxItems: 4096, items: closed({
    chunkId: text("^(quota|session|usage):\\d{4}-\\d{2}-\\d{2}:(0|[1-9]\\d{0,4})$"),
    chunkDigest: digest, recordCount: { type: "integer", minimum: 1, maximum: 200 },
  }) },
  excluded: closed({ quota: count(1_000_000_000), session: count(1_000_000_000), usage: count(1_000_000_000) }),
  manifestDigest: digest,
});
const envelope = closed({
  schemaVersion: { const: "telemetry-envelope-v1.1" }, synthetic: { const: false },
  keyId: text("^key:[A-Za-z0-9._-]{1,64}$"), wrappedKey: text("^[A-Za-z0-9_-]{342}$"),
  iv: text("^[A-Za-z0-9_-]{16}$"), ciphertext: text("^[A-Za-z0-9_-]{16,2000000}$"),
});
const uuid = text("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
const domainManifest = {
  ...closed({
    schemaVersion: { const: "telemetry-domain-manifest-v1.1" }, fromDay: day, throughDay: day,
    predecessor: closed({ token: uuid, previousGenerationId: { anyOf: [{ type: "null" }, uuid] },
      legacyFingerprint: digest }),
    days: { type: "array", minItems: 1, maxItems: 4096,
      items: closed({ day, manifestId: uuid, manifestDigest: digest }) },
    manifestDigest: digest,
  }),
  $comment: "Runtime additionally requires contiguous UTC days, distinct manifest IDs, canonical digest and pinned predecessor proof.",
};

/** Canonical source; the owning generator emits package and root mirrors. */
export function telemetryV11JsonSchemas() {
  return Object.fromEntries(Object.entries({
    "account-plan-attribution": attribution, "usage-event": usage,
    "quota-observation": quota, "session-dimension": session,
    contribution: chunk, "day-manifest": manifest, "domain-manifest": domainManifest, envelope,
  }).map(([name, schema]) => [`${name}.schema.json`, {
    $schema: "http://json-schema.org/draft-07/schema#", $id: `${root}${name}.schema.json`, ...schema,
  }]));
}
