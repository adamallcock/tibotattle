import { describe, expect, it } from "vitest";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { priceChunkUsageRecord } from "../src/quota-analysis-v1";
import {
  cacheRetentionEventFromRecord,
} from "../src/cache-retention-day";
import {
  CACHE_RETENTION_METHOD,
  reduceCacheRetentionDay,
  type CacheRetentionItem,
} from "../src/cache-retention-values";
import {
  createV11DailyProjectionValues,
  foldV1DailyProjectionValues,
} from "../src/v11-daily-projection-values";

const DAY = "2026-09-05";
const AT = `${DAY}T12:00:00.000Z`;
const DAY_MS = Date.parse(`${DAY}T00:00:00.000Z`);
const SESSION_DIGEST = "a".repeat(64);

function usage(
  totalInputContextTokens: number | null,
  components: TelemetryV1UsageEvent["components"],
  options: { eventTime?: string; idChar?: string } = {},
): TelemetryV1UsageEvent {
  const eventTime = options.eventTime ?? AT;
  const idChar = options.idChar ?? "b";
  return {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:v2:${idChar.repeat(64)}`,
    eventTime,
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex",
    modelId: "gpt-6-astra",
    speedMode: "standard",
    apiServiceTier: "unknown",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "medium",
    agentScope: "root",
    outcome: "unknown",
    totalInputContextTokens,
    components,
  };
}

function storedRecord(record: TelemetryV1UsageEvent): string {
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${DAY}:0`,
    chunkRevision: 1,
    chunkDigest: "0".repeat(64),
    parserVersion: "synthetic-total-capture",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [record],
  });
  return JSON.stringify(chunk.records[0]);
}

function price(record: TelemetryV1UsageEvent) {
  return priceChunkUsageRecord(storedRecord(record), AT);
}

describe("v1.2 total-input capture compatibility evidence", () => {
  it("keeps complete short and long Worker pricing unchanged when total is captured", () => {
    for (const [context, ids] of [[1_000, ["0", "1", "2", "3", "4"]],
      [300_000, ["5", "6", "7", "8", "9"]]] as const) {
      const beforeComponents = {
        inputUncachedTokens: context - 100,
        inputCacheReadTokens: 100,
        inputCacheWriteTokens: 0,
        outputTextTokens: 100,
        outputReasoningTokens: 25,
        outputCombinedTokens: null,
      };
      const afterComponents = { ...beforeComponents, outputCombinedTokens: 125 };
      const before = price(usage(null, beforeComponents, { idChar: ids[0] }));
      const inputOnly = price(usage(context, beforeComponents, { idChar: ids[1] }));
      const after = price(usage(context, afterComponents, { idChar: ids[2] }));

      // The input-context repair alone is numerically and categorically exact
      // for complete input splits, including the short/long price boundary.
      expect(inputOnly).toEqual(before);
      expect(before).toMatchObject({ pricingStatus: "fully_priced" });
      expect(before?.costNanousd).toBe(context === 1_000 ? 15_350_000 : 6_007_575_000);
      // Both repaired totals are non-additive. The pricing adapter must
      // preserve full coverage as well as the exact cost of complete splits.
      expect(after).toEqual(before);

      const beforeDaily = foldV1DailyProjectionValues(
        createV11DailyProjectionValues(DAY),
        [usage(null, beforeComponents, { idChar: ids[3] })],
      );
      const afterDaily = foldV1DailyProjectionValues(
        createV11DailyProjectionValues(DAY),
        [usage(context, afterComponents, { idChar: ids[4] })],
      );
      expect(beforeDaily.tokens.outputCombinedTokens).toEqual({ knownSum: "0", unavailable: 1 });
      expect(afterDaily.tokens.outputCombinedTokens).toEqual({ knownSum: "125", unavailable: 0 });
      expect(afterDaily.tokens.effectiveOutput).toEqual(beforeDaily.tokens.effectiveOutput);
      expect(afterDaily.tokens.nonOverlappingTotal).toEqual(beforeDaily.tokens.nonOverlappingTotal);
      expect(afterDaily.pricing).toEqual(beforeDaily.pricing);
    }
  });

  it("shows the justified partial-pricing change when an input component was absent", () => {
    const components = {
      inputUncachedTokens: 1_000,
      inputCacheReadTokens: null,
      inputCacheWriteTokens: 0,
      outputTextTokens: 100,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    };
    const before = price(usage(null, components, { idChar: "a" }));
    const after = price(usage(1_000, { ...components, outputCombinedTokens: 125 }, { idChar: "b" }));

    expect(before).toEqual({
      costNanousd: 0,
      pricingStatus: "unpriced",
      modelId: "gpt-6-astra",
    });
    expect(after?.pricingStatus).toBe("partially_priced");
    expect(after?.costNanousd).toBe(16_250_000);
    expect(after?.costNanousd).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  it("keeps cache-retention-v2 output identical because its allowlist ignores repaired fields", () => {
    expect(CACHE_RETENTION_METHOD.version).toBe("cache-retention-v2");
    const components = {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    };
    const map = (
      total: number | null,
      outputCombined: number | null,
      offset: number,
      orderKey: string,
      idChar: string,
    ): CacheRetentionItem => {
      const item = cacheRetentionEventFromRecord({
        sessionDigest: SESSION_DIGEST,
        observedAtMs: DAY_MS + offset,
        orderKey,
        recordJson: storedRecord(usage(
          total,
          { ...components, outputCombinedTokens: outputCombined },
          {
            eventTime: new Date(DAY_MS + offset).toISOString(),
            idChar,
          },
        )),
      });
      expect(item).not.toBeNull();
      expect(item).not.toHaveProperty("unreadable");
      return item as CacheRetentionItem;
    };
    // Keep the occurrence IDs stable across the repair. The corrected fields
    // are total input context and output combined; neither belongs to the
    // cache-v2 allowlist.
    const before = [
      map(null, null, 0, "occ-1", "c"),
      map(null, null, 1_000, "occ-2", "d"),
    ];
    const after = [
      map(1_000, 75, 0, "occ-1", "c"),
      map(1_000, 75, 1_000, "occ-2", "d"),
    ];

    expect(after).toEqual(before);
    const beforeAggregate = reduceCacheRetentionDay({ day: DAY, events: before, carry: [], eventsRead: 2 });
    const afterAggregate = reduceCacheRetentionDay({ day: DAY, events: after, carry: [], eventsRead: 2 });
    expect(beforeAggregate.eventsRead).toBe(2);
    expect(beforeAggregate.groups).toHaveLength(1);
    expect(beforeAggregate.groups[0]?.bands.find(({ band }) => band === "under_one_minute"))
      .toMatchObject({ adjacencies: 1, reusedMoreThanHalf: 1 });
    expect(afterAggregate).toEqual(beforeAggregate);
  });
});
