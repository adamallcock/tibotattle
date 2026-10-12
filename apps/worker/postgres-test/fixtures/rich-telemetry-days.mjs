/**
 * Synthetic, content-free mixed-format telemetry days: one v1.1 and one v1.2
 * device share a 40-point half-hour grid across twenty hours of one day. The
 * v1.1 device owns the even points and the v1.2 device the odd points, so
 * each contributes 20 usage and 20 quota observations at hourly intervals,
 * priced through the accounting package and with a seven-day quota curve
 * scaled from those prices.
 *
 * Extracted unchanged (default options only) from the retired root
 * scripts/gcp-cloud-run-journey.mjs, whose richV11Day and richV12Day built the
 * same days through the same public contribution projection the local client
 * uses, so the community-allowance fixture spec keeps its input after the
 * journey's retirement (owner decision, 2026-10-02).
 */
import {
  APP_OFFICIAL_PRICE_CARDS,
  priceUsageEvent,
} from "@app-usagemonitor/accounting";
import {
  createTelemetryV11Day,
  createTelemetryV12Day,
  deriveTelemetryAccountTrackIdV2,
} from "../../../../src/contribution/index.js";

const RICH_RECORD_COUNT = 40;
const RICH_START_SLOT = 1;
const RICH_STEP_SLOTS = 2;

// One explicit source-owned account track for the v1.1 and v1.2 streams. The
// contribution builders derive it from captured account evidence; these
// synthetic inputs stay local to the fixture and none is copied into a
// contribution.
const ACCOUNT_OBSERVATION_SECRET = Buffer.alloc(32, 85);
const ACCOUNT_BINDING = Object.freeze({
  destinationOrigin: "https://community.example.test",
  enrollmentNamespace: "synthetic_enrollment_0001",
});
const ACCOUNT_SCOPE = Object.freeze({
  status: "available",
  reason: null,
  version: "openai-account-v1",
  scopeId: `openai-account:v1:${Buffer.alloc(32, 82).toString("base64url")}`,
  planType: "pro",
});
const EFFECTIVE_ACCOUNT_TRACK_ID = deriveTelemetryAccountTrackIdV2({
  accountScope: ACCOUNT_SCOPE,
  accountObservationSecret: ACCOUNT_OBSERVATION_SECRET,
  destinationOrigin: ACCOUNT_BINDING.destinationOrigin,
  enrollmentNamespace: ACCOUNT_BINDING.enrollmentNamespace,
});

const MODEL_PATTERN = Object.freeze([
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra"]),
  Object.freeze(["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-sol"]),
]);
const QUOTA_CAPACITY_BY_MODEL = Object.freeze({
  "gpt-5.6-sol": 2_500,
  "gpt-5.6-terra": 900,
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
    .toISOString().slice(0, 10);
}

function effectiveAttribution() {
  return {
    accountBasis: "same_source",
    accountTrackId: EFFECTIVE_ACCOUNT_TRACK_ID,
    planBasis: "same_source_occurrence",
    planType: "pro",
    planEraId: null,
  };
}

function effectiveAttributionEvidence() {
  return {
    accountBasis: "same_source",
    accountScope: ACCOUNT_SCOPE,
    observationBinding: ACCOUNT_BINDING,
    planBasis: "same_source_occurrence",
    planType: "pro",
  };
}

function modelId(globalIndex) {
  return MODEL_PATTERN[Math.floor(globalIndex / 4) % MODEL_PATTERN.length][globalIndex % 4];
}

function outputTextTokens(globalIndex) {
  return 700 + ((globalIndex * 97) % 1_000);
}

function timeAt(day, baseSlot, globalIndex) {
  // A quarter-hour slot step of two gives a 30-minute combined cadence.
  const slot = baseSlot + globalIndex * RICH_STEP_SLOTS;
  const hour = Math.floor(slot / 4);
  const minute = (slot % 4) * 15;
  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function usageComponents(globalIndex) {
  const text = outputTextTokens(globalIndex);
  return {
    inputUncachedTokens: 1_000,
    inputCacheReadTokens: 9_000,
    inputCacheWriteTokens: 0,
    outputTextTokens: text,
    outputReasoningTokens: 0,
    outputCombinedTokens: text,
  };
}

function usagePriceUsd(day, baseSlot, globalIndex) {
  // The Worker server-pricing adapter removes the redundant aggregate output
  // component before calling the accounting package; mirror that projection.
  const { outputCombinedTokens: _combined, ...components } = usageComponents(globalIndex);
  const priced = priceUsageEvent({
    provider: "openai",
    model: modelId(globalIndex),
    surface: "openai.responses",
    apiTier: "standard",
    pricedAt: timeAt(day, baseSlot, globalIndex),
    totalInputContextTokens: 10_000,
    components,
  }, {
    priceCards: APP_OFFICIAL_PRICE_CARDS,
    pricingContext: { priceEpochBasis: "event_time_when_registry_has_effective_evidence" },
  });
  if (priced.coverageStatus !== "fully_priced" || typeof priced.totalUsd !== "string") {
    fail("RICH_FIXTURE_PRICING_INVALID");
  }
  const costUsd = Number(priced.totalUsd);
  if (!Number.isFinite(costUsd) || costUsd < 0) fail("RICH_FIXTURE_PRICING_INVALID");
  return costUsd;
}

function quotaUsedPercentByIndex(day, baseSlot) {
  const pricePercentByBin = Array.from({ length: RICH_RECORD_COUNT / 4 }, () => 0);
  for (let globalIndex = 0; globalIndex < RICH_RECORD_COUNT; globalIndex += 1) {
    const capacity = QUOTA_CAPACITY_BY_MODEL[modelId(globalIndex)];
    pricePercentByBin[Math.floor(globalIndex / 4)] += usagePriceUsd(day, baseSlot, globalIndex) * 100 / capacity;
  }
  const totalPricePercent = pricePercentByBin.reduce((sum, value) => sum + value, 0);
  if (!(totalPricePercent > 0) || !Number.isFinite(totalPricePercent)) fail("RICH_FIXTURE_QUOTA_CURVE_INVALID");
  const scale = 60 / totalPricePercent;
  let usedPercent = 0;
  return Object.freeze(Array.from({ length: RICH_RECORD_COUNT }, (_, globalIndex) => {
    usedPercent += pricePercentByBin[Math.floor(globalIndex / 4)] * scale / 4;
    return usedPercent;
  }));
}

function usageRecord(schemaVersion, day, baseSlot, globalIndex) {
  return {
    schemaVersion,
    eventId: `event:gcp-journey-mixed:${day}:${globalIndex}`,
    eventTime: timeAt(day, baseSlot, globalIndex),
    sessionUuid: `session:gcp-journey-mixed:${day}`,
    provider: "openai_codex",
    modelId: modelId(globalIndex),
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 10_000,
    components: usageComponents(globalIndex),
    accountPlanAttribution: { ...effectiveAttribution() },
    ...(schemaVersion === "usage-event-v1.2"
      ? { boundaryFlags: null, tieOrder: null, cacheWriteTtl: null } : {}),
  };
}

function quotaRecord(schemaVersion, day, baseSlot, globalIndex, usedPercent, resetDay) {
  return {
    schemaVersion,
    observationId: `observation:gcp-journey-mixed:${day}:${globalIndex}`,
    observedTime: timeAt(day, baseSlot, globalIndex),
    provider: "openai_codex",
    planType: "pro",
    planVariant: "standard",
    limitId: "codex",
    slot: "seven_day",
    usedPercent,
    windowDurationMinutes: 10_080,
    resetsAt: `${resetDay}T00:00:00.000Z`,
    accountPlanAttribution: { ...effectiveAttribution() },
  };
}

/** The v1.2 device's day: the odd grid points. */
export function richV12Day(day, { baseSlot = RICH_START_SLOT, resetDay = addDays(day, 7) } = {}) {
  const globalIndexes = Array.from({ length: 20 }, (_, index) => index * 2 + 1);
  const curve = quotaUsedPercentByIndex(day, baseSlot);
  return createTelemetryV12Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v12",
    recordsByStream: {
      quota: globalIndexes.map((index) => quotaRecord("quota-observation-v1.2", day, baseSlot, index,
        curve[index], resetDay)),
      session: [{
        schemaVersion: "session-dimension-v1.2",
        sessionUuid: `session:gcp-journey-v12:${day}`,
        firstEventTime: `${day}T00:00:00.000Z`,
        provider: "openai_codex",
        toolClassCounts: { analysis: RICH_RECORD_COUNT / 2 },
      }],
      usage: globalIndexes.map((index) => usageRecord("usage-event-v1.2", day, baseSlot, index)),
    },
    accountObservationSecret: ACCOUNT_OBSERVATION_SECRET,
    binding: ACCOUNT_BINDING,
    attributionForRecord: () => ({ ...effectiveAttributionEvidence() }),
  });
}

/** The v1.1 device's day: the even grid points. */
export function richV11Day(day, { baseSlot = RICH_START_SLOT, resetDay = addDays(day, 7) } = {}) {
  const globalIndexes = Array.from({ length: 20 }, (_, index) => index * 2);
  const curve = quotaUsedPercentByIndex(day, baseSlot);
  return createTelemetryV11Day({
    day,
    parserVersion: "gcp-cloud-run-journey-v11",
    recordsByStream: {
      quota: globalIndexes.map((index) => quotaRecord("quota-observation-v1.1", day, baseSlot, index,
        curve[index], resetDay)),
      session: [{
        schemaVersion: "session-dimension-v1.1",
        sessionUuid: `session:gcp-journey-v11:${day}`,
        firstEventTime: `${day}T00:00:00.000Z`,
        provider: "openai_codex",
        toolClassCounts: { analysis: globalIndexes.length },
      }],
      usage: globalIndexes.map((index) => usageRecord("usage-event-v1.1", day, baseSlot, index)),
    },
    accountObservationSecret: ACCOUNT_OBSERVATION_SECRET,
    binding: ACCOUNT_BINDING,
    attributionForRecord: () => ({ ...effectiveAttributionEvidence() }),
  });
}
