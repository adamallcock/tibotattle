import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readCommunityRefreshLane, recordCommunityRefreshLane } from "../src/community-refresh-lanes";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { warmCommunityAnalysisCaches } from "../src/community-analysis-warmer";
import { rebuildPendingCommunityDailyAggregates } from "../src/community-daily-aggregates";

const db = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("exact-generation refresh completion", () => {
  it("uses one metadata query and no writes on unchanged current and daily refreshes", async () => {
    for (const lane of ["current", "daily"] as const) {
      const pin = await readCommunityRefreshLane(db(), lane, NOW);
      expect(pin.current).toBe(false);
      expect(await recordCommunityRefreshLane(db(), pin, true, NOW)).toBe(true);
    }
    const meter = createD1InvocationBudget(900);
    const wrapped = meter.wrap(db());
    expect(await warmCommunityAnalysisCaches(wrapped, NOW,
      { meter, deadlineMs: Date.now() + 5_000, maintenanceLease: "synthetic-unused-lease" }))
      .toEqual({ status: "complete", visited: 0, published: 0, resumed: 0 });
    expect(meter.queriesUsed).toBe(1);
    expect(await rebuildPendingCommunityDailyAggregates(wrapped, NOW, 24, {},
      { mode: "cache-only", budget: { remainingQueries: 20, deadlineMs: Date.now() + 5_000 } }))
      .toEqual({ processed: 0, remaining: false, aggregateIds: [] });
    expect(meter.queriesUsed).toBe(2);
  });

  it("does not complete or reuse a source changed during calculation", async () => {
    const pin = await readCommunityRefreshLane(db(), "current", NOW);
    await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    expect(await recordCommunityRefreshLane(db(), pin, true, NOW)).toBe(false);
    expect((await readCommunityRefreshLane(db(), "current", NOW)).current).toBe(false);
  });

  it("invalidates only on source, UTC day, method or queued work, not elapsed minutes", async () => {
    const pin = await readCommunityRefreshLane(db(), "daily", NOW);
    await recordCommunityRefreshLane(db(), pin, true, NOW);
    expect((await readCommunityRefreshLane(db(), "daily", NOW + 5 * 3_600_000)).current).toBe(true);
    expect((await readCommunityRefreshLane(db(), "daily", NOW + 86_400_000)).current).toBe(false);
    await db().prepare("INSERT INTO community_daily_aggregate_rebuilds VALUES('2026-09-06',0,?)")
      .bind(new Date(NOW).toISOString()).run();
    expect((await readCommunityRefreshLane(db(), "daily", NOW)).current).toBe(false);
    expect(await recordCommunityRefreshLane(db(), pin, true, NOW)).toBe(false);
    await db().prepare("UPDATE community_refresh_lanes SET method_version='synthetic-old-method'").run();
    expect((await readCommunityRefreshLane(db(), "daily", NOW)).current).toBe(false);
  });

  it("requires the caller's live lease and records a real source restart", async () => {
    const pin = await readCommunityRefreshLane(db(), "current", NOW);
    expect(await recordCommunityRefreshLane(db(), pin, true, NOW, "synthetic-no-lease")).toBe(false);
    await recordCommunityRefreshLane(db(), pin, false, NOW);
    await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    await recordCommunityRefreshLane(db(), await readCommunityRefreshLane(db(), "current", NOW), false, NOW);
    expect(await db().prepare("SELECT restart_reason FROM community_refresh_lanes WHERE lane='current'").first())
      .toEqual({ restart_reason: "input_changed" });
  });
});
