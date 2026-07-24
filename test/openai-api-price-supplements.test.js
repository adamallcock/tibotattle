import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost, compilePriceCatalog } from "runcost";
import { OFFICIAL_OPENAI_PRICE_SUPPLEMENTS, addOfficialOpenAiPriceSupplements } from "../src/openai-api-price-supplements.js";

function price(model, totalInputTokens, components) {
  return calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider: "openai",
      surface: "openai.responses",
      model: { requested: model },
      context: { total_input_tokens: totalInputTokens, priced_at: "2026-07-23T00:00:00Z", service_tier: "standard" },
      components: Object.entries(components).map(([name, quantity]) => ({ name, quantity: String(quantity), unit: "token" })),
    },
    priceCards: compilePriceCatalog(OFFICIAL_OPENAI_PRICE_SUPPLEMENTS),
    mode: "compatibility",
  });
}

test("official supplements price GPT-5.5 short and long context at Standard API rates", () => {
  const short = price("gpt-5.5", 1000, { input_uncached_tokens: 1_000_000, output_reasoning_tokens: 1_000_000 });
  const long = price("gpt-5.5", 272000, { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 });
  assert.equal(Number(short.total), 35);
  assert.equal(Number(long.total), 55);
  assert.equal(short.warnings.length, 0);
  assert.equal(long.warnings.length, 0);
});

test("official supplements add only models absent from the resolved catalog", () => {
  const existing = { price_cards: [{ ...OFFICIAL_OPENAI_PRICE_SUPPLEMENTS[0], id: "existing" }], sources: [], selected_source: "test" };
  const result = addOfficialOpenAiPriceSupplements(existing);
  assert.equal(result.price_cards.filter((card) => card.model === "gpt-5.5").length, 1);
  assert.equal(result.price_cards.length, 3);
  assert.notEqual(result.price_cards.find((card) => card.model === "gpt-5.5").id, "existing");
});
