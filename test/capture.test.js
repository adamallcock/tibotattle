import test from "node:test";
import assert from "node:assert/strict";
import { captureCodexObservation, summarizeTierCoverage } from "../src/capture.js";

const SCOPE = "openai-account:v1:0123456789abcdef0123456789abcdef0123456789a";

function account() {
  return {
    canonical: {
      planType: "pro",
      limitId: "codex",
      primary: {
        usedPercent: 2,
        windowDurationMins: 10_080,
        resetsAt: 1_785_744_000,
      },
      secondary: null,
    },
    officialDailyTokens: [],
    officialUsageSummary: { lifetimeTokens: 100 },
    accountScope: {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: SCOPE,
      planType: "pro",
    },
    earnedResetCount: 0,
    byLimitId: {},
  };
}

function localUsage(tierCounts) {
  return {
    components: { input_uncached_tokens: 10 },
    totalTokens: 10,
    toolCallsByClass: {},
    diagnostics: {},
    assumptions: [],
    runcost: {
      totalUsd: 0.01,
      byModel: {},
      warningCounts: {},
      priceResolution: {},
      observedTierUsageEventCounts: tierCounts,
    },
  };
}

test("capture retains an aggregate subscription speed attribution without claiming an API tier", async () => {
  const observation = await captureCodexObservation({
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    createObservationId: () => "safe-observation-id",
    readSnapshot: async () => ({ private: "not persisted" }),
    sanitizeSnapshot: () => account(),
    runCcusage: async () => ({ private: "not persisted" }),
    summarizeCcusageReport: () => ({ daily: [] }),
    scanLocal: async () => localUsage({ standard: 3 }),
  });

  const tier = observation.windows[0].local.apiPricing.tierSemantics;
  assert.deepEqual(tier, {
    billingSurface: "chatgpt_subscription",
    codexSpeedMode: "standard",
    apiServiceTier: "unknown",
    tierSource: "rollout_thread_settings",
    attribution: "all_local_usage_events_exactly_attributed",
    observedUsageEventCounts: { standard: 3 },
  });
  assert.equal(JSON.stringify(observation).includes("not persisted"), false);
  assert.equal(observation.accountScope.status, "available");
  assert.equal(observation.planType, "pro");
  assert.equal(observation.privacy.rawAccountIdentifiersStored, false);
});

test("tier coverage labels mixed or unavailable local attribution as unknown", () => {
  assert.deepEqual(summarizeTierCoverage({ runcost: { observedTierUsageEventCounts: { standard: 1, fast: 1 } } }), {
    billingSurface: "chatgpt_subscription",
    codexSpeedMode: "unknown",
    apiServiceTier: "unknown",
    tierSource: "unobserved",
    attribution: "unavailable_or_mixed",
    observedUsageEventCounts: { standard: 1, fast: 1 },
  });
  assert.equal(summarizeTierCoverage({ runcost: { observedTierUsageEventCounts: {} } }).codexSpeedMode, "unknown");
});
