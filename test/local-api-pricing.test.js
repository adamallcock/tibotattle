import test from "node:test";
import assert from "node:assert/strict";
import {
  addUsdStrings,
  aggregateLocalApiPriceResults,
  apiPriceResolutionSummary,
  priceClaudeUsageRecord,
  priceCodexProviderToolUnits,
  priceCodexUsageEvent,
} from "../packages/accounting/index.js";
import {
  codexProviderBillableToolUnits,
  summarizeClaudeApiPriceRecords,
} from "../packages/accounting/src/local-api-pricing.js";

test("Codex defaults to event-time history while retaining explicit current sensitivity", () => {
  const event = {
    timestamp: "2026-07-13T12:00:00.000Z",
    model: "gpt-5.6-luna",
    // Keep this current-vs-historical test in the short-context band; long
    // selection is covered separately with totalInputContextTokens below.
    raw: { input_tokens: 1_000 },
    components: {
      input_uncached_tokens: 1_000_000,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 1_000_000,
      output_reasoning_tokens: 0,
    },
    componentAvailability: {
      input_uncached_tokens: true,
      input_cache_read_tokens: true,
      input_cache_write_tokens: true,
      output_text_tokens: true,
      output_reasoning_tokens: true,
    },
  };
  const historical = priceCodexUsageEvent(event);
  const current = priceCodexUsageEvent(event, { priceEpochBasis: "current_price_sensitivity" });

  assert.equal(current.totalUsd, "1.4");
  assert.equal(current.pricingContext.priceEpochBasis, "current_price_sensitivity_at_registry_observation");
  assert.equal(historical.pricingContext.priceEpochBasis, "event_time_when_registry_has_effective_evidence");
  assert.equal(historical.totalUsd, "7");
  assert.equal(historical.coverageStatus, "fully_priced");
  assert.equal(
    historical.warnings.coverage.some((warning) => warning.code === "historical_price_missing"),
    false,
  );
});

test("Codex component availability reaches the ledger and never becomes observed zero", () => {
  const result = priceCodexUsageEvent({
    timestamp: "2026-07-26T15:00:00.000Z",
    model: "gpt-5.6-sol",
    raw: { input_tokens: 10 },
    components: {
      input_uncached_tokens: 10,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 2,
      output_reasoning_tokens: 0,
    },
    componentAvailability: {
      input_uncached_tokens: false,
      input_cache_read_tokens: false,
      input_cache_write_tokens: false,
      output_text_tokens: true,
      output_reasoning_tokens: true,
    },
  });
  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.coverageCounts.unavailableComponents, 3);
});

test("Codex pricing prefers canonical totalInputContextTokens for the exact long-context band", () => {
  const event = {
    timestamp: "2026-07-26T08:00:00.000Z",
    model: "gpt-5.6-luna",
    totalInputContextTokens: 272_000,
    // Deliberately smaller than the canonical context total so this test catches
    // adapters that accidentally select the band from the raw component again.
    raw: { input_tokens: 10 },
    components: {
      input_uncached_tokens: 1_000_000,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 1_000_000,
      output_reasoning_tokens: 0,
    },
    componentAvailability: {
      input_uncached_tokens: true,
      input_cache_read_tokens: true,
      input_cache_write_tokens: true,
      output_text_tokens: true,
      output_reasoning_tokens: true,
    },
  };
  const result = priceCodexUsageEvent(event);
  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "11");
  assert.match(result.selectedPriceCardId, /:long-(?:through-2026-07-29|from-2026-07-30):/);
});

test("Claude canonical records retain cache TTL and combined-output semantics", () => {
  const result = priceClaudeUsageRecord({
    eventTime: "2026-07-25T15:00:00.000Z",
    modelRecognition: "recognized",
    modelId: "claude-sonnet-4-6",
    totalInputContextTokens: 3_000_000,
    components: {
      inputUncachedTokens: 1_000_000,
      inputCacheReadTokens: 1_000_000,
      inputCacheWriteTokens: 1_000_000,
      inputCacheWrite5mTokens: 500_000,
      inputCacheWrite1hTokens: 500_000,
      outputCombinedTokens: 1_000_000,
    },
  });
  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "23.175");
  assert.equal(result.components.find((component) => component.name === "output_combined_tokens").pricedAs, "output_text_tokens");
});

test("typed provider tool units price separately from client tool classes", () => {
  const units = codexProviderBillableToolUnits({
    responses_web_search_call: 2,
    responses_file_search_call: 3,
    client_wrapper: 999,
  });
  assert.deepEqual(units.map(({ name, quantity, unit }) => ({ name, quantity, unit })), [
    { name: "file_search_units", quantity: "3", unit: "call" },
    { name: "unknown_provider_billable_units", quantity: "999", unit: "custom" },
    { name: "web_search_units", quantity: "2", unit: "search" },
  ]);
  const result = priceCodexProviderToolUnits({
    responses_web_search_call: 2,
    responses_file_search_call: 3,
    client_wrapper: 999,
  }, { eventTime: "2026-08-01T00:00:00.000Z" });
  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.totalUsd, "0.0275");
  const unknown = result.components.find((component) => (
    component.name === "unknown_provider_billable_units"
  ));
  assert.equal(unknown.pricingStatus, "unpriced");
  assert.equal(unknown.reasonCode, "unknown_tool_component");
});

test("event-time boundary selects distinct Terra and Luna official cards and aggregates provenance exactly", () => {
  for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
    const before = priceCodexUsageEvent({
      timestamp: "2026-07-29T23:59:59.999Z",
      model,
      components: { input_uncached_tokens: 1_000_000 },
    });
    const after = priceCodexUsageEvent({
      timestamp: "2026-07-30T00:00:00.000Z",
      model,
      components: { input_uncached_tokens: 1_000_000 },
    });
    const mixed = aggregateLocalApiPriceResults([before, after]);

    assert.notEqual(before.selectedPriceCardId, after.selectedPriceCardId, model);
    assert.equal(mixed.selectedPriceCardIds.length, 2, model);
    assert.equal(mixed.priceCardBreakdown.length, 2, model);
    assert.equal(mixed.priceCardBreakdown[0].events, 1, model);
    assert.equal(mixed.priceCardBreakdown[1].events, 1, model);
    assert.equal(mixed.totalUsd, addUsdStrings(before.totalUsd, after.totalUsd), model);
  }
});

test("recognized historical events price before the review date while missing time fails closed", () => {
  const preReview = priceCodexUsageEvent({
    timestamp: "2026-07-24T23:59:59.999Z",
    model: "gpt-5.6-terra",
    raw: { input_tokens: 1_000 },
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(preReview.totalUsd, "2.5");
  assert.equal(preReview.coverageStatus, "fully_priced");
  assert.equal(
    preReview.warnings.coverage.some((warning) => (
      warning.code === "historical_price_missing"
    )),
    false,
  );

  const result = priceCodexUsageEvent({
    model: "gpt-5.6-terra",
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(result.totalUsd, "0");
  assert.equal(result.coverageStatus, "unpriced");
  assert.ok(result.warnings.coverage.some((warning) => (
    warning.code === "historical_price_timestamp_missing"
  )));
  assert.equal(result.pricingContext.historicalPriceReasonCode, "historical_price_timestamp_missing");
  assert.equal(result.components[0].reasonCode, "historical_price_timestamp_missing");
});

test("the reviewed GPT-5.5 Codex alias remains priceable in historical events", () => {
  const result = priceCodexUsageEvent({
    timestamp: "2026-07-24T12:00:00.000Z",
    model: "gpt-5.5-codex",
    raw: { input_tokens: 1_000 },
    components: {
      input_uncached_tokens: 1_000_000,
      output_text_tokens: 1_000_000,
    },
  });
  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "35");
  assert.match(result.selectedPriceCardIds[0], /openai:gpt-5\.5:standard:short:/u);
});

test("noncanonical historical event times fail closed instead of selecting a card", () => {
  for (const timestamp of [
    "2026-07-30",
    "2026-07-30T00:00:00Z",
    "2026-07-30T00:00:00.000-00:00",
    "2026-07-30T00:00:00.000+00:00",
  ]) {
    const result = priceCodexUsageEvent({
      timestamp,
      model: "gpt-5.6-terra",
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(result.totalUsd, "0", timestamp);
    assert.equal(result.coverageStatus, "unpriced", timestamp);
    assert.deepEqual(result.selectedPriceCardIds, [], timestamp);
    assert.equal(
      result.components[0].reasonCode,
      "historical_price_timestamp_missing",
      timestamp,
    );
  }
});

test("Claude record summaries expose exact per-model coverage", () => {
  const base = {
    eventTime: "2026-07-25T15:00:00.000Z",
    modelRecognition: "recognized",
    modelId: "claude-sonnet-4-6",
    totalInputContextTokens: 10,
  };
  const summary = summarizeClaudeApiPriceRecords([
    {
      ...base,
      components: {
        inputUncachedTokens: 10,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: 0,
        inputCacheWrite1hTokens: 0,
        outputCombinedTokens: 2,
      },
    },
    {
      ...base,
      components: {
        inputUncachedTokens: 10,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 5,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputCombinedTokens: 2,
      },
    },
  ]);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.coverageCounts.fullyPriced, 1);
  assert.equal(summary.coverageCounts.partiallyPriced, 1);
  assert.equal(summary.byModel["claude-sonnet-4-6"].events, 2);
  assert.equal(typeof summary.totalUsd, "string");
});

test("resolution summary binds method and official registry without claiming an observed API tier", () => {
  const resolution = apiPriceResolutionSummary();
  assert.equal(resolution.selectedSource, "app-official-price-registry");
  assert.equal(resolution.serviceTier.observed, null);
  assert.equal(resolution.serviceTier.apiPriceAssumption, "standard");
  assert.match(resolution.registry.sha256, /^[a-f0-9]{64}$/);
});
