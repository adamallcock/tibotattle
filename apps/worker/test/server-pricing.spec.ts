import { describe, expect, it } from "vitest";
import { APP_OFFICIAL_PRICE_CARDS } from "@app-usagemonitor/accounting";
import {
  priceTelemetryUsageEvent,
  SERVER_PRICING_METHOD_VERSION,
} from "../src/server-pricing";
import {
  validateTelemetryContribution,
  type TelemetryUsageEvent,
} from "../src/telemetry-validation";
import parityFixture from "../../../packages/accounting/test/fixtures/accounting-parity-v0.1.json";

function fixture(overrides: Partial<TelemetryUsageEvent> = {}): TelemetryUsageEvent {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-08-01T13:47:00.000Z",
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

interface PriceCardValidity {
  effective: { from?: string; to?: string };
  vendorEffectiveFrom: string | null;
  vendorEffectiveTo: string | null;
}

// Reads the registry's own validity window for a selected card so a pricing
// test can prove the card legitimately covers the event instant it priced,
// rather than trusting a card id string alone.
function priceCardValidity(cardId: string): PriceCardValidity {
  const card = APP_OFFICIAL_PRICE_CARDS.find((entry) => entry.id === cardId);
  if (!card) throw new Error(`price card ${cardId} is absent from the registry`);
  const provenance = (card.metadata?.provenance ?? {}) as {
    vendor_effective_from?: string | null;
    vendor_effective_to?: string | null;
  };
  return {
    effective: { ...(card.effective ?? {}) },
    vendorEffectiveFrom: provenance.vendor_effective_from ?? null,
    vendorEffectiveTo: provenance.vendor_effective_to ?? null,
  };
}

function validateIngestibleEvent(event: TelemetryUsageEvent): TelemetryUsageEvent {
  // The envelope window is derived from the event's own instant so parity
  // fixtures may pin event times in any price epoch (e.g. after the Sol
  // 2026-08-21 repricing) without failing covered-window validation.
  const eventMs = Date.parse(event.eventTime);
  const contribution = validateTelemetryContribution({
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: new Date(eventMs + 3 * 60 * 1000).toISOString(),
    coveredAt: {
      startAt: new Date(eventMs - 7 * 60 * 1000).toISOString(),
      endAt: new Date(eventMs + 3 * 60 * 1000).toISOString(),
    },
    clientPlatform: "macos",
    providerPolicyEpoch: event.provider === "anthropic_claude_code"
      ? "anthropic_unknown"
      : "openai_agentic_pool_2026_07_09",
    usageEvents: [event],
    quotaSnapshots: [],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: event.accounting.estimatedApiCostUsd,
      pricedEventCoveragePercent: event.accounting.pricingCoveragePercent,
      unknownModelEventCount: event.modelId === "unknown" ? 1 : 0,
      unknownBillableUnits: event.accounting.unknownBillableUnits,
      priceBasis: event.accounting.priceBasis,
    },
  });
  return contribution.usageEvents[0]!;
}

describe("server pricing", () => {
  it("matches the frozen accounting kernel projection on supported fixtures", () => {
    expect(parityFixture.schemaVersion).toBe("accounting-parity-fixture-v0.1");
    expect(parityFixture.cases).toHaveLength(6);
    for (const item of parityFixture.cases) {
      const event = validateIngestibleEvent(fixture(
        item.workerOverrides as Partial<TelemetryUsageEvent>,
      ));
      const priced = priceTelemetryUsageEvent(event);
      expect({
        exactCostUsd: priced.exactCostUsd,
        costNanousd: priced.costNanousd,
        coverageStatus: priced.coverageStatus,
        unknownBillableUnits: priced.unknownBillableUnits,
        unpricedReasonCodes: priced.unpricedReasonCodes,
        selectedPriceCardIds: priced.selectedPriceCardIds,
      }, item.id).toEqual(item.expected);
    }
  });

  it("keeps Anthropic cache writes unpriced when the TTL split is missing", () => {
    const priced = priceTelemetryUsageEvent(validateIngestibleEvent(fixture({
      provider: "anthropic_claude_code",
      modelId: "claude-sonnet-4-6",
      billingSurface: "claude_subscription",
      speedMode: "standard",
      apiServiceTier: "unknown",
      reasoningEffort: "unknown",
      components: {
        inputUncachedTokens: 100,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 30,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: null,
        outputReasoningTokens: null,
        outputCombinedTokens: 75,
      },
    })));
    expect(priced).toMatchObject({
      exactCostUsd: "0.001695",
      costNanousd: 1_695_000,
      coveragePercent: 97.285,
      coverageStatus: "partially_priced",
      unknownBillableUnits: 30,
      unpricedReasonCodes: [
        "anthropic_cache_write_ttl_split_missing",
        "component_observation_unavailable",
      ],
    });
  });

  it("ignores client cost and prices subscription Fast at the Priority ratio over Standard cards", () => {
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
    // The Standard-card total (0.0032 at the pre-2026-08-21 sol rates) scaled
    // by the published GPT-5.6 Priority/Standard ratio of 2.
    expect(first).toMatchObject({
      exactCostUsd: "0.0064",
      costNanousd: 6_400_000,
      coverageStatus: "fully_priced",
      apiServiceTier: "standard",
      tierBasis: "subscription_speed_priority_price_ratio",
      subscriptionSpeedMode: "fast",
      speedMultiplier: 2,
      methodVersion: SERVER_PRICING_METHOD_VERSION,
    });
    expect(first.selectedPriceCardIds.join(",")).toContain(":standard:");
    expect(first.selectedPriceCardIds.join(",")).not.toContain(":priority:");
    // Standard and unknown speed stay the plain counterfactual with no ratio.
    expect(priceTelemetryUsageEvent(fixture({ speedMode: "standard" }))).toMatchObject({
      exactCostUsd: "0.0032",
      costNanousd: 3_200_000,
      tierBasis: "subscription_standard_counterfactual",
      speedMultiplier: null,
    });
    expect(priceTelemetryUsageEvent(fixture({ speedMode: "unknown" }))).toMatchObject({
      exactCostUsd: "0.0032",
      tierBasis: "subscription_standard_counterfactual",
      speedMultiplier: null,
    });
  });

  it("selects explicit API Flex and Batch while unknown tiers fail closed", () => {
    for (const apiServiceTier of ["flex", "batch"] as const) {
      expect(priceTelemetryUsageEvent(fixture({
        billingSurface: "openai_api",
        apiServiceTier,
        speedMode: "standard",
      }))).toMatchObject({
        exactCostUsd: "0.0016",
        costNanousd: 1_600_000,
        coverageStatus: "fully_priced",
        apiServiceTier,
        tierBasis: "observed_api_service_tier",
        selectedPriceCardIds: [
          `openai:gpt-5.6-sol:${apiServiceTier}:short-through-2026-08-20:official-observed-2026-08-30`,
        ],
      });
    }
    for (const apiServiceTier of ["unknown", "other"] as const) {
      expect(priceTelemetryUsageEvent(fixture({
        billingSurface: "openai_api",
        apiServiceTier,
        speedMode: "standard",
      }))).toMatchObject({
        exactCostUsd: "0",
        coverageStatus: "unpriced",
        apiServiceTier: "unknown",
        tierBasis: "api_service_tier_unavailable",
        unpricedReasonCodes: ["api_service_tier_unavailable"],
      });
    }
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
      exactCostUsd: "0.000004",
      costNanousd: 4_000,
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

  it("uses retained telemetry event time and fails closed when it is absent", () => {
    const before = priceTelemetryUsageEvent(fixture({
      eventTime: "2026-07-29T23:59:59.999Z",
      modelId: "gpt-5.6-terra",
    }));
    const after = priceTelemetryUsageEvent(fixture({
      eventTime: "2026-07-30T00:00:00.000Z",
      modelId: "gpt-5.6-terra",
    }));
    const missing = priceTelemetryUsageEvent(fixture({ eventTime: undefined as unknown as string }));

    expect(before.selectedPriceCardIds).toEqual([
      "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30",
    ]);
    expect(after.selectedPriceCardIds).toEqual([
      "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30",
    ]);
    expect(before).toMatchObject({
      priceBasis: "historical_api_prices",
      priceEventTime: "2026-07-29T23:59:59.999Z",
    });
    expect(after).toMatchObject({
      priceBasis: "historical_api_prices",
      priceEventTime: "2026-07-30T00:00:00.000Z",
    });
    expect(missing).toMatchObject({
      exactCostUsd: "0",
      coverageStatus: "unpriced",
      priceBasis: "unpriced",
      priceEventTime: null,
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      unpricedReasonCodes: ["historical_price_timestamp_missing"],
    });
  });

  it("prices January history from the undated reviewed card", () => {
    const januaryEventTime = "2026-01-15T12:00:00.000Z";
    const priced = priceTelemetryUsageEvent(fixture({
      eventTime: januaryEventTime,
    }));
    expect(priced).toMatchObject({
      // The fast-subscription fixture doubles the January Standard-card total
      // via the GPT-5.6 Priority ratio; the selected card itself stays the
      // pre-repricing Standard card.
      exactCostUsd: "0.0064",
      costNanousd: 6_400_000,
      coveragePercent: 100,
      coverageStatus: "fully_priced",
      selectedPriceCardIds: [
        "openai:gpt-5.6-sol:standard:short-through-2026-08-20:official-observed-2026-08-30",
      ],
      unpricedReasonCodes: [],
      priceBasis: "historical_api_prices",
      priceEventTime: januaryEventTime,
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    });
    expect(priced.unpricedReasonCodes).not.toContain("historical_price_missing");
    // Since the 2026-08-21 Sol repricing the selected card closes at the
    // published vendor boundary, but it stays open backwards: the review date
    // is provenance only and never acts as a lower bound on how far back the
    // model rate may be applied, so January history still prices.
    expect(priceCardValidity(priced.selectedPriceCardIds[0]!)).toEqual({
      effective: { to: "2026-08-20" },
      vendorEffectiveFrom: null,
      vendorEffectiveTo: "2026-08-20",
    });
    // The identical event inside the reviewed epoch selects the same card at
    // the same rate: event age alone never changes the pricing outcome.
    const reviewedEpoch = priceTelemetryUsageEvent(fixture({
      eventTime: "2026-07-25T12:05:00.000Z",
    }));
    expect(reviewedEpoch.exactCostUsd).toBe(priced.exactCostUsd);
    expect(reviewedEpoch.selectedPriceCardIds).toEqual(priced.selectedPriceCardIds);
  });

  it("prices January history for a repriced model from its pre-repricing window", () => {
    const priced = priceTelemetryUsageEvent(fixture({
      modelId: "gpt-5.6-terra",
      eventTime: "2026-01-15T12:00:00.000Z",
    }));
    expect(priced).toMatchObject({
      // 0.0016 at the pre-repricing terra Standard rates, doubled by the
      // GPT-5.6 Priority ratio for the fast-subscription fixture.
      exactCostUsd: "0.0032",
      costNanousd: 3_200_000,
      coveragePercent: 100,
      coverageStatus: "fully_priced",
      selectedPriceCardIds: [
        "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30",
      ],
      unpricedReasonCodes: [],
      priceBasis: "historical_api_prices",
      priceEventTime: "2026-01-15T12:00:00.000Z",
    });
    expect(priced.unpricedReasonCodes).not.toContain("historical_price_missing");
    // The pre-repricing card is closed only at the vendor's published
    // 2026-07-30 change and stays open-ended backwards, so a January instant
    // falls legitimately inside its validity window.
    expect(priceCardValidity(priced.selectedPriceCardIds[0]!)).toEqual({
      effective: { to: "2026-07-29" },
      vendorEffectiveFrom: null,
      vendorEffectiveTo: "2026-07-29",
    });
  });

  it("fails closed for date-only and noncanonical historical instants", () => {
    for (const eventTime of [
      "2026-07-30",
      "2026-07-30T00:00:00Z",
      "2026-07-30T00:00:00.000+00:00",
    ]) {
      const priced = priceTelemetryUsageEvent(fixture({ eventTime }));
      expect(priced.exactCostUsd, eventTime).toBe("0");
      expect(priced.coverageStatus, eventTime).toBe("unpriced");
      expect(priced.selectedPriceCardIds, eventTime).toEqual([]);
      expect(priced.unpricedReasonCodes, eventTime).toEqual([
        "historical_price_timestamp_missing",
      ]);
    }
  });
});
