import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  APP_OFFICIAL_PRICE_CARDS,
  FAST_MODE_MODEL_FAMILY_KEYS,
  FAST_MODE_QUOTA_MULTIPLIERS,
  SPEED_MODE_PROVENANCE_VALUES,
  deriveFastModePriorityRatiosFromRegistry,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
  priceCodexUsageEvent,
  quotaWeightedApiPriceEquivalent,
  resolveEffectiveSpeedMode,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import {
  addTimelineUsage,
  finalizeTimelineBuckets,
  usageProjection,
} from "../src/local-companion-usage-model.js";

const EVENT_TIME = "2026-08-30T00:00:00.000Z";
const PRIORITY_CARDS = APP_OFFICIAL_PRICE_CARDS.filter(
  (card) => card.provider === "openai" && card.service_tier === "priority",
);

test("every shipped Priority card and reviewed alias equals the event-weighted Standard cost", () => {
  let checked = 0;
  for (const card of PRIORITY_CARDS) {
    const eventTime = `${card.effective.from ?? card.effective.to ?? "2026-08-30"}T12:00:00.000Z`;
    const totalInputContextTokens = card.metadata.total_input_context_band === "long"
      ? 272_000 : 4_000;
    const components = Object.fromEntries(card.components
      .filter((component) => component.usage_component.endsWith("_tokens"))
      .map((component) => [component.usage_component, 1_000]));
    for (const model of [card.model, ...(card.aliases ?? [])]) {
      const event = { model, timestamp: eventTime, totalInputContextTokens, components };
      const standard = priceCodexUsageEvent(event, { apiServiceTier: "standard" });
      const priority = priceCodexUsageEvent(event, { apiServiceTier: "priority" });
      assert.equal(standard.coverageStatus, "fully_priced", card.id);
      assert.equal(priority.coverageStatus, "fully_priced", card.id);
      assert.ok(priority.selectedPriceCardIds.includes(card.id), card.id);
      const evidence = {
        eventTime, totalInputContextTokens,
        standardPriceCardIds: standard.selectedPriceCardIds,
      };
      assert.equal(fastModeModelFamilyKey(model, evidence), card.model);
      const weighted = quotaWeightedApiPriceEquivalent({
        apiPriceEquivalentUsd: Number(standard.totalUsd), model, mode: "fast", ...evidence,
      });
      assert.equal(weighted.status, "fast_weighted");
      assert.equal(weighted.usd, Number(priority.totalUsd), `${card.id}/${model}`);
      const crossing = emptySpeedWeightingCrossing();
      crossing.fast[fastModeModelFamilyKey(model, evidence)] = {
        events: 1, apiPriceEquivalentUsd: Number(standard.totalUsd),
      };
      const summary = summarizeQuotaWeightedAccounting({ speedWeighting: crossing });
      assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, weighted.usd);
      assert.equal(summary.assumedRatioStandardApiPriceEquivalentUsd, 0);
      checked += 1;
    }
  }
  assert.equal(checked, 26);
  assert.equal(FAST_MODE_MODEL_FAMILY_KEYS.length, 16);
  assert.equal(Math.max(...Object.values(FAST_MODE_QUOTA_MULTIPLIERS)), 2.5);
});

test("Priority eligibility rejects guessed names, wrong cards, missing evidence, and uncovered epochs/contexts", () => {
  const short = { eventTime: EVENT_TIME, totalInputContextTokens: 1_000 };
  for (const model of ["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.4-nano",
    "gpt-5.4-codex", "gpt-5.4-invented", "gpt-5.6", "gpt-5.6-sol-future"]) {
    assert.equal(fastModeQuotaMultiplier(model, short), null, model);
  }
  assert.equal(fastModeQuotaMultiplier("gpt-4.1", short), 1.75);
  assert.equal(fastModeQuotaMultiplier("gpt-4.1-mini", short), 1.75);
  assert.equal(fastModeQuotaMultiplier("gpt-5-mini", short), 1.8);
  assert.equal(fastModeQuotaMultiplier("gpt-4o", short), 1.7);
  assert.equal(fastModeQuotaMultiplier("gpt-5.1-codex", short), 2);
  for (const evidence of [
    {}, { totalInputContextTokens: 1_000 }, { ...short, eventTime: "2026-02-30T00:00:00Z" },
    { ...short, totalInputContextTokens: Number.NaN }, { ...short, totalInputContextTokens: -1 },
    { ...short, standardPriceCardIds: [] }, { ...short, standardPriceCardIds: ["invented"] },
    { ...short, extraUnreviewedField: true },
  ]) assert.equal(fastModeQuotaMultiplier("gpt-5.5", evidence), null);
  assert.equal(fastModeQuotaMultiplier("gpt-5.5", { eventTime: EVENT_TIME }), null);
  assert.equal(fastModeQuotaMultiplier("gpt-5.5", { ...short, totalInputContextTokens: 272_000 }), null);
  assert.equal(fastModeQuotaMultiplier("gpt-5.6-sol", {
    eventTime: "2026-08-20T23:59:59.999Z", totalInputContextTokens: 272_000,
  }), null);
  assert.equal(fastModeQuotaMultiplier("gpt-5.6-sol", {
    eventTime: "2026-08-21T00:00:00.000Z", totalInputContextTokens: 272_000,
  }), 2);
  const otherModelCard = APP_OFFICIAL_PRICE_CARDS.find(
    (card) => card.model === "gpt-5.4" && card.service_tier === "standard",
  );
  assert.equal(fastModeQuotaMultiplier("gpt-5.5", {
    ...short, standardPriceCardIds: [otherModelCard.id],
  }), null);
  assert.deepEqual(quotaWeightedApiPriceEquivalent({
    apiPriceEquivalentUsd: 4, model: "gpt-5.5-pro", mode: "fast", ...short,
  }), { usd: 8, multiplier: 2, status: "fast_weighted_assumed_ratio" });
});

test("ratio proof refuses component, unit, context, and dated-ratio disagreement", () => {
  const mutations = [
    [(card) => { card.components = card.components.filter((row) => row.usage_component !== "input_cache_read_tokens"); }, /component coverage differs/],
    [(card) => { card.components[0].unit = "request"; }, /units or conditions differ/],
    [(card) => { card.components[0].price.currency = "EUR"; }, /units or conditions differ/],
    [(card) => { card.components[0].price.per = "1000"; }, /units or conditions differ/],
    [(card) => { card.components[0].conditions.max_total_input_tokens = "999"; }, /units or conditions differ/],
    [(card) => { card.components[0].price.amount = "9"; }, /not uniform/],
  ];
  for (const [mutate, expected] of mutations) {
    const cards = structuredClone(APP_OFFICIAL_PRICE_CARDS);
    const target = cards.find((card) => card.model === "gpt-5.6-sol"
      && card.service_tier === "priority" && card.effective.from === "2026-08-21"
      && card.metadata.total_input_context_band === "short");
    mutate(target);
    assert.throws(() => deriveFastModePriorityRatiosFromRegistry(cards), expected);
  }
  const withoutMatchingStandard = APP_OFFICIAL_PRICE_CARDS.filter((card) => !(
    card.model === "gpt-4.1" && card.service_tier === "standard"
  ));
  assert.throws(() => deriveFastModePriorityRatiosFromRegistry(withoutMatchingStandard), /no overlapping Standard/);
});

test("runtime and type declarations expose the same scenario provenance and price helpers", async () => {
  const provenance = resolveEffectiveSpeedMode({ unresolvedScenario: "unresolved_as_fast" }).provenance;
  assert.equal(provenance, "assumed_fast_scenario");
  assert.ok(SPEED_MODE_PROVENANCE_VALUES.includes(provenance));
  const declarations = await readFile(new URL("../packages/accounting/index.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /\| "assumed_fast_scenario"/u);
  for (const name of ["deriveFastModePriorityRatiosFromRegistry", "quotaWeightedApiPriceEquivalent"]) {
    assert.match(declarations, new RegExp(`export function ${name}\\(`, "u"));
  }
});

test("ratio proof rejects duplicate token names on either tier, including duplicates hiding a missing component", () => {
  for (const tier of ["standard", "priority"]) {
    for (const replaceOutput of [false, true]) {
      const cards = structuredClone(APP_OFFICIAL_PRICE_CARDS);
      const target = cards.find((card) => card.model === "gpt-4.1" && card.service_tier === tier);
      const duplicate = structuredClone(target.components.find(
        (component) => component.usage_component === "input_uncached_tokens",
      ));
      if (replaceOutput) {
        const outputIndex = target.components.findIndex(
          (component) => component.usage_component === "output_text_tokens",
        );
        target.components[outputIndex] = duplicate;
      } else target.components.push(duplicate);
      assert.throws(() => deriveFastModePriorityRatiosFromRegistry(cards),
        /Duplicate token component name/u, `${tier}: replacement=${replaceOutput}`);
    }
  }
});

test("unified usage projections qualify once and retain only occupied timeline crossing cells", () => {
  const buckets = new Map();
  for (const [model, input, expectedKey] of [
    ["gpt-4.1", 1_000, "gpt-4.1"],
    ["gpt-5.5", 272_000, "unsupported"],
  ]) {
    const projection = usageProjection({
      model, observedAt: EVENT_TIME, components: { input_uncached_tokens: input },
      tierSemantics: { codexSpeedMode: "fast" },
    });
    assert.equal(projection.fastModeFamily, expectedKey);
    addTimelineUsage(buckets, Date.parse(EVENT_TIME), projection);
  }
  const [row] = finalizeTimelineBuckets(buckets);
  assert.deepEqual(Object.keys(row.speedWeighting), ["fast"]);
  assert.deepEqual(Object.keys(row.speedWeighting.fast).sort(), ["gpt-4.1", "unsupported"]);
  assert.deepEqual(row.declaredSpeedWeighting, {});
  const summary = summarizeQuotaWeightedAccounting({ speedWeighting: row.speedWeighting });
  assert.equal(summary.coverage.totalEvents, 2);
  assert.equal(summary.assumedRatioStandardApiPriceEquivalentUsd, 2.72);
  assert.equal(summary.quotaWeightedApiPriceEquivalentUsd, 5.4435);
});
