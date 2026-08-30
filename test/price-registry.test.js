import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost, compilePriceCatalog } from "runcost/browser";
import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  OPENAI_PRICE_EVIDENCE_START_DATE,
} from "../packages/accounting/index.js";
import {
  ANTHROPIC_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_SHA256,
  NORMALIZED_PRICE_EVIDENCE_ROWS,
  OPENAI_OFFICIAL_PRICE_CARDS,
  PROVIDER_TOOL_PRICE_CARDS,
  addOfficialPriceRegistry,
  validateOfficialPriceRegistry,
} from "../packages/accounting/src/price-registry.js";
import { sha256Json } from "./helpers/pricing-hash.js";

function price({ provider, model, tier = "standard", pricedAt = "2026-07-26", components, totalInputTokens }) {
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
  assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.length, 122);
  assert.equal(ANTHROPIC_OFFICIAL_PRICE_CARDS.length, 13);
  const batch54 = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => card.model === "gpt-5.4" && card.service_tier === "batch");
  assert.equal(batch54.components.find((item) => item.usage_component === "input_cache_read_tokens").price.amount, "0.13");
  assert.match(batch54.metadata.provenance.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.match(APP_PRICE_REGISTRY_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sha256, APP_PRICE_REGISTRY_SHA256);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sources.length, 2);
  assert.equal(batch54.metadata.provenance.vendor_effective_from, null);
  assert.equal(OPENAI_PRICE_EVIDENCE_START_DATE, "2026-07-26");
  assert.equal(batch54.effective.from, undefined);
  assert.equal(
    batch54.metadata.provenance.evidence_urls.some((url) => url.endsWith("/models/gpt-5.4")),
    true,
  );
  assert.equal(
    sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openai),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.provider === "openai").evidenceSha256,
  );
  assert.equal(
    sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.anthropic),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.provider === "anthropic").evidenceSha256,
  );
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS), APP_PRICE_REGISTRY_SHA256);
});

test("exact provider tool units use official call prices without pricing client wrappers", () => {
  const openAi = calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider: "openai",
      surface: "openai.responses",
      model: { requested: "gpt-5.6-luna" },
      context: { service_tier: "standard", priced_at: "2026-07-26" },
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
      context: { service_tier: "standard", priced_at: "2026-07-26" },
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
          totalInputTokens: 271_999,
          components: { [names[index]]: 1_000_000 },
        });
        assert.equal(single.total, values[index], `${model}/${tier}/${names[index]}`);
        assert.equal(single.warnings.length, 0);
      }
      const result = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 271_999,
        components: Object.fromEntries(names.map((name) => [name, 1_000_000])),
      });
      assert.equal(result.total, values[4], `${model}/${tier}/combined`);
      assert.equal(result.warnings.length, 0);
    }
  }
});

test("OpenAI short and long context rows meet the exact 272K boundary without inventing Priority long rates", () => {
  const expectedShort = {
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
  const expectedLong = {
    "gpt-5.5": {
      standard: "56",
      batch: "28",
      flex: "28",
      priority: null,
    },
    "gpt-5.4": {
      standard: "28",
      batch: "14.01",
      flex: "14.01",
      priority: null,
    },
  };
  for (const [model, tiers] of Object.entries(expectedShort)) {
    for (const [tier, shortTotal] of Object.entries(tiers)) {
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
      assert.equal(below.total, shortTotal, `${model}/${tier}/below-threshold`);
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
      const longTotal = expectedLong[model][tier];
      assert.equal(atThreshold.total, longTotal ?? "0", `${model}/${tier}/at-threshold`);
      if (longTotal === null) {
        assert.ok(atThreshold.warnings.some((warning) => (
          warning.code === "long_context_rule_missing"
        )));
      } else {
        assert.equal(atThreshold.warnings.length, 0);
      }
    }
  }
});

test("GPT-5.6 context bands apply exact official long multipliers and fail closed for Priority long context", () => {
  const expected = {
    "gpt-5.6-sol": { standard: "56", batch: "28", flex: "28" },
    "gpt-5.6-terra": { standard: "28", batch: "14", flex: "14" },
    "gpt-5.6-luna": { standard: "11.2", batch: "5.6", flex: "5.6" },
  };
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, total] of Object.entries(tiers)) {
      const result = price({
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
      assert.equal(result.total, total, `${model}/${tier}/long`);
      assert.equal(result.warnings.length, 0);
    }
    const priority = price({
      provider: "openai",
      model,
      tier: "priority",
      totalInputTokens: 272_000,
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(priority.total, "0", `${model}/priority/long`);
    assert.ok(priority.warnings.some((warning) => warning.code === "long_context_rule_missing"));
  }
});

test("GPT-5.6 Priority long-context rows price only from their published boundaries", () => {
  // The Fast (priority) tab first showed long-context rates in the 2026-08-30
  // review. Terra and Luna rows carry the 2026-07-30 repricing boundary; Sol's
  // carries its own 2026-08-21 repricing boundary. Before each boundary the
  // priority long context stays deliberately unpriced (asserted above at the
  // default 2026-07-26 pricing date).
  const expected = {
    "gpt-5.6-terra": { pricedAt: "2026-08-01", total: "44" },
    "gpt-5.6-luna": { pricedAt: "2026-08-01", total: "4.4" },
    "gpt-5.6-sol": { pricedAt: "2026-08-22", total: "76" },
  };
  for (const [model, { pricedAt, total }] of Object.entries(expected)) {
    const result = price({
      provider: "openai",
      model,
      tier: "priority",
      pricedAt,
      totalInputTokens: 272_000,
      components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    });
    assert.equal(result.total, total, `${model}/priority/long/${pricedAt}`);
    assert.equal(result.warnings.length, 0, `${model}/priority/long/${pricedAt}/warnings`);
  }
  const solBeforeBoundary = price({
    provider: "openai",
    model: "gpt-5.6-sol",
    tier: "priority",
    pricedAt: "2026-08-20",
    totalInputTokens: 272_000,
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(solBeforeBoundary.total, "0");
  assert.ok(solBeforeBoundary.warnings.some((warning) => warning.code === "long_context_rule_missing"));
});

test("GPT-5.6 Sol pricing changes at the owner-stated August 21 boundary", () => {
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  const cases = [
    { tier: "standard", before: "35", after: "24" },
    { tier: "batch", before: "17.5", after: "12" },
    { tier: "priority", before: "70", after: "48" },
  ];
  for (const { tier, before, after } of cases) {
    const closed = price({ provider: "openai", model: "gpt-5.6-sol", tier, pricedAt: "2026-08-20", totalInputTokens: 1000, components });
    const open = price({ provider: "openai", model: "gpt-5.6-sol", tier, pricedAt: "2026-08-21", totalInputTokens: 1000, components });
    assert.equal(closed.total, before, `sol/${tier}/2026-08-20`);
    assert.equal(closed.warnings.length, 0, `sol/${tier}/2026-08-20/warnings`);
    assert.equal(open.total, after, `sol/${tier}/2026-08-21`);
    assert.equal(open.warnings.length, 0, `sol/${tier}/2026-08-21/warnings`);
  }
  // The Flex tab was not captured in the 2026-08-30 review, so Sol flex is
  // priced through 2026-08-20 and deliberately unpriced afterwards.
  const flexBefore = price({ provider: "openai", model: "gpt-5.6-sol", tier: "flex", pricedAt: "2026-08-20", totalInputTokens: 1000, components });
  assert.equal(flexBefore.total, "17.5");
  const flexAfter = price({ provider: "openai", model: "gpt-5.6-sol", tier: "flex", pricedAt: "2026-08-21", totalInputTokens: 1000, components });
  assert.equal(flexAfter.total, "0");
});

test("second-table and Codex variant models price at their reviewed rates", () => {
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  const expected = [
    ["gpt-5.2", "standard", "15.75"],
    ["gpt-5.2", "priority", "31.5"],
    ["gpt-5.1", "standard", "11.25"],
    ["gpt-5.1", "priority", "22.5"],
    ["gpt-5-mini", "priority", "4.05"],
    ["gpt-5-nano", "standard", "0.45"],
    ["gpt-4o", "priority", "21.25"],
    ["o3", "batch", "5"],
    ["gpt-5.3-codex", "standard", "15.75"],
    ["gpt-5.2-codex", "standard", "15.75"],
    ["gpt-5.1-codex", "standard", "11.25"],
    // Owner-stated Priority row: 2x the Standard rates, matching base gpt-5.1.
    ["gpt-5.1-codex", "priority", "22.5"],
    ["gpt-5.1-codex-mini", "standard", "2.25"],
    ["gpt-5-codex", "standard", "11.25"],
  ];
  for (const [model, tier, total] of expected) {
    const result = price({ provider: "openai", model, tier, totalInputTokens: 1000, components });
    assert.equal(result.total, total, `${model}/${tier}`);
    assert.equal(result.warnings.length, 0, `${model}/${tier}/warnings`);
  }
  // Batch-only flagship extras keep their uncaptured tiers unpriced.
  const batchOnly = price({ provider: "openai", model: "gpt-5.4-pro", tier: "batch", totalInputTokens: 1000, components });
  assert.equal(batchOnly.total, "105");
  const uncapturedStandard = price({ provider: "openai", model: "gpt-5.4-pro", tier: "standard", totalInputTokens: 1000, components });
  assert.equal(uncapturedStandard.total, "0");
});

test("GPT-5.6 Terra and Luna pricing changes at the official July 30 boundary", () => {
  // Sol was not part of the 2026-07-30 repricing; its totals must not move.
  const expected = {
    "gpt-5.6-terra": { before: "17.5", after: "14" },
    "gpt-5.6-luna": { before: "7", after: "1.4" },
    "gpt-5.6-sol": { before: "35", after: "35" },
  };
  for (const [model, totals] of Object.entries(expected)) {
    const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
    const before = price({ provider: "openai", model, pricedAt: "2026-07-29", totalInputTokens: 1000, components });
    const after = price({ provider: "openai", model, pricedAt: "2026-07-31", totalInputTokens: 1000, components });
    assert.equal(before.total, totals.before, `${model}/2026-07-29`);
    assert.equal(before.warnings.length, 0, `${model}/2026-07-29/warnings`);
    assert.equal(after.total, totals.after, `${model}/2026-07-31`);
    assert.equal(after.warnings.length, 0, `${model}/2026-07-31/warnings`);
  }
  const successor = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => (
    card.model === "gpt-5.6-terra" && card.service_tier === "standard"
      && card.effective.from === "2026-07-30" && card.metadata.total_input_context_band === "short"
  ));
  assert.equal(successor.metadata.provenance.vendor_effective_from, "2026-07-30");
  const closed = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => (
    card.model === "gpt-5.6-terra" && card.service_tier === "standard"
      && card.effective.to === "2026-07-29" && card.metadata.total_input_context_band === "short"
  ));
  assert.equal(closed.metadata.provenance.vendor_effective_to, "2026-07-29");
  assert.equal(closed.effective.from, undefined);
});

test("OpenAI service_tier fast is priced only as an explicitly labeled Priority fallback", () => {
  // OpenAI renamed API Priority processing to Fast mode on 2026-07-30, and
  // RunCost 0.2.1 resolves an OpenAI "fast" request onto Priority cards with
  // an explicit service_tier_resolution marker instead of pricing silently.
  // Subscription speed modes still never reach the engine as API tiers; the
  // worker maps subscription usage to the Standard counterfactual first.
  const expected = {
    "gpt-5.6-sol": { total: "10", cardSuffix: "short-through-2026-08-20" },
    "gpt-5.6-terra": { total: "4", cardSuffix: "short-from-2026-07-30" },
    "gpt-5.6-luna": { total: "0.4", cardSuffix: "short-from-2026-07-30" },
  };
  for (const [model, { total, cardSuffix }] of Object.entries(expected)) {
    const result = price({
      provider: "openai",
      model,
      tier: "fast",
      pricedAt: "2026-07-31",
      totalInputTokens: 1000,
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(result.total, total, model);
    assert.deepEqual(result.metadata.service_tier_resolution, {
      requested: "fast",
      priced_as: "priority",
      fallback: true,
      price_card_ids: [
        `openai:${model}:priority:${cardSuffix}:official-observed-2026-08-30`,
      ],
    }, model);
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

test("OpenAI Priority rows do not invent long-context prices", () => {
  const result = price({
    provider: "openai",
    model: "gpt-5.5",
    tier: "priority",
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
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  // The introductory window is open backwards but still closes at the published
  // vendor change, so old history prices at the introductory rate and events on
  // or after 2026-09-01 select the distinct successor card.
  const totals = { "2026-01-15": "12", "2026-08-31": "12", "2026-09-01": "18", "2026-09-02": "18" };
  const selected = {};
  for (const [pricedAt, total] of Object.entries(totals)) {
    const result = price({ provider: "anthropic", model: "claude-sonnet-5", pricedAt, components });
    assert.equal(result.total, total, pricedAt);
    assert.equal(result.warnings.length, 0, pricedAt);
    selected[pricedAt] = [...new Set(result.components.map((item) => item.price_card_id))].sort().join(",");
    assert.match(selected[pricedAt], /^anthropic:claude-sonnet-5:standard:/, pricedAt);
  }
  assert.equal(selected["2026-01-15"], selected["2026-08-31"]);
  assert.equal(selected["2026-09-01"], selected["2026-09-02"]);
  assert.notEqual(selected["2026-08-31"], selected["2026-09-01"]);

  const introductory = ANTHROPIC_OFFICIAL_PRICE_CARDS.find((card) => card.model === "claude-sonnet-5" && card.service_tier === "standard" && card.effective.to === "2026-08-31");
  assert.equal(introductory.effective.from, undefined);
  assert.equal(introductory.metadata.provenance.vendor_effective_to, "2026-08-31");
  const future = ANTHROPIC_OFFICIAL_PRICE_CARDS.find((card) => card.model === "claude-sonnet-5" && card.service_tier === "standard" && card.effective.from === "2026-09-01");
  assert.equal(future.metadata.provenance.vendor_effective_from, "2026-09-01");
});

test("undated Anthropic price evidence prices history as far back as it goes", () => {
  // The Anthropic review date is provenance, not a validity lower bound: an
  // undated reviewed rate must price a recognized event of any age. Only rows
  // with a published vendor-effective boundary may refuse a date.
  for (const pricedAt of ["2025-06-01", "2026-01-15", "2026-07-24", "2026-07-25"]) {
    const result = price({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      pricedAt,
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(result.total, "3", pricedAt);
    assert.equal(result.warnings.length, 0, pricedAt);
  }
  for (const card of ANTHROPIC_OFFICIAL_PRICE_CARDS) {
    if (card.metadata.provenance.vendor_effective_from) continue;
    assert.equal(card.effective.from, undefined, card.id);
  }
});

test("provider tool unit cards price billable units from before the review date", () => {
  const toolUnits = {
    openai: [
      { name: "web_search_units", quantity: "1000", unit: "search" },
      { name: "file_search_units", quantity: "1000", unit: "call" },
    ],
    anthropic: [{ name: "web_search_units", quantity: "1000", unit: "search" }],
  };
  const expected = { openai: "12.5", anthropic: "10" };
  for (const [provider, components] of Object.entries(toolUnits)) {
    for (const pricedAt of ["2025-06-01", "2026-01-15", "2026-07-24", "2026-08-01"]) {
      const result = calculateCost({
        usageLedger: {
          schema_version: "0.1",
          provider,
          surface: provider === "openai" ? "openai.responses" : "anthropic.messages",
          model: { requested: `${provider}-provider-tools` },
          context: { service_tier: "standard", region: "global", priced_at: pricedAt },
          components,
        },
        priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
        mode: "compatibility",
      });
      assert.equal(result.total, expected[provider], `${provider}/${pricedAt}`);
      assert.equal(result.warnings.length, 0, `${provider}/${pricedAt}`);
    }
  }
  for (const card of PROVIDER_TOOL_PRICE_CARDS) {
    assert.deepEqual(card.effective, {}, card.id);
    assert.equal(card.metadata.provenance.vendor_effective_from, null, card.id);
    assert.equal(
      card.metadata.provenance.historical_validity,
      "reviewed_rate_without_vendor_effective_date",
      card.id,
    );
  }
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

  const malformedContextBand = structuredClone(base);
  malformedContextBand.components[0].conditions.max_total_input_tokens = "272000";
  assert.throws(
    () => validateOfficialPriceRegistry([malformedContextBand]),
    /malformed short-context component boundary/,
  );

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
