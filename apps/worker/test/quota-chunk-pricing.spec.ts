import { describe, expect, it } from "vitest";
import { priceChunkUsageRecord } from "../src/quota-analysis-v1";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { COMMUNITY_DAILY_SPEND_BASIS, COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256, isCurrentCommunityDailySpend } from "../src/community-daily-spend";
import { COMMUNITY_ALLOWANCE_BASIS, COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS,
  COMMUNITY_ATTRIBUTION_METHOD_VERSION } from "../src/community-allowance";
import { isCurrentCommunityAllowancePublication } from "../src/community-daily-aggregates";

const AT = "2026-09-05T00:00:00.000Z";

function record(overrides: Partial<TelemetryV1UsageEvent> = {}): TelemetryV1UsageEvent {
  return {
    schemaVersion: "usage-event-v1.0", eventId: `event:v2:${"a".repeat(64)}`,
    eventTime: AT, sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex", modelId: "gpt-6-astra", speedMode: "standard",
    apiServiceTier: "unknown", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "medium",
    agentScope: "root", outcome: "completed", totalInputContextTokens: null,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: 100, outputReasoningTokens: 0, outputCombinedTokens: null },
    ...overrides,
  };
}

function price(value: TelemetryV1UsageEvent) {
  // Exercise the actual admitted nullable v1 domain, not an impossible pricer-only shape.
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: "usage:2026-09-05:0", chunkRevision: 1,
    chunkDigest: "0".repeat(64), parserVersion: "synthetic-pricing-boundaries",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records: [value],
  });
  return priceChunkUsageRecord(JSON.stringify(chunk.records[0]), AT);
}

describe("admitted chunk usage pricing evidence boundaries", () => {
  it("fences public allowance readiness against prior v0.4 pricing without rewriting the singleton", () => {
    const state = { publication_state: "ready" as const, expected_basis: COMMUNITY_ALLOWANCE_BASIS,
      attribution_method_version: COMMUNITY_ATTRIBUTION_METHOD_VERSION,
      safe_from_day: new Date(Date.parse(AT) - (COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS - 1) * 86_400_000)
        .toISOString().slice(0, 10), safe_to_day: AT.slice(0, 10), changed_at: AT };
    expect(COMMUNITY_ATTRIBUTION_METHOD_VERSION).toContain(COMMUNITY_DAILY_SPEND_PRICING_METHOD);
    expect(isCurrentCommunityAllowancePublication(state, Date.parse(AT))).toBe(true);
    // The actual prior tuple omitted the price method entirely. Also reject a
    // tuple explicitly bound to v0.4, rather than treating any version as current.
    for (const oldMethod of [
      COMMUNITY_ATTRIBUTION_METHOD_VERSION.split(":").filter(value => value !== COMMUNITY_DAILY_SPEND_PRICING_METHOD).join(":"),
      COMMUNITY_ATTRIBUTION_METHOD_VERSION.replace(COMMUNITY_DAILY_SPEND_PRICING_METHOD, "server-api-price-equivalent-v0.4"),
    ]) {
      const old = { ...state, attribution_method_version: oldMethod };
      expect(isCurrentCommunityAllowancePublication(old, Date.parse(AT))).toBe(false);
      expect(old).toEqual({ ...state, attribution_method_version: oldMethod });
    }
  });

  it("invalidates old known-cost caches after the pricing-boundary correction", () => {
    const spend = { basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: 1,
      coverage: "complete", usageEvents: 1, fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 0,
      unpricedUsageEvents: 0, registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
      pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD };
    expect(COMMUNITY_DAILY_SPEND_PRICING_METHOD).toBe("server-api-price-equivalent-v0.5");
    expect(isCurrentCommunityDailySpend(spend)).toBe(true);
    expect(isCurrentCommunityDailySpend({ ...spend, pricingMethodVersion: "server-api-price-equivalent-v0.4" })).toBe(false);
  });

  it.each(["gpt-6-astra", "gpt-5.6-sol"])("never guesses context for nullable input components on %s", (modelId) => {
    for (const missing of ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens"] as const) {
      const value = record({ modelId });
      value.components[missing] = null;
      expect(price(value), missing).toEqual({ costNanousd: 0, pricingStatus: "unpriced", modelId });
    }
  });

  it("keeps output-only context-sensitive usage unpriced without a supplied context", () => {
    const value = record();
    value.components.inputUncachedTokens = null;
    value.components.inputCacheReadTokens = null;
    value.components.inputCacheWriteTokens = null;
    expect(price(value)).toEqual({ costNanousd: 0, pricingStatus: "unpriced", modelId: value.modelId });
    // An actually supplied context permits the known output component without inventing missing input.
    expect(price({ ...value, totalInputContextTokens: 100 })).toEqual({
      costNanousd: 5_000_000, pricingStatus: "partially_priced", modelId: value.modelId,
    });
  });

  it.each([1_000, 300_000])("derives context from three known inputs with exact supplied-context parity (%s)", (context) => {
    const value = record({ components: { inputUncachedTokens: context - 200, inputCacheReadTokens: 100,
      inputCacheWriteTokens: 100, outputTextTokens: 100, outputReasoningTokens: 0, outputCombinedTokens: null } });
    const derived = price(value);
    expect(derived).toEqual(price({ ...value, totalInputContextTokens: context }));
    expect(derived?.pricingStatus).toBe("fully_priced");
    expect(derived!.costNanousd).toBeGreaterThan(0);
  });

  it("does not discard known components when the model has no context-band dependency", () => {
    const value = record({ modelId: "gpt-4.1" });
    value.components.inputCacheReadTokens = null;
    expect(price(value)).toEqual({ costNanousd: 1_000_000, pricingStatus: "partially_priced", modelId: value.modelId });
  });

  it("recognizes zero aggregate Claude cache writes as known zero TTL buckets", () => {
    const value = record({ provider: "anthropic_claude_code", modelId: "claude-sonnet-4-6",
      billingSurface: "claude_subscription", components: { inputUncachedTokens: 100, inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0, outputTextTokens: null, outputReasoningTokens: null, outputCombinedTokens: 100 } });
    expect(price(value)).toEqual({ costNanousd: 1_800_000, pricingStatus: "fully_priced", modelId: value.modelId });
    const zero = { ...value, components: { ...value.components, inputUncachedTokens: 0, outputCombinedTokens: 0 } };
    expect(price(zero)).toEqual({ costNanousd: 0, pricingStatus: "fully_priced", modelId: value.modelId });
    for (const inputCacheWriteTokens of [100, null]) {
      expect(price({ ...value, components: { ...value.components, inputCacheWriteTokens } })).toEqual({
        costNanousd: 1_800_000, pricingStatus: "partially_priced", modelId: value.modelId,
      });
    }
  });

  it("does not reinterpret an admitted unknown provider as Anthropic", () => {
    const value = record({ provider: "other", modelId: "claude-sonnet-4-6", billingSurface: "claude_subscription",
      components: { inputUncachedTokens: 100, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: null, outputReasoningTokens: null, outputCombinedTokens: 100 } });
    expect(price(value)).toEqual({ costNanousd: 0, pricingStatus: "unpriced", modelId: value.modelId });
  });
});
