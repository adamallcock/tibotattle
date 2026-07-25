import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost, compilePriceCatalog } from "runcost";
import {
  ANTHROPIC_OFFICIAL_PRICE_CARDS,
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  APP_PRICE_REGISTRY_SHA256,
  OPENAI_OFFICIAL_PRICE_CARDS,
  addOfficialPriceRegistry,
  validateOfficialPriceRegistry,
} from "../src/price-registry.js";

function price({ provider, model, tier = "standard", pricedAt = "2026-07-25", components, totalInputTokens }) {
  return calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider,
      surface: provider === "openai" ? "openai.responses" : "anthropic.messages",
      model: { requested: model },
      context: {
        service_tier: tier,
        region: "global",
        priced_at: pricedAt,
        ...(totalInputTokens === undefined ? {} : { total_input_tokens: String(totalInputTokens) }),
      },
      components: Object.entries(components).map(([name, quantity]) => ({
        name,
        quantity: String(quantity),
        unit: "token",
      })),
    },
    priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
    // Compatibility mode returns RunCost's structured warnings so the registry's
    // intentionally unpriced boundaries can be asserted below. Production callers
    // can use strict mode to turn the same warnings into failures.
    mode: "compatibility",
  });
}

test("registry validates and preserves exact decimal strings and provenance", () => {
  assert.equal(validateOfficialPriceRegistry(), APP_OFFICIAL_PRICE_CARDS);
  assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.length, 31);
  assert.equal(ANTHROPIC_OFFICIAL_PRICE_CARDS.length, 13);
  const batch54 = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => card.model === "gpt-5.4" && card.service_tier === "batch");
  assert.equal(batch54.components.find((item) => item.usage_component === "input_cache_read_tokens").price.amount, "0.13");
  assert.match(batch54.metadata.provenance.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.match(APP_PRICE_REGISTRY_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sha256, APP_PRICE_REGISTRY_SHA256);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sources.length, 2);
  assert.equal(batch54.metadata.provenance.vendor_effective_from, null);
  assert.equal(batch54.effective.from, "2026-07-25");
});

test("exact provider tool units use official call prices without pricing client wrappers", () => {
  const openAi = calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider: "openai",
      surface: "openai.responses",
      model: { requested: "gpt-5.6-luna" },
      context: { service_tier: "standard", priced_at: "2026-07-25" },
      components: [
        { name: "web_search_units", quantity: "1000", unit: "search" },
        { name: "file_search_units", quantity: "1000", unit: "call" },
      ],
    },
    priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
    mode: "compatibility",
  });
  assert.equal(openAi.total, "12.5");
  assert.equal(openAi.warnings.length, 0);

  const anthropic = calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider: "anthropic",
      surface: "anthropic.messages",
      model: { requested: "claude-sonnet-4-6" },
      context: { service_tier: "standard", priced_at: "2026-07-25" },
      components: [{ name: "web_search_units", quantity: "1000", unit: "search" }],
    },
    priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
    mode: "compatibility",
  });
  assert.equal(anthropic.total, "10");
  assert.equal(anthropic.warnings.length, 0);
});

test("OpenAI official Standard, Batch, Flex, and Priority rows price exact components", () => {
  const expected = {
    "gpt-5.6-sol": {
      standard: ["5", "0.5", "6.25", "30", "41.75"],
      batch: ["2.5", "0.25", "3.125", "15", "20.875"],
      flex: ["2.5", "0.25", "3.125", "15", "20.875"],
      priority: ["10", "1", "12.5", "60", "83.5"],
    },
    "gpt-5.6-terra": {
      standard: ["2.5", "0.25", "3.125", "15", "20.875"],
      batch: ["1.25", "0.125", "1.5625", "7.5", "10.4375"],
      flex: ["1.25", "0.125", "1.5625", "7.5", "10.4375"],
      priority: ["5", "0.5", "6.25", "30", "41.75"],
    },
    "gpt-5.6-luna": {
      standard: ["1", "0.1", "1.25", "6", "8.35"],
      batch: ["0.5", "0.05", "0.625", "3", "4.175"],
      flex: ["0.5", "0.05", "0.625", "3", "4.175"],
      priority: ["2", "0.2", "2.5", "12", "16.7"],
    },
  };
  const names = [
    "input_uncached_tokens",
    "input_cache_read_tokens",
    "input_cache_write_tokens",
    "output_reasoning_tokens",
  ];
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, values] of Object.entries(tiers)) {
      for (let index = 0; index < names.length; index += 1) {
        const single = price({
          provider: "openai",
          model,
          tier,
          components: { [names[index]]: 1_000_000 },
        });
        assert.equal(single.total, values[index], `${model}/${tier}/${names[index]}`);
        assert.equal(single.warnings.length, 0);
      }
      const result = price({
        provider: "openai",
        model,
        tier,
        components: Object.fromEntries(names.map((name) => [name, 1_000_000])),
      });
      assert.equal(result.total, values[4], `${model}/${tier}/combined`);
      assert.equal(result.warnings.length, 0);
    }
  }
});

test("OpenAI short-context rows enforce every tier at the 272K threshold", () => {
  const expected = {
    "gpt-5.5": {
      standard: "35.5",
      batch: "17.75",
      flex: "17.75",
      priority: "88.75",
    },
    "gpt-5.4": {
      standard: "17.75",
      batch: "8.88",
      flex: "8.88",
      priority: "35.5",
    },
  };
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, total] of Object.entries(tiers)) {
      const below = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 271_999,
        components: {
          input_uncached_tokens: 1_000_000,
          input_cache_read_tokens: 1_000_000,
          output_text_tokens: 1_000_000,
        },
      });
      assert.equal(below.total, total, `${model}/${tier}/below-threshold`);
      assert.equal(below.warnings.length, 0);

      const atThreshold = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 272_000,
        components: {
          input_uncached_tokens: 1_000_000,
          input_cache_read_tokens: 1_000_000,
          output_text_tokens: 1_000_000,
        },
      });
      assert.equal(atThreshold.total, "0", `${model}/${tier}/at-threshold`);
      assert.ok(atThreshold.warnings.some((warning) => (
        warning.code === "long_context_rule_missing"
      )));
    }
  }
});

test("OpenAI official rows do not silently alias subscription Fast to API Priority", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const result = price({
      provider: "openai",
      model,
      tier: "fast",
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(result.total, "0");
    assert.ok(result.warnings.some((warning) => warning.code === "service_tier_unsupported"));
  }
});

test("GPT-5.5 Codex alias is explicit and is not a separate official model claim", () => {
  const result = price({
    provider: "openai",
    model: "gpt-5.5-codex",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    totalInputTokens: 1000,
  });
  assert.equal(result.total, "35");
  assert.equal(result.model.billed, "gpt-5.5");
  assert.ok(result.warnings.some((warning) => warning.code === "alias_inferred"));
  const card = OPENAI_OFFICIAL_PRICE_CARDS.find((item) => item.model === "gpt-5.5" && item.service_tier === "standard");
  assert.match(card.metadata.alias_assumptions["gpt-5.5-codex"], /Assumed/);
});

test("missing official components and unsupported tiers fail closed", () => {
  const omittedCache = price({
    provider: "openai",
    model: "gpt-4.1",
    tier: "batch",
    components: { input_cache_read_tokens: 1_000_000 },
  });
  assert.equal(omittedCache.total, "0");
  assert.ok(omittedCache.warnings.some((warning) => warning.code === "component_unpriced"));

  const unsupportedFlex = price({
    provider: "openai",
    model: "gpt-4.1",
    tier: "flex",
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(unsupportedFlex.total, "0");
  assert.ok(unsupportedFlex.warnings.some((warning) => warning.code === "service_tier_unsupported"));
});

test("OpenAI rows marked below 272K do not invent long-context prices", () => {
  const result = price({
    provider: "openai",
    model: "gpt-5.5",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    totalInputTokens: 272000,
  });
  assert.equal(result.total, "0");
  assert.ok(result.warnings.some((warning) => warning.code === "long_context_rule_missing"));
});

test("Anthropic cache categories, Batch modifiers, and first-party API Fast are exact", () => {
  const standard = price({
    provider: "anthropic",
    model: "claude-opus-4-8",
    components: {
      input_uncached_tokens: 1_000_000,
      input_cache_write_tokens: 1_000_000,
      input_cache_write_1h_tokens: 1_000_000,
      input_cache_read_tokens: 1_000_000,
      output_text_tokens: 1_000_000,
    },
  });
  assert.equal(standard.total, "46.75");

  const batch = price({
    provider: "anthropic",
    model: "claude-opus-4-8",
    tier: "batch",
    components: { input_cache_write_1h_tokens: 1_000_000, output_text_tokens: 1_000_000 },
  });
  assert.equal(batch.total, "17.5");

  const fast = price({
    provider: "anthropic",
    model: "claude-opus-4-8",
    tier: "fast",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
  });
  assert.equal(fast.total, "60");
  const fastCard = ANTHROPIC_OFFICIAL_PRICE_CARDS.find((card) => card.model === "claude-opus-4-8" && card.service_tier === "fast");
  assert.equal(fastCard.metadata.subscription_speed_tier, null);
  assert.match(fastCard.metadata.coverage_note, /first-party API fast mode/);
});

test("Claude Sonnet 5 pricing changes at the official September 1 boundary", () => {
  const august = price({
    provider: "anthropic",
    model: "claude-sonnet-5",
    pricedAt: "2026-08-31",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
  });
  const september = price({
    provider: "anthropic",
    model: "claude-sonnet-5",
    pricedAt: "2026-09-01",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
  });
  assert.equal(august.total, "12");
  assert.equal(september.total, "18");
  const future = ANTHROPIC_OFFICIAL_PRICE_CARDS.find((card) => card.model === "claude-sonnet-5" && card.service_tier === "standard" && card.effective.from === "2026-09-01");
  assert.equal(future.metadata.provenance.vendor_effective_from, "2026-09-01");
});

test("undated price evidence refuses pre-observation historical pricing", () => {
  const result = price({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    pricedAt: "2026-07-24",
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(result.total, "0");
  assert.ok(result.warnings.some((warning) => warning.code === "historical_price_missing"));
});

test("validation rejects unsupported tiers, absent provenance, overlaps, and destructive aliases", () => {
  const [base] = OPENAI_OFFICIAL_PRICE_CARDS;
  const withoutProvenance = structuredClone(base);
  delete withoutProvenance.metadata.provenance.evidence_sha256;
  assert.throws(() => validateOfficialPriceRegistry([withoutProvenance]), /provenance/);

  const invalidTier = structuredClone(base);
  invalidTier.service_tier = "fast";
  assert.throws(() => validateOfficialPriceRegistry([invalidTier]), /unsupported API service tier/);

  const overlap = structuredClone(base);
  overlap.id = `${base.id}:duplicate`;
  assert.throws(() => validateOfficialPriceRegistry([base, overlap]), /overlap in the same pricing context/);

  const destructiveAlias = structuredClone(base);
  destructiveAlias.id = `${base.id}:alias-collision`;
  destructiveAlias.model = "another-model";
  destructiveAlias.aliases = [base.model];
  assert.throws(() => validateOfficialPriceRegistry([base, destructiveAlias]), /destructively overlaps canonical model/);
});

test("registry augmentation retains existing cards instead of replacing every card for a model", () => {
  const external = {
    schema_version: "0.1",
    id: "external:gpt-5.6-sol:private-contract",
    provider: "openai",
    model: "gpt-5.6-sol",
    service_tier: "standard",
    region: "private-contract",
    components: [],
    source: { name: "private-contract" },
  };
  const result = addOfficialPriceRegistry({
    selected_source: "external",
    price_cards: [external],
    sources: [],
  });
  assert.ok(result.price_cards.includes(external));
  assert.equal(result.price_cards.filter((card) => card.id === external.id).length, 1);
  assert.match(result.selected_source, /app-official-price-registry/);
});
