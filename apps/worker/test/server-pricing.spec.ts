import { describe, expect, it } from "vitest";
import {
  priceTelemetryUsageEvent,
  SERVER_PRICING_METHOD_VERSION,
} from "../src/server-pricing";
import type { TelemetryUsageEvent } from "../src/telemetry-validation";

function fixture(overrides: Partial<TelemetryUsageEvent> = {}): TelemetryUsageEvent {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-25T12:05:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "fast",
    apiServiceTier: "priority",
    reasoningEffort: "xhigh",
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 1000,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0,
      fileSearch: 0,
      codeInterpreter: 0,
      hostedShell: 0,
      computerUse: 0,
      mcp: 0,
      applyPatch: 0,
      localShell: 0,
      subagent: 0,
      toolGateway: 0,
      other: 0,
      unknown: 0,
    },
    outcome: "completed",
    eventId: `event:v2:${"a".repeat(64)}`,
    accounting: {
      estimatedApiCostUsd: "99999999.000000",
      pricingCoveragePercent: 0,
      unknownBillableUnits: 999999999,
      priceBasis: "current_api_prices",
    },
    ...overrides,
  };
}

describe("server pricing", () => {
  it("ignores client cost and keeps subscription Fast separate from API Priority", () => {
    const first = priceTelemetryUsageEvent(fixture());
    const second = priceTelemetryUsageEvent(fixture({
      accounting: {
        estimatedApiCostUsd: "0.000000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      exactCostUsd: "0.0032",
      costNanousd: 3_200_000,
      coverageStatus: "fully_priced",
      apiServiceTier: "standard",
      tierBasis: "subscription_standard_counterfactual",
      subscriptionSpeedMode: "fast",
      methodVersion: SERVER_PRICING_METHOD_VERSION,
    });
    expect(first.selectedPriceCardIds.join(",")).toContain(":standard:");
    expect(first.selectedPriceCardIds.join(",")).not.toContain(":priority:");
  });

  it("uses an explicit API Priority tier only on an API-billed surface", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      billingSurface: "openai_api",
    }));
    expect(priced).toMatchObject({
      exactCostUsd: "0.0064",
      costNanousd: 6_400_000,
      apiServiceTier: "priority",
      tierBasis: "observed_api_service_tier",
    });
    expect(priced.selectedPriceCardIds.join(",")).toContain(":priority:");
  });

  it("retains sub-micro event prices exactly in fixed-scale nanousd", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      modelId: "gpt-5.6-terra",
      components: {
        ...fixture().components,
        inputUncachedTokens: 1,
        inputCacheReadTokens: 0,
        outputTextTokens: 0,
        outputReasoningTokens: 0,
      },
      totalInputContextTokens: 1,
    }));
    expect(priced).toMatchObject({
      exactCostUsd: "0.0000025",
      costNanousd: 2_500,
      coverageStatus: "fully_priced",
    });
  });

  it("fails closed before one event can make participant nanousd totals unsafe", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      components: {
        ...fixture().components,
        inputUncachedTokens: 1_000_000_000,
        inputCacheReadTokens: 1_000_000_000,
        outputTextTokens: 1_000_000_000,
        outputReasoningTokens: 1_000_000_000,
      },
      totalInputContextTokens: 1_000_000_000,
    }));
    expect(priced).toMatchObject({
      exactCostUsd: "0",
      costNanousd: 0,
      coverageStatus: "unpriced",
      unpricedReasonCodes: ["event_price_exceeds_safe_participant_aggregate"],
    });
  });

  it("does not price client tool-class counts as provider-billable calls", () => {
    const baseline = priceTelemetryUsageEvent(fixture());
    const withTools = priceTelemetryUsageEvent(fixture({
      toolClassCounts: {
        ...fixture().toolClassCounts,
        webSearch: 1_000_000,
        fileSearch: 1_000_000,
        hostedShell: 1_000_000,
      },
    }));
    expect(withTools.exactCostUsd).toBe(baseline.exactCostUsd);
    expect(withTools.selectedPriceCardIds).toEqual(baseline.selectedPriceCardIds);
  });

  it("switches at exactly 272K context and does not invent Priority long rates", () => {
    const components = {
      ...fixture().components,
      inputUncachedTokens: 1_000_000,
      inputCacheReadTokens: 0,
      outputTextTokens: 1_000_000,
      outputReasoningTokens: 0,
    };
    const short = priceTelemetryUsageEvent(fixture({
      speedMode: "standard",
      components,
      totalInputContextTokens: 271_999,
    }));
    const long = priceTelemetryUsageEvent(fixture({
      speedMode: "standard",
      components,
      totalInputContextTokens: 272_000,
    }));
    const priorityLong = priceTelemetryUsageEvent(fixture({
      billingSurface: "openai_api",
      speedMode: "standard",
      components,
      totalInputContextTokens: 272_000,
    }));

    expect(short.exactCostUsd).toBe("35");
    expect(long.exactCostUsd).toBe("55");
    expect(priorityLong.coverageStatus).toBe("unpriced");
    expect(priorityLong.exactCostUsd).toBe("0");
    expect(priorityLong.selectedPriceCardIds).toEqual([]);
  });

  it("fails closed when a context-sensitive model lacks total input context", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      totalInputContextTokens: null,
    }));
    expect(priced).toMatchObject({
      exactCostUsd: "0",
      costNanousd: 0,
      coveragePercent: 0,
      coverageStatus: "unpriced",
      unpricedReasonCodes: ["total_input_context_missing"],
    });
  });

  it("fails closed for an unknown model without resolving its fingerprint", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      modelId: "unknown",
      modelRecognition: "unrecognized",
      modelFingerprint: `model:v1:${"b".repeat(64)}`,
    }));
    expect(priced.coverageStatus).toBe("unpriced");
    expect(priced.unpricedReasonCodes).toEqual(["unknown_model"]);
    expect(priced.selectedPriceCardIds).toEqual([]);
  });
});
