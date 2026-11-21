import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_OFFICIAL_PRICE_CARDS,
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

test("Astra prices separate cache writes and combined output once with event-time context", () => {
  const event = {
    timestamp: "2026-09-03T12:00:00.000Z", model: "gpt-6-astra",
    totalInputContextTokens: 272_000, raw: { input_tokens: 999_999 },
    components: { input_uncached_tokens: 100_000, input_cache_read_tokens: 100_000,
      input_cache_write_tokens: 72_000, output_text_tokens: 40_000, output_reasoning_tokens: 60_000 },
    componentAvailability: { input_uncached_tokens: true, input_cache_read_tokens: true,
      input_cache_write_tokens: true, output_text_tokens: true, output_reasoning_tokens: true },
  };
  assert.equal(priceCodexUsageEvent(event).totalUsd, "7");
  assert.equal(priceCodexUsageEvent(event, { apiServiceTier: "priority" }).totalUsd, "14");
  assert.equal(priceCodexUsageEvent({ ...event, totalInputContextTokens: 272_001 }).totalUsd, "11.5");
  const missing = priceCodexUsageEvent({ ...event, componentAvailability: {
    ...event.componentAvailability, input_cache_write_tokens: false,
  } });
  assert.equal(missing.coverageStatus, "partially_priced");
  assert.equal(missing.coverageCounts.unavailableComponents, 1);
  const old = priceCodexUsageEvent({ ...event, timestamp: "2026-09-02T12:00:00.000Z" });
  assert.notEqual(old.coverageStatus, "fully_priced");
  assert.equal(priceCodexUsageEvent(event, { priceEpochBasis: "current_price_sensitivity" }).totalUsd, "7");
});

test("Sol and Luna event pricing counts cache writes and reasoning once and preserves unknown history", () => {
  for (const [model, short, fast, long] of [
    ["gpt-6-sol", "1.4", "2.8", "2.3"],
    ["gpt-6-luna", "0.07", "0.14", "0.115"],
  ]) {
    const event = {
      timestamp: "2026-09-22T12:00:00.000Z", model,
      totalInputContextTokens: 272_000, raw: { input_tokens: 999_999 },
      components: { input_uncached_tokens: 100_000, input_cache_read_tokens: 100_000,
        input_cache_write_tokens: 72_000, output_text_tokens: 40_000, output_reasoning_tokens: 60_000 },
      componentAvailability: { input_uncached_tokens: true, input_cache_read_tokens: true,
        input_cache_write_tokens: true, output_text_tokens: true, output_reasoning_tokens: true },
    };
    assert.equal(priceCodexUsageEvent(event).totalUsd, short);
    assert.equal(priceCodexUsageEvent(event, { apiServiceTier: "priority" }).totalUsd, fast);
    assert.equal(priceCodexUsageEvent({ ...event, totalInputContextTokens: 272_001 }).totalUsd, long);
    assert.equal(priceCodexUsageEvent(event, { priceEpochBasis: "current_price_sensitivity" }).totalUsd, short);
    const beforeLaunch = priceCodexUsageEvent({ ...event, timestamp: "2026-09-21T23:59:59.999Z" });
    assert.notEqual(beforeLaunch.coverageStatus, "fully_priced");
    assert.equal(beforeLaunch.totalUsd, "0");
    const missing = priceCodexUsageEvent({ ...event, componentAvailability: {
      ...event.componentAvailability, input_cache_write_tokens: false,
    } });
    assert.equal(missing.coverageStatus, "partially_priced");
    assert.equal(missing.coverageCounts.unavailableComponents, 1);
  }
});

test("Sol 6.1, Terra 6.1 and Astra Ultrafast preserve exact event-time token accounting", () => {
  const expected = [
    ["gpt-6.1-terra", "standard", "0.695", "1.14"],
    ["gpt-6.1-terra", "batch", "0.3475", "0.57"],
    ["gpt-6.1-terra", "flex", "0.3475", "0.57"],
    ["gpt-6.1-terra", "priority", "1.39", "2.28"],
    ["gpt-6.1-sol", "standard", "1.39", "2.28"],
    ["gpt-6.1-sol", "batch", "0.695", "1.14"],
    ["gpt-6.1-sol", "flex", "0.695", "1.14"],
    ["gpt-6.1-sol", "priority", "2.78", "4.56"],
    ["gpt-6.1-sol", "ultrafast", "8.34", "13.68"],
    ["gpt-6-astra", "ultrafast", "42", "69"],
  ];
  for (const [model, apiServiceTier, short, long] of expected) {
    const launchDate = model === "gpt-6.1-terra" ? "2026-10-26"
      : model === "gpt-6.1-sol" && apiServiceTier === "ultrafast" ? "2026-10-08"
      : "2026-09-29";
    const event = {
      timestamp: `${launchDate}T00:00:00.000Z`, model,
      totalInputContextTokens: 272_000, raw: { input_tokens: 999_999 },
      components: { input_uncached_tokens: 100_000, input_cache_read_tokens: 100_000,
        input_cache_write_tokens: 72_000, output_text_tokens: 40_000, output_reasoning_tokens: 60_000 },
      componentAvailability: { input_uncached_tokens: true, input_cache_read_tokens: true,
        input_cache_write_tokens: true, output_text_tokens: true, output_reasoning_tokens: true },
    };
    const atLaunch = priceCodexUsageEvent(event, { apiServiceTier });
    assert.equal(atLaunch.totalUsd, short, `${model}/${apiServiceTier}/short`);
    assert.equal(atLaunch.coverageStatus, "fully_priced");
    assert.equal(priceCodexUsageEvent({ ...event, totalInputContextTokens: 272_001 },
      { apiServiceTier }).totalUsd, long, `${model}/${apiServiceTier}/long`);
    assert.equal(priceCodexUsageEvent(event, { apiServiceTier,
      priceEpochBasis: "current_price_sensitivity" }).totalUsd, short);
    const beforeLaunch = priceCodexUsageEvent({ ...event,
      timestamp: new Date(Date.parse(event.timestamp) - 1).toISOString() },
      { apiServiceTier });
    assert.equal(beforeLaunch.totalUsd, "0");
    assert.equal(beforeLaunch.coverageStatus, "unpriced");
    const unavailableCacheWrites = priceCodexUsageEvent({ ...event, componentAvailability: {
      ...event.componentAvailability, input_cache_write_tokens: false,
    } }, { apiServiceTier });
    assert.equal(unavailableCacheWrites.coverageStatus, "partially_priced");
    assert.equal(unavailableCacheWrites.coverageCounts.unavailableComponents, 1);
  }
});

test("unpublished Ultrafast pairs never borrow Standard prices or Astra's multiplier", () => {
  for (const model of ["gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-6.2-astra-law"]) {
    for (const totalInputContextTokens of [272_000, 272_001]) {
      const result = priceCodexUsageEvent({
        timestamp: "2026-10-26T12:00:00.000Z", model, totalInputContextTokens,
        components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
      }, { apiServiceTier: "ultrafast" });
      assert.equal(result.totalUsd, "0", `${model}/${totalInputContextTokens}`);
      assert.equal(result.coverageStatus, "unpriced");
      assert.deepEqual(result.selectedPriceCardIds, []);
      assert.ok(result.warnings.coverage.some((warning) => warning.code === "service_tier_exact_card_missing"));
      assert.ok(result.components.every((component) => component.reasonCode === "service_tier_exact_card_missing"));
    }
  }
});

test("context-dependent Terra 6.1, Sol 6.1 and Astra rates require observed input context", () => {
  const prices = [
    ["gpt-6.1-terra", "standard", "0.005", "0.0075"],
    ["gpt-6.1-terra", "batch", "0.0025", "0.00375"],
    ["gpt-6.1-terra", "flex", "0.0025", "0.00375"],
    ["gpt-6.1-terra", "priority", "0.01", "0.015"],
    ["gpt-6.1-sol", "standard", "0.01", "0.015"],
    ["gpt-6.1-sol", "batch", "0.005", "0.0075"],
    ["gpt-6.1-sol", "flex", "0.005", "0.0075"],
    ["gpt-6.1-sol", "priority", "0.02", "0.03"],
    ["gpt-6-astra", "standard", "0.05", "0.075"],
    ["gpt-6-astra", "priority", "0.1", "0.15"],
    ["gpt-6-astra", "ultrafast", "0.3", "0.45"],
  ];
  for (const [model, apiServiceTier, short, long] of prices) {
    const event = {
      timestamp: model === "gpt-6.1-terra" ? "2026-10-26T00:00:00.000Z" : "2026-09-29T00:00:00.000Z",
      model, totalInputContextTokens: null,
      components: { input_uncached_tokens: null, input_cache_read_tokens: null,
        input_cache_write_tokens: null, output_text_tokens: 600, output_reasoning_tokens: 400 },
    };
    for (const missing of [event, {
      ...event,
      raw: { input_tokens: 0 }, rawAvailability: { input_tokens: false },
      components: { ...event.components, input_uncached_tokens: 0, input_cache_read_tokens: 0, input_cache_write_tokens: 0 },
      componentAvailability: { input_uncached_tokens: false, input_cache_read_tokens: false, input_cache_write_tokens: false },
    }, { ...event, components: { output_text_tokens: 600, output_reasoning_tokens: 400 } }, {
      ...event, components: { ...event.components, input_uncached_tokens: 10 },
    }]) {
      const result = priceCodexUsageEvent(missing, { apiServiceTier });
      assert.equal(result.coverageStatus, "unpriced", `${model}/${apiServiceTier}`);
      assert.equal(result.totalUsd, "0");
      assert.deepEqual(result.selectedPriceCardIds, []);
      assert.ok(result.components.filter((component) => component.pricingStatus === "unpriced")
        .every((component) => component.reasonCode === "total_input_context_missing"));
      assert.ok(result.warnings.coverage.some((warning) => warning.code === "total_input_context_missing"));
      assert.equal(result.warnings.coverage.some((warning) => warning.code === "unknown_model"), false);
    }
    for (const [totalInputContextTokens, expected] of [[272_000, short], [272_001, long]]) {
      for (const known of [
        { ...event, totalInputContextTokens },
        { ...event, raw: { input_tokens: totalInputContextTokens } },
        { ...event, raw: { input_tokens: totalInputContextTokens }, rawAvailability: { input_tokens: true } },
      ]) {
        const result = priceCodexUsageEvent(known, { apiServiceTier });
        assert.equal(result.coverageStatus, "partially_priced");
        assert.equal(result.totalUsd, expected, `${model}/${apiServiceTier}/${totalInputContextTokens}`);
        assert.equal(result.coverageCounts.unavailableComponents, 3);
        assert.equal(result.warnings.coverage.some((warning) => warning.code === "total_input_context_missing"), false);
      }
    }
    const knownZero = priceCodexUsageEvent({ ...event,
      components: { ...event.components, input_uncached_tokens: 0, input_cache_read_tokens: 0, input_cache_write_tokens: 0 },
    }, { apiServiceTier });
    assert.equal(knownZero.coverageStatus, "fully_priced");
    assert.equal(knownZero.totalUsd, short);
    assert.equal(knownZero.methodVersion, "provider-neutral-api-price-equivalent-v0.3");
  }
});

test("GPT-6.2 prices every observed component in both context bands at every supported tier", () => {
  const rates = {
    "gpt-6.2-astra": {
      standard: [["8", "0.4", "10", "40"], ["16", "0.8", "20", "60"]],
      batch: [["4", "0.2", "5", "20"], ["8", "0.4", "10", "30"]],
      priority: [["16", "0.8", "20", "80"], ["32", "1.6", "40", "120"]],
      promo: [["24", "1.2", "30", "120"], ["48", "2.4", "60", "180"]],
      list: [["48", "2.4", "60", "240"], ["96", "4.8", "120", "360"]],
    },
    "gpt-6.2-sol": {
      standard: [["2", "0.1", "2.5", "10"], ["4", "0.2", "5", "15"]],
      batch: [["1", "0.05", "1.25", "5"], ["2", "0.1", "2.5", "7.5"]],
      priority: [["4", "0.2", "5", "20"], ["8", "0.4", "10", "30"]],
      promo: [["6", "0.3", "7.5", "30"], ["12", "0.6", "15", "45"]],
      list: [["12", "0.6", "15", "60"], ["24", "1.2", "30", "90"]],
    },
  };
  const components = {
    input_uncached_tokens: 1_000_000,
    input_cache_read_tokens: 1_000_000,
    input_cache_write_tokens: 1_000_000,
    output_text_tokens: 1_000_000,
  };
  const testTiers = [
    ["standard", "standard", "2026-11-17T00:00:00.000Z"],
    ["batch", "batch", "2026-11-17T00:00:00.000Z"],
    ["priority", "priority", "2026-11-17T00:00:00.000Z"],
    ["fast", "priority", "2026-11-17T00:00:00.000Z"],
    ["ultrafast", "list", "2027-03-01T08:00:00.000Z"],
    ["ultrafast", "promo", "2027-03-01T07:59:59.999Z"],
    ["ultrafast", "promo", "2026-11-17T00:00:00.000Z"],
    ["ultrafast", "list", "2027-03-01T08:00:00.001Z"],
  ];
  for (const [model, modelRates] of Object.entries(rates)) {
    for (const [apiServiceTier, rate, timestamp] of testTiers) {
      for (const totalInputContextTokens of [271_999, 272_000, 272_001]) {
        const event = { model, timestamp, totalInputContextTokens, components };
        const result = priceCodexUsageEvent(event, { apiServiceTier });
        const expected = modelRates[rate][totalInputContextTokens > 272_000 ? 1 : 0];
        for (const [index, name] of Object.keys(components).entries()) {
          assert.equal(result.components.find((part) => part.name === name).costUsd, expected[index],
            [model, apiServiceTier, timestamp, totalInputContextTokens, name].join("/"));
        }
        assert.equal(result.totalUsd, addUsdStrings(...expected));
        assert.equal(result.coverageStatus, "fully_priced");
        assert.equal(result.selectedPriceCardIds.length, 1);
        if (apiServiceTier === "ultrafast") assert.ok(result.selectedPriceCardIds[0].includes(rate));
        const prior = priceCodexUsageEvent({ ...event, timestamp: "2026-11-16T23:59:59.999Z" }, { apiServiceTier });
        assert.equal(prior.coverageStatus, "unpriced");
        assert.ok(prior.warnings.coverage.some((warning) => warning.code === "historical_price_missing"));
      }
    }
    const event = {
      model, timestamp: "2027-03-01T08:00:00.000Z", totalInputContextTokens: 272_000, components,
    };
    assert.equal(priceCodexUsageEvent(event, {
      priceEpochBasis: "current_price_sensitivity", apiServiceTier: "ultrafast",
    }).totalUsd, addUsdStrings(...modelRates.promo[0]));
    for (const [input, tier, warningCode] of [
      [{ ...event, timestamp: undefined }, "ultrafast", "historical_price_timestamp_missing"],
      [{ ...event, timestamp: "2027-03-01" }, "ultrafast", "historical_price_timestamp_missing"],
      [{ ...event, totalInputContextTokens: null, components: { output_text_tokens: 1_000_000 } },
        "ultrafast", "total_input_context_missing"],
      [event, "flex", "service_tier_exact_card_missing"],
    ]) {
      const zero = Object.fromEntries(Object.keys(input.components).map((name) => [name, 0]));
      for (const observed of [input.components, zero]) {
        const result = priceCodexUsageEvent({ ...input, components: observed }, { apiServiceTier: tier });
        assert.equal(result.coverageStatus, "unpriced");
        assert.ok(result.warnings.coverage.some((warning) => warning.code === warningCode));
      }
    }
  }
});

test("GPT-6.2 Astra for Law only prices the independently documented Standard window", () => {
  const event = {
    model: "gpt-6.2-astra-law", totalInputContextTokens: 272_000,
    timestamp: "2026-12-31T23:59:59.999Z",
    components: { input_uncached_tokens: 100_000, input_cache_read_tokens: 100_000,
      input_cache_write_tokens: 72_000, output_text_tokens: 40_000, output_reasoning_tokens: 60_000 },
  };
  for (const [context, total] of [[272_000, "5.56"], [272_001, "9.12"]]) {
    const priced = priceCodexUsageEvent({ ...event, totalInputContextTokens: context });
    assert.equal(priced.coverageStatus, "fully_priced");
    assert.equal(priced.totalUsd, total);
    assert.equal(priced.selectedPriceCardIds.length, 1);
    assert.match(priced.selectedPriceCardIds[0], /gpt-6.2-astra-law:standard/u);
  }
  for (const timestamp of ["2026-11-16T23:59:59.999Z", "2027-01-01T00:00:00.000Z"]) {
    for (const components of [event.components, { output_text_tokens: 0 }]) {
      const unknown = priceCodexUsageEvent({ ...event, timestamp, components });
      assert.equal(unknown.coverageStatus, "unpriced");
      assert.ok(unknown.warnings.coverage.some((warning) => warning.code === "historical_price_missing"));
    }
  }
  for (const apiServiceTier of ["priority", "fast", "batch", "flex", "ultrafast"]) {
    for (const components of [event.components, { output_text_tokens: 0 }]) {
      const result = priceCodexUsageEvent({ ...event, components }, { apiServiceTier });
      assert.equal(result.coverageStatus, "unpriced");
      assert.deepEqual(new Set(result.warnings.coverage.map((warning) => warning.code)),
        new Set(["service_tier_exact_card_missing"]));
      assert.equal(result.ledger.warnings.some((warning) => warning.code === "unknown_model"), false);
    }
  }
  const unknown = priceCodexUsageEvent({ ...event, model: "unreviewed-law-model" }, { apiServiceTier: "fast" });
  assert.equal(unknown.coverageStatus, "unpriced");
  assert.ok(unknown.warnings.coverage.some((warning) => warning.code === "unknown_model"));
  assert.ok(unknown.ledger.warnings.some((warning) => warning.code === "unknown_model"));
});

test("OpenAI Fast retains an exact caller-supplied tier card", () => {
  const source = APP_OFFICIAL_PRICE_CARDS.find((card) => card.model === "gpt-6.2-sol"
    && card.service_tier === "priority" && card.metadata.total_input_context_band === "short");
  const card = { ...source, id: "caller-openai-fast", service_tier: "fast" };
  const result = priceCodexUsageEvent({
    model: "gpt-6.2-sol", totalInputContextTokens: 1,
    timestamp: "2026-11-21T12:00:00.000Z", components: { output_text_tokens: 1_000 },
  }, { apiServiceTier: "fast", priceCards: [card] });
  assert.equal(result.coverageStatus, "fully_priced");
  assert.equal(result.totalUsd, "0.02");
  assert.equal(result.pricingContext.serviceTier, "fast");
  assert.deepEqual(result.selectedPriceCardIds, [card.id]);
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
