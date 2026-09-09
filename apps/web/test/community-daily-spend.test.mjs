import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMUNITY_DAILY_SPEND_BASIS, normalizeCommunityDailySeries } from "../public/community-data.js";

function spend(overrides = {}) {
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: 12.3456, coverage: "complete",
    usageEvents: 2, fullyPricedUsageEvents: 2, partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0,
    pricingMethodVersion: "server-api-price-equivalent-v0.4", registrySha256: "a".repeat(64), ...overrides,
  };
}

function series(block, usageEvents = 2) {
  const day = "2026-09-05";
  return {
    schemaVersion: "community-daily-read-v1.0", from: day, to: day, allowanceState: "updating",
    days: [{ day, revision: 1, releasedAt: `${day}T00:00:00.000Z`, payload: {
      schemaVersion: "community-daily-aggregate-v1.0", policyVersion: "community-daily-v1.0",
      immutableRevision: true, recomputesOnLateData: true, day, revision: 1,
      totals: { contributingParticipants: 1, contributingDevices: 1, usageEvents, quotaObservations: 0,
        sessionDimensions: 0, inputUncachedTokens: 100, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 25, outputReasoningTokens: 0, outputCombinedTokens: 25 },
      ...(block === undefined ? {} : { apiEquivalentSpend: block }),
    } }],
  };
}

test("additive daily spend preserves old cached days as unavailable, not zero", () => {
  const value = normalizeCommunityDailySeries(series(undefined));
  assert.equal(value.state, "published");
  assert.equal(value.days[0].apiEquivalentSpend, null);
  assert.equal(value.days[0].totals.usageEvents, 2);
});

test("daily spend projects complete and partially priced evidence without guessing unknown cost", () => {
  const complete = spend();
  assert.deepEqual(normalizeCommunityDailySeries(series(complete)).days[0].apiEquivalentSpend, complete);
  const partial = spend({ coverage: "partial", fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 1 });
  assert.deepEqual(normalizeCommunityDailySeries(series(partial)).days[0].apiEquivalentSpend, partial);
  const unavailable = spend({ knownCostUsd: null, coverage: "unavailable", fullyPricedUsageEvents: 0, unpricedUsageEvents: 2 });
  assert.deepEqual(normalizeCommunityDailySeries(series(unavailable)).days[0].apiEquivalentSpend, unavailable);
  const empty = spend({ knownCostUsd: 0, usageEvents: 0, fullyPricedUsageEvents: 0 });
  assert.deepEqual(normalizeCommunityDailySeries(series(empty, 0)).days[0].apiEquivalentSpend, empty);
});

test("daily spend rejects inconsistent coverage, counts, money and unsupported pricing basis without dropping tokens", () => {
  const invalid = [
    null, [], spend({ coverage: "partial" }), spend({ usageEvents: 3 }), spend({ fullyPricedUsageEvents: 1 }),
    spend({ knownCostUsd: null }), spend({ knownCostUsd: -1 }), spend({ knownCostUsd: Infinity }),
    spend({ knownCostUsd: "12" }), spend({ fullyPricedUsageEvents: 1.5 }), spend({ unpricedUsageEvents: -1 }),
    spend({ basis: "fitted_allowance_dollars" }), spend({ currency: "EUR" }), spend({ registrySha256: "unknown" }),
    spend({ pricingMethodVersion: "unknown" }), spend({ coverage: "complete", fullyPricedUsageEvents: 0, unpricedUsageEvents: 2 }),
  ];
  for (const block of invalid) {
    const result = normalizeCommunityDailySeries(series(block));
    assert.equal(result.state, "published");
    assert.equal(result.days[0].apiEquivalentSpend, null);
    assert.equal(result.days[0].totals.inputUncachedTokens, 100);
  }
  assert.equal(normalizeCommunityDailySeries(series(spend({ usageEvents: 0, fullyPricedUsageEvents: 0 }), 0))
    .days[0].apiEquivalentSpend, null);
});

test("daily spend uses a fresh public allowlist and never returns private canaries", () => {
  const canary = "synthetic-private-canary";
  const result = normalizeCommunityDailySeries(series(spend({ privateDiagnostic: { account: canary } })));
  assert.deepEqual(result.days[0].apiEquivalentSpend, spend());
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("whole-day capacity refusal is unavailable, not falsely model-unpriceable or a priced subtotal", () => {
  const resource = spend({ knownCostUsd: null, coverage: "unavailable", usageEvents: 200001,
    fullyPricedUsageEvents: 0, unpricedUsageEvents: 0, unprocessedUsageEvents: 200001,
    unavailableReason: "processing_capacity_exceeded",
    processingPolicyVersion: "daily-spend-capacity-2048-chunks-200000-events" });
  assert.deepEqual(normalizeCommunityDailySeries(series(resource, 200001)).days[0].apiEquivalentSpend, resource);
  for (const change of [{ knownCostUsd: 0 }, { unpricedUsageEvents: 200001 }, { unprocessedUsageEvents: 200000 },
    { unavailableReason: "unknown_model" }, { processingPolicyVersion: "unsupported" }]) {
    assert.equal(normalizeCommunityDailySeries(series({ ...resource, ...change }, 200001)).days[0].apiEquivalentSpend, null);
  }
});
