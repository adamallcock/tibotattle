import test from "node:test";
import assert from "node:assert/strict";
import {
  fastQuotaMultiplier,
  subscriptionSpeedSensitivity,
} from "../src/application/index.js";
import {
  normalizeProviderTier,
  validateTierDeclaration,
} from "../src/providers/codex/logs.js";

test("subscription default and protocol priority normalize to Standard and Fast without inventing API tiers", () => {
  const standard = normalizeProviderTier("default", { billingSurface: "chatgpt_subscription", tierSource: "rollout_thread_settings" });
  const fast = normalizeProviderTier("priority", { billingSurface: "chatgpt_subscription", tierSource: "app_server_effective" });
  assert.equal(standard.codexSpeedMode, "standard");
  assert.equal(fast.codexSpeedMode, "fast");
  assert.equal(fast.apiServiceTier, "unknown");
  assert.equal(fast.providerTierRaw, "priority");
});

test("API Standard, Priority, Flex, and Batch remain independent from Codex speed mode", () => {
  for (const raw of ["standard", "priority", "flex", "batch"]) {
    const normalized = normalizeProviderTier(raw, { billingSurface: "openai_api", tierSource: "config" });
    assert.equal(normalized.apiServiceTier, raw);
    assert.equal(normalized.codexSpeedMode, "unknown");
  }
});

test("clear, omission, and future values remain explicit unknown or other values", () => {
  const clear = normalizeProviderTier(null, { billingSurface: "chatgpt_subscription", tierSource: "rollout_thread_settings", tierObservedAt: "2026-07-23T00:00:00Z" });
  const future = normalizeProviderTier("ultra", { billingSurface: "openai_api", tierSource: "config" });
  assert.equal(clear.codexSpeedMode, "unknown");
  assert.equal(clear.tierObservedAt, "2026-07-23T00:00:00Z");
  assert.equal(future.apiServiceTier, "other");
  assert.equal(future.providerTierRaw, "ultra");
});

test("lineage_inherited is a valid provenance and normalizes speed like any observation", () => {
  // Session-lineage speed carry-forward: a fork descendant seeded from its
  // ancestor chain records the tier under lineage_inherited — same speed
  // semantics, distinct provenance. It must validate end to end.
  const inherited = normalizeProviderTier("priority", {
    billingSurface: "chatgpt_subscription",
    tierSource: "lineage_inherited",
    tierObservedAt: "2026-07-25T00:00:00.000Z",
  });
  assert.equal(inherited.codexSpeedMode, "fast");
  assert.equal(inherited.tierSource, "lineage_inherited");
  assert.deepEqual(validateTierDeclaration(inherited), inherited);
  // The vocabulary is closed: an unknown provenance still throws.
  assert.throws(() => normalizeProviderTier("priority", {
    billingSurface: "chatgpt_subscription",
    tierSource: "global_carry_forward",
  }), /tierSource is invalid/);
});

test("tier declaration rejects cross-surface conflation", () => {
  assert.throws(() => validateTierDeclaration({
    billingSurface: "chatgpt_subscription",
    codexSpeedMode: "fast",
    apiServiceTier: "priority",
    providerTierRaw: "priority",
    tierSource: "experiment_manifest",
    tierObservedAt: null,
  }), /may not declare an API service tier/);
});

test("Fast sensitivity applies published Priority price ratios and never selects unknown", () => {
  assert.equal(fastQuotaMultiplier("gpt-5.6-sol"), 2);
  assert.equal(fastQuotaMultiplier("gpt-5.5-codex"), 2.5);
  assert.equal(fastQuotaMultiplier("gpt-5.4"), 2);
  assert.equal(fastQuotaMultiplier("gpt-4.1"), 1.75);
  const result = subscriptionSpeedSensitivity({
    "gpt-5.6-sol": { costUsd: 10, priceEvidence: {
      eventTime: "2026-08-30T00:00:00.000Z", totalInputContextTokens: 1_000,
    } },
    "gpt-5.4": { costUsd: 5, priceEvidence: {
      eventTime: "2026-08-30T00:00:00.000Z", totalInputContextTokens: 1_000,
    } },
  });
  assert.equal(result.selectedScenario, null);
  assert.equal(result.scenarios.standard.weightedStandardApiEquivalentUsd, 15);
  // 10 x 2 + 5 x 2 at the published GPT-5.6 and GPT-5.4 Priority ratios.
  assert.equal(result.scenarios.fast.weightedStandardApiEquivalentUsd, 30);
});

test("unsupported Fast models are included at the disclosed assumed ratio instead of excluded", () => {
  const result = subscriptionSpeedSensitivity({ "future-model": { costUsd: 7 } }, "fast");
  assert.equal(result.selectedScenario, "fast");
  assert.equal(result.scenarios.fast.complete, true);
  // 7 x 2 assumed, with the assumption reported apart.
  assert.equal(result.scenarios.fast.weightedStandardApiEquivalentUsd, 14);
  assert.equal(result.scenarios.fast.assumedRatioStandardApiEquivalentUsd, 7);
  assert.equal(result.scenarios.fast.assumedRatioMultiplier, 2);
});
