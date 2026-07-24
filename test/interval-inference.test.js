import test from "node:test";
import assert from "node:assert/strict";
import { inferCapacityFromTransitions, renderInferenceReport } from "../src/interval-inference.js";
import { stableJson } from "../src/storage.js";

function syntheticTransition({ q, capacity, rounding = "floor", reset = 1784854800, index = q, controlledState = "controlled", outlierUsd = 0, offsetUsd = 7 }) {
  const threshold = rounding === "nearest" ? q - 0.5 : q;
  const crossing = threshold * capacity / 100 - offsetUsd + outlierUsd;
  const timestamp = new Date(Date.UTC(2026, 6, 23, 0, 0, index)).toISOString();
  const fullWindowStartsAt = new Date((reset - 10080 * 60) * 1000).toISOString();
  return {
    parserVersion: "0.3.0",
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: "primary",
    windowDurationMins: 10080,
    resetsAt: reset,
    resetIdentity: new Date(reset * 1000).toISOString(),
    eventTime: timestamp,
    priorUsedPercent: q - 1,
    nextUsedPercent: q,
    lastPriorObservedAt: timestamp,
    firstNextObservedAt: timestamp,
    lastPriorCumulativeApiPricedUsd: crossing - 0.05,
    firstNextCumulativeApiPricedUsd: crossing + 0.05,
    marginalApiPricedUsd: 0.1,
    marginalUsageEventCount: 1,
    marginalComponents: {
      input_uncached_tokens: 100,
      input_cache_read_tokens: 50,
      input_cache_write_tokens: 0,
      output_text_tokens: 10,
      output_reasoning_tokens: 5,
    },
    modelMix: { "gpt-test": { events: 1, costUsd: 0.1, components: {} } },
    aggregateToolClassMix: {},
    controlledState,
    priceCardIds: ["test"],
    snapshot: { source: "rollout_token_count", providerSnapshotAgeMs: null, localReceiptLagMs: null },
    displayLagEnvelopes: {
      byEventCount: [{ maxLagEvents: 1, lowerCumulativeApiPricedUsd: crossing - 0.2, upperCumulativeApiPricedUsd: crossing + 0.05 }],
      byElapsedTime: [{ maxLagMs: 30000, lowerCumulativeApiPricedUsd: crossing - 0.3, upperCumulativeApiPricedUsd: crossing + 0.05 }],
    },
    quality: {
      localCoverage: {
        elapsedTimeCoverageFraction: 1,
        fullWindowStartsAt,
      },
      pricingWarnings: [],
      attributionWarnings: [],
      warnings: ["provider_snapshot_age_unavailable"],
    },
  };
}

function dataset(transitions) {
  return {
    schemaVersion: "0.3",
    parserVersion: "0.3.0",
    materializedAt: "2026-07-23T01:00:00.000Z",
    scope: { provider: "openai_codex", localOnly: true, startAt: "2026-07-16T00:00:00.000Z", endAt: "2026-07-23T01:00:00.000Z" },
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions,
  };
}

test("floor-generated transitions recover the known capacity in the exact interval", () => {
  const transitions = Array.from({ length: 12 }, (_, index) => syntheticTransition({ q: index + 1, capacity: 100 }));
  const result = inferCapacityFromTransitions(dataset(transitions));
  const series = result.series[0];
  const interval = series.models.floor.jointlyFeasibleCapacityUsd;
  assert.equal(interval.feasible, true);
  assert.ok(interval.lowerUsd <= 100 && interval.upperUsd >= 100);
  assert.ok(Math.abs(series.models.floor.robustEstimate.capacityUsd - 100) < 0.001);
  assert.equal(series.identifiability.verdict, "range_identified");
});

test("inference never pools the same quota series across account or plan partitions", () => {
  const first = Array.from({ length: 8 }, (_, index) => ({
    ...syntheticTransition({ q: index + 1, capacity: 100 }),
    accountScopeId: "scope-a",
    planVariant: "pro-20x",
  }));
  const second = Array.from({ length: 8 }, (_, index) => ({
    ...syntheticTransition({ q: index + 1, capacity: 200 }),
    accountScopeId: "scope-b",
    planVariant: "pro-5x",
  }));
  const result = inferCapacityFromTransitions(dataset([...first, ...second]));
  assert.equal(result.series.length, 2);
  assert.deepEqual(result.series.map((series) => [series.classification.accountScopeId, series.classification.planVariant]), [
    ["scope-a", "pro-20x"],
    ["scope-b", "pro-5x"],
  ]);
});

test("nearest-generated transitions recover capacity and origin alignment discriminates the wrong rounding model", () => {
  const transitions = Array.from({ length: 12 }, (_, index) => syntheticTransition({ q: index + 1, capacity: 120, rounding: "nearest", offsetUsd: 0 }));
  const series = inferCapacityFromTransitions(dataset(transitions)).series[0];
  const nearest = series.models.nearest.jointlyFeasibleCapacityUsd;
  assert.equal(nearest.feasible, true);
  assert.ok(nearest.lowerUsd <= 120 && nearest.upperUsd >= 120);
  assert.equal(series.modelComparison.floorAndNearestSlopeEquivalentWithPerResetOffset, true);
  assert.equal(series.models.nearest.originAlignedSensitivity.feasible, true);
  assert.equal(series.models.floor.originAlignedSensitivity.feasible, false);
});

test("bounded delayed-display models use observed event and time envelopes", () => {
  const transitions = Array.from({ length: 12 }, (_, index) => syntheticTransition({ q: index + 1, capacity: 80 }));
  const series = inferCapacityFromTransitions(dataset(transitions)).series[0];
  const immediate = series.models.floor.jointlyFeasibleCapacityUsd;
  const delayedEvent = series.models.delayedEvent1.jointlyFeasibleCapacityUsd;
  const delayedTime = series.models.delayedTime30s.jointlyFeasibleCapacityUsd;
  assert.equal(delayedEvent.feasible, true);
  assert.equal(delayedTime.feasible, true);
  assert.ok(delayedEvent.lowerUsd <= immediate.lowerUsd);
  assert.ok(delayedEvent.upperUsd >= immediate.upperUsd);
  assert.ok(delayedTime.upperUsd >= delayedEvent.upperUsd);
});

test("pairwise robust estimate resists one controlled outlier", () => {
  const transitions = Array.from({ length: 15 }, (_, index) => syntheticTransition({
    q: index + 1,
    capacity: 100,
    outlierUsd: index === 7 ? 30 : 0,
  }));
  const series = inferCapacityFromTransitions(dataset(transitions)).series[0];
  assert.ok(Math.abs(series.models.floor.robustEstimate.capacityUsd - 100) < 1);
  assert.equal(series.models.floor.jointlyFeasibleCapacityUsd.feasible, false);
  assert.equal(series.identifiability.verdict, "non_identifiable");
});

test("low display span is explicitly non-identifiable", () => {
  const transitions = [1, 2, 3].map((q) => syntheticTransition({ q, capacity: 100 }));
  const result = inferCapacityFromTransitions(dataset(transitions));
  const series = result.series[0];
  assert.equal(series.identifiability.verdict, "non_identifiable");
  assert.ok(series.identifiability.failures.includes("too_few_eligible_transitions"));
  assert.ok(series.identifiability.failures.includes("insufficient_displayed_percentage_span"));
  const report = renderInferenceReport(result);
  assert.doesNotMatch(report, /\$\d/);
  assert.doesNotMatch(report, /Robust pairwise median|bootstrap 95%|holdout MAE/i);
  assert.match(report, /diagnostics are withheld/i);
});

test("incompatible reset capacities yield an incompatibility and a change-point warning", () => {
  const first = Array.from({ length: 12 }, (_, index) => syntheticTransition({ q: index + 1, capacity: 100, index }));
  const second = Array.from({ length: 12 }, (_, index) => syntheticTransition({
    q: index + 1,
    capacity: 180,
    reset: 1785459600,
    index: index + 30,
  }));
  const series = inferCapacityFromTransitions(dataset([...first, ...second])).series[0];
  assert.equal(series.models.floor.jointlyFeasibleCapacityUsd.feasible, false);
  assert.equal(series.models.floor.changePointDiagnostic.tested, true);
  assert.equal(series.models.floor.changePointDiagnostic.flagged, true);
  assert.ok(series.identifiability.failures.includes("candidate_capacity_change_point"));
});

test("skipped percentages and irregular increments remain recoverable", () => {
  const transitions = [1, 3, 6, 8, 11, 14, 18, 21].map((q, index) => syntheticTransition({ q, capacity: 150, index }));
  const series = inferCapacityFromTransitions(dataset(transitions)).series[0];
  assert.ok(Math.abs(series.models.floor.robustEstimate.capacityUsd - 150) < 0.001);
  assert.equal(series.models.floor.jointlyFeasibleCapacityUsd.feasible, true);
});

test("bootstrap and serialized inference are deterministic", () => {
  const input = dataset(Array.from({ length: 12 }, (_, index) => syntheticTransition({ q: index + 1, capacity: 100 })));
  const first = inferCapacityFromTransitions(input);
  const second = inferCapacityFromTransitions(input);
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(first.series[0].models.floor.robustEstimate.bootstrap95PercentUsd.replicates, 500);
  assert.equal(first.series[0].models.floor.robustEstimate.bootstrap95PercentUsd.seed, 0x5eed2026);
});
