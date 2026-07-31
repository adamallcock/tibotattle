import { describe, expect, it } from "vitest";
import {
  priceUsageEvent,
  type PriceCard,
} from "@app-usagemonitor/accounting";

describe("accounting package declarations", () => {
  it("accepts a tierless Standard card through the typed public API", () => {
    const card: PriceCard = {
      schema_version: "0.1",
      id: "test:tierless-standard",
      provider: "openai",
      model: "test-model",
      components: [{
        usage_component: "input_uncached_tokens",
        unit: "token",
        price: {
          amount: "1",
          currency: "USD",
          per: "1000000",
        },
      }],
      source: {
        name: "typed-test",
        url: "https://example.invalid/pricing",
        retrieved_at: "2026-07-29T00:00:00.000Z",
        version: "typed-test-v1",
      },
    };
    const result = priceUsageEvent({
      provider: "openai",
      model: "test-model",
      components: {
        inputUncachedTokens: 1_000_000,
      },
    }, {
      priceCards: [card],
    });
    expect(result.totalUsd).toBe("1");
    expect(result.coverageStatus).toBe("fully_priced");
  });
});
