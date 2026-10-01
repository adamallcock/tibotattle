import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_OFFICIAL_PRICE_CARDS,
  FAST_MODE_QUOTA_MULTIPLIERS,
  OBSERVED_SPEED_MODE_KEYS,
  SPEED_MODE_API_MULTIPLIERS,
  SPEED_MODE_MODEL_FAMILY_KEYS,
  deriveSpeedModeApiRatiosFromRegistry,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
  inferFastModeFromCalibrationWindows,
  priceCodexUsageEvent,
  quotaWeightedApiPriceEquivalent,
  resolveEffectiveSpeedMode,
  speedModeApiMultiplier,
  speedModeModelFamilyKey,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";

const EVENT_TIME = "2026-09-29T00:00:00.000Z";
const EVIDENCE = { eventTime: EVENT_TIME, totalInputContextTokens: 272_000 };
const ULTRAFAST_CARDS = APP_OFFICIAL_PRICE_CARDS.filter(
  (card) => card.provider === "openai" && card.service_tier === "ultrafast",
);

function crossing(cells) {
  const value = emptySpeedWeightingCrossing();
  for (const [speed, family, events, usd] of cells) {
    value[speed][family] = { events, apiPriceEquivalentUsd: usd };
  }
  return value;
}

test("generic API multipliers retain Fast prices and publish only Astra Ultrafast", () => {
  assert.equal(SPEED_MODE_API_MULTIPLIERS.fast, FAST_MODE_QUOTA_MULTIPLIERS);
  assert.deepEqual(SPEED_MODE_API_MULTIPLIERS.ultrafast, { "gpt-6-astra": 6 });
  assert.ok(Object.isFrozen(SPEED_MODE_API_MULTIPLIERS));
  assert.ok(Object.isFrozen(SPEED_MODE_API_MULTIPLIERS.ultrafast));
  assert.deepEqual(deriveSpeedModeApiRatiosFromRegistry("fast"), FAST_MODE_QUOTA_MULTIPLIERS);
  assert.deepEqual(deriveSpeedModeApiRatiosFromRegistry("ultrafast"), { "gpt-6-astra": 6 });
  assert.throws(() => deriveSpeedModeApiRatiosFromRegistry("invented"), /Unsupported API speed mode/u);
  assert.deepEqual(OBSERVED_SPEED_MODE_KEYS, ["standard", "fast", "ultrafast", "unknown"]);
  assert.deepEqual(Object.keys(emptySpeedWeightingCrossing().ultrafast), SPEED_MODE_MODEL_FAMILY_KEYS);

  for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.5-codex", "invented"]) {
    assert.equal(speedModeApiMultiplier(model, "fast", EVIDENCE), fastModeQuotaMultiplier(model, EVIDENCE));
    for (const mode of ["standard", "fast", "unknown"]) {
      assert.equal(speedModeModelFamilyKey(model, mode, EVIDENCE), fastModeModelFamilyKey(model, EVIDENCE));
    }
  }
  assert.equal(speedModeApiMultiplier("gpt-6-astra", "standard", EVIDENCE), 1);
  assert.equal(speedModeApiMultiplier("gpt-6-astra", "unknown", EVIDENCE), null);
  assert.equal(speedModeApiMultiplier("gpt-6-astra", "invented", EVIDENCE), null);
  assert.equal(speedModeModelFamilyKey("gpt-6-astra", "invented", EVIDENCE), "unsupported");
});

test("every eligible Ultrafast card equals six times the exact Standard component cost", () => {
  assert.equal(ULTRAFAST_CARDS.length, 2);
  for (const card of ULTRAFAST_CARDS) {
    const totalInputContextTokens = card.metadata.total_input_context_band === "long" ? 272_001 : 272_000;
    const components = Object.fromEntries(card.components
      .filter((component) => component.usage_component.endsWith("_tokens"))
      .map((component) => [component.usage_component, 1_000]));
    for (const model of [card.model, ...(card.aliases ?? [])]) {
      const event = { model, timestamp: EVENT_TIME, totalInputContextTokens, components };
      const standard = priceCodexUsageEvent(event, { apiServiceTier: "standard" });
      const ultrafast = priceCodexUsageEvent(event, { apiServiceTier: "ultrafast" });
      assert.equal(standard.coverageStatus, "fully_priced");
      assert.equal(ultrafast.coverageStatus, "fully_priced");
      assert.deepEqual(ultrafast.selectedPriceCardIds, [card.id]);
      const evidence = { eventTime: EVENT_TIME, totalInputContextTokens, standardPriceCardIds: standard.selectedPriceCardIds };
      assert.equal(speedModeModelFamilyKey(model, "ultrafast", evidence), "gpt-6-astra");
      assert.equal(speedModeApiMultiplier(model, "ultrafast", evidence), 6);
      assert.deepEqual(quotaWeightedApiPriceEquivalent({
        apiPriceEquivalentUsd: Number(standard.totalUsd), model, mode: "ultrafast", ...evidence,
      }), { usd: Number(ultrafast.totalUsd), multiplier: 6, status: "ultrafast_weighted" });
      // Exact Standard card evidence may establish the context when its raw
      // token count is unavailable; conflicting explicit context is rejected.
      assert.equal(speedModeApiMultiplier(model, "ultrafast", {
        eventTime: EVENT_TIME, standardPriceCardIds: standard.selectedPriceCardIds,
      }), 6);
      assert.equal(speedModeApiMultiplier(model, "ultrafast", {
        ...evidence, totalInputContextTokens: totalInputContextTokens === 272_000 ? 272_001 : 272_000,
      }), null);
    }
  }
});

test("Ultrafast never assumes a ratio for unsupported models, dates, contexts, or evidence", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-astra-preview", "gpt-6-astra-wm", "invented"]) {
    assert.equal(speedModeApiMultiplier(model, "ultrafast", EVIDENCE), null, model);
    assert.equal(speedModeModelFamilyKey(model, "ultrafast", EVIDENCE), "unsupported", model);
    assert.deepEqual(quotaWeightedApiPriceEquivalent({
      apiPriceEquivalentUsd: 4, model, mode: "ultrafast", ...EVIDENCE,
    }), { usd: null, multiplier: null, status: "ultrafast_price_unavailable" });
  }
  const wrongModelCard = APP_OFFICIAL_PRICE_CARDS.find((card) => card.model === "gpt-6.1-sol" && card.service_tier === "standard");
  for (const evidence of [
    {}, { eventTime: EVENT_TIME },
    { ...EVIDENCE, eventTime: "2026-09-28T23:59:59.999Z" },
    { ...EVIDENCE, eventTime: "2026-02-30T00:00:00Z" },
    { ...EVIDENCE, totalInputContextTokens: -1 },
    { ...EVIDENCE, totalInputContextTokens: 1.5 },
    { ...EVIDENCE, totalInputContextTokens: Number.NaN },
    { ...EVIDENCE, standardPriceCardIds: [] },
    { ...EVIDENCE, standardPriceCardIds: [wrongModelCard.id] },
    { ...EVIDENCE, standardPriceCardIds: ["invented"] },
    { ...EVIDENCE, unreviewedField: true },
  ]) {
    assert.equal(speedModeApiMultiplier("gpt-6-astra", "ultrafast", evidence), null);
    assert.equal(speedModeModelFamilyKey("gpt-6-astra", "ultrafast", evidence), "unsupported");
  }
  assert.deepEqual(quotaWeightedApiPriceEquivalent({
    apiPriceEquivalentUsd: 4, model: "gpt-6-astra", mode: "ultrafast",
  }), { usd: null, multiplier: null, status: "ultrafast_price_unavailable" });
  // Capability lookup is deliberately separate from event pricing authority.
  assert.equal(speedModeApiMultiplier("gpt-6-astra", "ultrafast"), 6);
  assert.equal(speedModeApiMultiplier("gpt-6.1-sol", "ultrafast"), null);
});

test("Ultrafast ratio proof rejects partial cards and unequal component or context ratios", () => {
  for (const mutate of [
    (card) => { card.components = card.components.filter((component) => component.usage_component !== "output_text_tokens"); },
    (card) => { card.components[0].price.amount = "61"; },
    (card) => { card.components[0].conditions.max_total_input_tokens = "271999"; },
  ]) {
    const cards = structuredClone(APP_OFFICIAL_PRICE_CARDS);
    mutate(cards.find((card) => card.service_tier === "ultrafast" && card.metadata.total_input_context_band === "short"));
    assert.throws(() => deriveSpeedModeApiRatiosFromRegistry("ultrafast", cards), /coverage differs|not uniform|conditions differ/u);
  }
  assert.throws(() => deriveSpeedModeApiRatiosFromRegistry("ultrafast", APP_OFFICIAL_PRICE_CARDS.filter(
    (card) => !(card.model === "gpt-6-astra" && card.service_tier === "standard"),
  )), /no overlapping Standard/u);
});

test("observed Ultrafast and covering declarations retain precedence across sensitivity scenarios", () => {
  for (const unresolvedScenario of ["unresolved_as_standard", "unresolved_as_fast"]) {
    for (const declaredMode of ["standard", "fast", "ultrafast", "unknown"]) {
      assert.deepEqual(resolveEffectiveSpeedMode({ observedMode: "ultrafast", declaredMode, unresolvedScenario }),
        { mode: "ultrafast", provenance: "observed" });
    }
    assert.deepEqual(resolveEffectiveSpeedMode({ observedMode: "unknown", declaredMode: "ultrafast", unresolvedScenario }),
      { mode: "ultrafast", provenance: "declared_codex_config" });
    for (const observedMode of ["standard", "fast"]) {
      assert.deepEqual(resolveEffectiveSpeedMode({ observedMode, declaredMode: "ultrafast", unresolvedScenario }),
        { mode: observedMode, provenance: "observed" });
    }
  }
});

test("mixed speed accounting preserves provenance, distinct API ratios, and unsupported money", () => {
  const speedWeighting = crossing([
    ["standard", "gpt-6-astra", 1, 1], ["fast", "gpt-6-astra", 2, 2],
    ["ultrafast", "gpt-6-astra", 3, 3], ["ultrafast", "unsupported", 4, 4],
    ["unknown", "gpt-6-astra", 5, 5], ["unknown", "unsupported", 6, 6],
  ]);
  const declaredSpeedWeighting = crossing([
    ["ultrafast", "gpt-6-astra", 5, 5], ["ultrafast", "unsupported", 6, 6],
  ]);
  for (const unresolvedScenario of ["unresolved_as_standard", "unresolved_as_fast"]) {
    const summary = summarizeQuotaWeightedAccounting({ speedWeighting, declaredSpeedWeighting, unresolvedScenario });
    assert.equal(summary.standardApiPriceEquivalentUsd, 21);
    assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 53);
    assert.equal(summary.unweightedUnknownApiPriceEquivalentUsd, 10);
    assert.equal(summary.assumedRatioStandardApiPriceEquivalentUsd, 0);
    assert.equal(summary.weightingStatus, "partial");
    assert.deepEqual(summary.appliedMultipliers, { "gpt-6-astra": 2, "ultrafast:gpt-6-astra": 6 });
    assert.equal(summary.coverage.totalEvents, 21);
    assert.equal(summary.coverage.observedEvents, 10);
    assert.equal(summary.coverage.declaredFromConfigEvents, 11);
    assert.equal(summary.coverage.assumedEvents, 0);
    assert.equal(summary.coverage.unknownEvents, 0);
  }
});

test("unsupported Ultrafast remains unknown even for zero-dollar events and legacy crossings remain readable", () => {
  for (const family of ["unsupported", "gpt-6.1-sol"]) {
    for (const usd of [0, 4]) {
      const speedWeighting = crossing([["ultrafast", family, 1, usd]]);
      const summary = summarizeQuotaWeightedAccounting({ speedWeighting });
      assert.equal(summary.weightingStatus, "unknown");
      assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, null);
      assert.equal(summary.unweightedUnknownApiPriceEquivalentUsd, usd);
      assert.deepEqual(summary.appliedMultipliers, {});
      speedWeighting.standard.unsupported = { events: 1, apiPriceEquivalentUsd: 0 };
      assert.equal(summarizeQuotaWeightedAccounting({ speedWeighting }).weightingStatus, "partial");
    }
  }
  const legacy = crossing([["fast", "gpt-5.6-sol", 1, 4], ["unknown", "unsupported", 1, 2]]);
  delete legacy.ultrafast;
  assert.equal(summarizeQuotaWeightedAccounting({ speedWeighting: legacy }).quotaWeightedApiPriceEquivalentUsd, 10);
});

test("Ultrafast evidence cannot form a Standard reference for residual Fast diagnostics", () => {
  const reference = { apiPriceEquivalentUsd: 100, knownSpeedFraction: 1, fastFractionOfKnown: 0,
    eligibleTransitions: 8, uniqueBoundaries: 4, observedSpanPercentagePoints: 5, unknownSpeedEvents: 0 };
  const windows = [0, 1, 2].map((id) => ({ ...reference, id: String(id) }));
  windows.push({ ...reference, id: "unobserved", apiPriceEquivalentUsd: 50, knownSpeedFraction: 0, unknownSpeedEvents: 8 });
  const legacy = inferFastModeFromCalibrationWindows(windows);
  assert.equal(legacy.referenceWindowCount, 3);
  assert.equal(legacy.inferredFastWindowCount, 1);
  for (const ultrafastFractionOfKnown of [1, 0.06, null, -1]) {
    const result = inferFastModeFromCalibrationWindows(windows.map((window, index) => index === 0
      ? { ...window, ultrafastFractionOfKnown } : window));
    assert.equal(result.status, "insufficient_signal");
    assert.equal(result.reasonCode, "not_enough_reference_windows");
  }
  const combined = inferFastModeFromCalibrationWindows(windows.map((window, index) => index === 0
    ? { ...window, fastFractionOfKnown: 0.03, ultrafastFractionOfKnown: 0.03 } : window));
  assert.equal(combined.reasonCode, "not_enough_reference_windows");
});
