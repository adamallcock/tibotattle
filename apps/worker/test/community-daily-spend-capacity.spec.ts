import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DAILY_SPEND_CAPACITY_POLICY, DAILY_SPEND_CHUNKS_PER_PASS, DAILY_SPEND_CHUNKS_SQL,
  DAILY_SPEND_EVENTS_PER_PASS, isCurrentCommunityDailySpend, priceCommunityDailySpend,
} from "../src/community-daily-spend";

function metadataOnlyDb(count?: number): D1Database {
  const base = env.USAGE_MONITOR_DB;
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (count === undefined || sql !== DAILY_SPEND_CHUNKS_SQL) throw new Error("unexpected raw pricing read");
        // Synthetic bounded journal metadata, not a dense raw-record fixture.
        const rows = Array.from({ length: count }, (_, index) => ({ id: `synthetic-chunk-${index}`,
          participant_id: "synthetic-participant", device_id: "synthetic-device", accepted_record_count: 1 }));
        const statement: D1PreparedStatement = new Proxy(target.prepare("SELECT 1"), {
          get(inner, key) {
            if (key === "bind") return () => statement;
            if (key === "all") return async () => ({ results: rows });
            const value = Reflect.get(inner, key, inner);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
        return statement;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("whole-day spend capacity versus temporary pass exhaustion", () => {
  it("marks an over-cap day unprocessed without any raw read or fabricated unpriceable-model count", async () => {
    const events = DAILY_SPEND_EVENTS_PER_PASS + 1;
    const budget = { remainingChunks: 0, remainingEvents: 0 };
    const result = await priceCommunityDailySpend(metadataOnlyDb(), "2026-09-05", "[]", events, budget);
    expect(result).toMatchObject({ state: "priced", spend: { usageEvents: events, coverage: "unavailable",
      knownCostUsd: null, fullyPricedUsageEvents: 0, partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0,
      unprocessedUsageEvents: events, unavailableReason: "processing_capacity_exceeded",
      processingPolicyVersion: DAILY_SPEND_CAPACITY_POLICY } });
    expect(budget).toEqual({ remainingChunks: 0, remainingEvents: 0 });
    if (result.state !== "priced") throw new Error("Expected a complete unavailable result");
    expect(isCurrentCommunityDailySpend(result.spend)).toBe(true);
    expect(isCurrentCommunityDailySpend({ ...result.spend, processingPolicyVersion: "old-capacity" })).toBe(false);
    expect(isCurrentCommunityDailySpend({ ...result.spend, unpricedUsageEvents: events })).toBe(false);
    expect(isCurrentCommunityDailySpend({ ...result.spend, unavailableReason: "unknown_model" })).toBe(false);
  });

  it("defers a day exactly at the hard event cap when only the shared remaining budget is exhausted", async () => {
    await expect(priceCommunityDailySpend(metadataOnlyDb(), "2026-09-05", "[]", DAILY_SPEND_EVENTS_PER_PASS,
      { remainingChunks: 0, remainingEvents: 0 })).resolves.toEqual({ state: "deferred" });
  });

  it("distinguishes chunk fragmentation beyond hard capacity from temporary chunk-budget exhaustion", async () => {
    const budget = () => ({ remainingChunks: 0, remainingEvents: DAILY_SPEND_EVENTS_PER_PASS });
    await expect(priceCommunityDailySpend(metadataOnlyDb(DAILY_SPEND_CHUNKS_PER_PASS), "2026-09-05", "[]",
      DAILY_SPEND_CHUNKS_PER_PASS, budget())).resolves.toEqual({ state: "deferred" });
    const events = DAILY_SPEND_CHUNKS_PER_PASS + 1;
    const result = await priceCommunityDailySpend(metadataOnlyDb(events), "2026-09-05", "[]", events, budget());
    expect(result).toMatchObject({ state: "priced", spend: { knownCostUsd: null, coverage: "unavailable",
      usageEvents: events, unprocessedUsageEvents: events, unpricedUsageEvents: 0 } });
  });
});
