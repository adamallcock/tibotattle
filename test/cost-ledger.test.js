import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCostResults,
  priceUsageEvent,
} from "../packages/accounting/index.js";

function component(usageComponent, amount, unit = "token", per = "1000000") {
  return { usage_component: usageComponent, unit, price: { amount: String(amount), currency: "USD", per } };
}

function card({ id, provider, model, tier, components, surface, effective }) {
  return {
    schema_version: "0.1",
    id,
    provider,
    model,
    ...(tier ? { service_tier: tier } : {}),
    ...(surface ? { surface } : {}),
    ...(effective ? { effective } : {}),
    components,
    source: { name: "test-prices", retrieved_at: "2026-07-25T00:00:00.000Z" },
  };
}

const OPENAI_STANDARD = card({
  id: "openai:gpt-test:standard",
  provider: "openai",
  model: "gpt-test",
  tier: "standard",
  components: [
    component("input_uncached_tokens", "2.5"),
    component("input_cache_read_tokens", "0.25"),
    component("input_cache_write_tokens", "3.125"),
    component("output_text_tokens", "15"),
  ],
});

const ANTHROPIC_STANDARD = card({
  id: "anthropic:claude-test:standard",
  provider: "anthropic",
  model: "claude-test",
  tier: "standard",
  components: [
    component("input_uncached_tokens", "3"),
    component("input_cache_read_tokens", "0.3"),
    component("input_cache_write_tokens", "3.75"),
    component("input_cache_write_1h_tokens", "6"),
    component("output_text_tokens", "15"),
    component("web_search_units", "10", "search", "1000"),
  ],
});

test("prices every OpenAI token component and preserves exact decimals plus reasoning fallback metadata", () => {
  const result = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    pricedAt: "2026-07-25T12:00:00Z",
    components: {
      inputUncachedTokens: "1000000",
      inputCacheReadTokens: "1000000",
      inputCacheWriteTokens: "1000000",
      outputTextTokens: "1000000",
      outputReasoningTokens: "1000000",
    },
  }, { priceCards: [OPENAI_STANDARD] });

  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "35.875");
  assert.equal(result.pricingContext.serviceTier, "standard");
  assert.equal(result.pricingContext.tierSource, "assumed_standard_counterfactual");
  assert.equal(result.selectedPriceCardId, OPENAI_STANDARD.id);
  const reasoning = result.components.find((item) => item.name === "output_reasoning_tokens");
  assert.equal(reasoning.unitPriceUsd, "0.000015");
  assert.equal(reasoning.costUsd, "15");
  assert.equal(reasoning.metadata.priced_as_component, "output_text_tokens");
  assert.equal(reasoning.metadata.fallback_reason, "no_separate_reasoning_price");
  assert.equal(typeof result.totalUsd, "string");
});

test("maps Anthropic combined output to ordinary output without inventing a text/reasoning split", () => {
  const result = priceUsageEvent({
    provider: "anthropic",
    model: "claude-test",
    components: {
      inputUncachedTokens: "1000000",
      inputCacheReadTokens: "1000000",
      inputCacheWriteTokens: "2000000",
      inputCacheWrite5mTokens: "1000000",
      inputCacheWrite1hTokens: "1000000",
      outputCombinedTokens: "1000000",
    },
  }, { priceCards: [ANTHROPIC_STANDARD] });

  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "28.05");
  const output = result.components.find((item) => item.name === "output_combined_tokens");
  assert.equal(output.pricedAs, "output_text_tokens");
  assert.equal(output.metadata.output_split_invented, false);
  assert.equal(output.metadata.pricing_policy, "anthropic_combined_output_priced_as_ordinary_output");
  assert.equal(result.components.some((item) => item.name === "output_reasoning_tokens"), false);
});

test("does not assume missing Anthropic 1h cache writes are zero", () => {
  const result = priceUsageEvent({
    provider: "anthropic",
    model: "claude-test",
    components: {
      inputUncachedTokens: "1000000",
      inputCacheWriteTokens: "1000000",
      inputCacheWrite5mTokens: "1000000",
      outputCombinedTokens: "1000000",
    },
  }, { priceCards: [ANTHROPIC_STANDARD] });

  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.totalUsd, "18");
  const cacheWrite = result.components.find((item) => item.name === "anthropic_input_cache_write_unsplit_tokens");
  assert.equal(cacheWrite.pricingStatus, "unpriced");
  assert.equal(cacheWrite.reasonCode, "anthropic_cache_write_ttl_split_missing");
  assert.ok(result.warnings.coverage.some((item) => item.code === "anthropic_cache_write_ttl_split_missing"));
});

test("unavailable components remain unavailable and an observed total-input context still selects thresholds", () => {
  const longOnly = card({
    id: "openai:gpt-test:long",
    provider: "openai",
    model: "gpt-test",
    tier: "standard",
    components: [{
      ...component("output_text_tokens", "30"),
      conditions: { min_total_input_tokens: "272000" },
    }],
  });
  const result = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    totalInputContextTokens: "272000",
    components: {
      inputUncachedTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: "1000000",
      outputReasoningTokens: 0,
    },
    componentAvailability: {
      inputUncachedTokens: false,
      inputCacheReadTokens: false,
      inputCacheWriteTokens: false,
      outputTextTokens: true,
      outputReasoningTokens: true,
    },
  }, { priceCards: [longOnly] });

  assert.equal(result.totalUsd, "30");
  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.coverageCounts.unavailableComponents, 3);
  assert.equal(result.components.filter((item) => item.pricingStatus === "unavailable").length, 3);
  assert.ok(result.warnings.coverage.some((item) => item.code === "component_observation_unavailable"));
});

test("non-Standard tiers require a card that explicitly declares the exact tier", () => {
  const tierless = { ...OPENAI_STANDARD, id: "tierless", service_tier: undefined };
  const priority = { ...OPENAI_STANDARD, id: "priority", service_tier: "priority" };
  const event = {
    provider: "openai",
    model: "gpt-test",
    apiTier: "priority",
    components: { inputUncachedTokens: "1000000" },
  };

  const failedClosed = priceUsageEvent(event, { priceCards: [tierless] });
  assert.equal(failedClosed.coverageStatus, "unpriced");
  assert.equal(failedClosed.totalUsd, "0");
  assert.equal(failedClosed.components[0].reasonCode, "service_tier_exact_card_missing");

  const priced = priceUsageEvent(event, { priceCards: [tierless, priority] });
  assert.equal(priced.coverageStatus, "fully_priced");
  assert.equal(priced.totalUsd, "2.5");
  assert.equal(priced.selectedPriceCardId, "priority");
});

test("unknown models and positive components fail closed while non-coverage warnings remain informational", () => {
  const unknownModel = priceUsageEvent({
    provider: "openai",
    model: "not-in-catalog",
    components: { inputUncachedTokens: "1" },
  }, { priceCards: [OPENAI_STANDARD] });
  assert.equal(unknownModel.coverageStatus, "unpriced");
  assert.equal(unknownModel.totalUsd, "0");
  assert.ok(unknownModel.warnings.coverage.some((item) => item.code === "unknown_model"));

  const unknownComponent = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    components: { inputUncachedTokens: "1000000", mysteryTokens: "2" },
  }, { priceCards: [OPENAI_STANDARD] });
  assert.equal(unknownComponent.coverageStatus, "partially_priced");
  assert.equal(unknownComponent.totalUsd, "2.5");
  assert.equal(unknownComponent.components.find((item) => item.name === "mysteryTokens").reasonCode, "unknown_component");
});

test("prices tool usage only for an exact provider-billable unit", () => {
  const base = {
    provider: "anthropic",
    model: "claude-test",
    components: {},
  };
  const exact = priceUsageEvent({
    ...base,
    billableToolUnits: [{
      provider: "anthropic",
      name: "web_search_units",
      quantity: "1000",
      unit: "search",
      billingSource: "provider",
    }],
  }, { priceCards: [ANTHROPIC_STANDARD] });
  assert.equal(exact.coverageStatus, "fully_priced");
  assert.equal(exact.totalUsd, "10");

  for (const item of [
    { provider: "openai", name: "web_search_units", quantity: "1", unit: "search", billingSource: "provider" },
    { provider: "anthropic", name: "web_search_units", quantity: "1", unit: "search", billingSource: "inferred" },
    { provider: "anthropic", name: "unknown_tool_units", quantity: "1", unit: "custom", billingSource: "provider" },
  ]) {
    const result = priceUsageEvent({ ...base, billableToolUnits: [item] }, { priceCards: [ANTHROPIC_STANDARD] });
    assert.equal(result.coverageStatus, "unpriced");
    assert.equal(result.totalUsd, "0");
  }
});

test("unknown provider-billable units remain explicit and unpriced", () => {
  const result = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    components: { inputUncachedTokens: "1000000" },
    billableToolUnits: [{
      provider: "openai",
      name: "unknown_provider_billable_units",
      quantity: "4",
      unit: "custom",
      billingSource: "provider",
    }],
  }, { priceCards: [OPENAI_STANDARD] });

  assert.equal(result.coverageStatus, "partially_priced");
  assert.equal(result.totalUsd, "2.5");
  assert.deepEqual(
    result.components.find((item) => item.name === "unknown_provider_billable_units"),
    {
      name: "unknown_provider_billable_units",
      pricedAs: null,
      quantity: "4",
      unit: "custom",
      pricingStatus: "unpriced",
      unitPriceUsd: null,
      costUsd: null,
      priceCardId: null,
      reasonCode: "unknown_tool_component",
    },
  );
  assert.ok(result.warnings.coverage.some((item) => item.code === "unknown_tool_component"));
});

test("coverage classification ignores informational RunCost warnings when monetary coverage is complete", () => {
  const aliasCard = { ...OPENAI_STANDARD, aliases: ["gpt-test-alias"] };
  const result = priceUsageEvent({
    provider: "openai",
    model: "gpt-test-alias",
    pricedAt: "2026-07-25T00:00:00.000Z",
    components: { inputUncachedTokens: "1" },
  }, { priceCards: [aliasCard], pricingContext: {} });
  assert.equal(result.coverageStatus, "fully_priced");
  assert.ok(result.warnings.informational.some((item) => item.code === "alias_inferred"));
});

test("aggregates totals exactly and rolls monetary coverage across events", () => {
  const full = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    components: { inputUncachedTokens: "0.1" },
  }, { priceCards: [OPENAI_STANDARD] });
  const partial = priceUsageEvent({
    provider: "openai",
    model: "gpt-test",
    components: { inputUncachedTokens: "0.2", futureTokens: "1" },
  }, { priceCards: [OPENAI_STANDARD] });
  const aggregate = aggregateCostResults([full, partial]);

  assert.equal(aggregate.totalUsd, "0.00000075");
  assert.equal(aggregate.coverageStatus, "partially_priced");
  assert.deepEqual(aggregate.coverageCounts, {
    fullyPriced: 1,
    partiallyPriced: 1,
    unpriced: 0,
    pricedComponents: 2,
    unpricedComponents: 1,
    unavailableComponents: 0,
  });
  assert.equal(typeof aggregate.totalUsd, "string");
});
