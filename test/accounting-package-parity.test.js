import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  APP_OFFICIAL_PRICE_CARDS,
  priceClaudeUsageRecord,
  priceCodexUsageEvent,
  priceUsageEvent,
} from "../packages/accounting/index.js";

function toNanousd(value) {
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = `${fraction}000000000`.slice(0, 9);
  assert.match(value, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
  assert.equal(fraction.slice(9).replaceAll("0", ""), "");
  return Number(BigInt(whole) * 1_000_000_000n + BigInt(padded));
}

function resultProjection(result) {
  const unpricedReasonCodes = new Set(
    result.components
      .filter((component) => component.pricingStatus === "unpriced")
      .map((component) => component.reasonCode)
      .filter(Boolean),
  );
  for (const warning of result.warnings.coverage) {
    unpricedReasonCodes.add(warning.code);
  }
  const unknownBillableUnits = result.components
    .filter((component) => component.pricingStatus === "unpriced")
    .reduce((total, component) => total + Number(component.quantity ?? 0), 0);
  return {
    exactCostUsd: result.totalUsd,
    costNanousd: toNanousd(result.totalUsd),
    coverageStatus: result.coverageStatus,
    unknownBillableUnits,
    unpricedReasonCodes: [...unpricedReasonCodes].sort(),
    selectedPriceCardIds: [...result.selectedPriceCardIds].sort(),
  };
}

function priceThroughLocalAdapter(kernelEvent) {
  if (kernelEvent.provider === "openai") {
    return priceCodexUsageEvent({
      timestamp: kernelEvent.pricedAt,
      model: kernelEvent.model,
      totalInputContextTokens: kernelEvent.totalInputContextTokens,
      components: kernelEvent.components,
    }, {
      apiServiceTier: kernelEvent.apiTier,
    });
  }
  if (kernelEvent.provider === "anthropic") {
    return priceClaudeUsageRecord({
      eventTime: kernelEvent.pricedAt,
      modelRecognition: "recognized",
      modelId: kernelEvent.model,
      totalInputContextTokens: kernelEvent.totalInputContextTokens,
      components: kernelEvent.components,
    }, {
      apiServiceTier: kernelEvent.apiTier,
    });
  }
  throw new TypeError(`Unsupported parity-fixture provider: ${kernelEvent.provider}`);
}

test("frozen accounting fixtures preserve exact kernel and local-adapter results", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../packages/accounting/test/fixtures/accounting-parity-v0.1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(fixture.schemaVersion, "accounting-parity-fixture-v0.1");
  assert.equal(fixture.cases.length, 6);
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, 6);

  for (const item of fixture.cases) {
    const result = priceUsageEvent(item.kernelEvent, {
      priceCards: APP_OFFICIAL_PRICE_CARDS,
      pricingContext: {
        priceEpochBasis: "current_price_sensitivity_at_registry_observation",
      },
    });
    assert.deepEqual(resultProjection(result), item.expected, item.id);
    assert.deepEqual(
      resultProjection(priceThroughLocalAdapter(item.kernelEvent)),
      item.expected,
      `${item.id}: local adapter`,
    );
  }
});
