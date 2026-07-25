import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPriceResolutionSummary,
  codexProviderBillableToolUnits,
  priceClaudeUsageRecord,
  priceCodexProviderToolUnits,
  priceCodexUsageEvent,
  summarizeClaudeApiPriceRecords,
} from "../src/local-api-pricing.js";

test("Codex current-price sensitivity prices current cards without backdating the event", () => {
  const event = {
    timestamp: "2026-07-13T12:00:00.000Z",
    model: "gpt-5.6-luna",
    raw: { input_tokens: 1_000_000 },
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
  const current = priceCodexUsageEvent(event);
  const historical = priceCodexUsageEvent(event, { priceEpochBasis: "event_time" });

  assert.equal(current.totalUsd, "7");
  assert.equal(current.pricingContext.priceEpochBasis, "current_price_sensitivity_at_registry_observation");
  assert.equal(historical.totalUsd, "0");
  assert.equal(historical.coverageStatus, "unpriced");
  assert.ok(historical.warnings.coverage.some((warning) => warning.code === "historical_price_missing"));
});

test("Codex component availability reaches the ledger and never becomes observed zero", () => {
  const result = priceCodexUsageEvent({
    timestamp: "2026-07-25T15:00:00.000Z",
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
  });
  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.totalUsd, "0.0275");
  const unknown = result.components.find((component) => (
    component.name === "unknown_provider_billable_units"
  ));
  assert.equal(unknown.pricingStatus, "unpriced");
  assert.equal(unknown.reasonCode, "unknown_tool_component");
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
