import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveCodexTransitionSeries,
  deriveCodexTransitionSeriesCooperatively,
} from "../src/codex-transition-miner.js";
import {
  buildPlanAttributionIndex,
  planAttributionContextKey,
} from "@app-usagemonitor/quota-analysis";
import { projectBoundedWeeklyCalibrationSummary } from "../src/reporting/index.js";

const START = Date.parse("2026-08-01T00:00:00.000Z");
const stamp = (second) => new Date(START + second * 1_000).toISOString();
const priceCards = [{
  schema_version: "0.1", id: "synthetic:plan-cost", provider: "openai", model: "gpt-test",
  components: [{ usage_component: "input_uncached_tokens", unit: "token",
    price: { amount: "1", currency: "USD", per: "1" } }],
  source: { name: "synthetic", url: "https://example.invalid", retrieved_at: stamp(0) },
}];
function quota(second, planType, usedPercent, { duration = 10_080, accountScopeId } = {}) {
  return {
    timestamp: stamp(second), accountScopeId,
    window: { provider: "openai_codex", limitId: "codex", planType,
      slot: duration === 300 ? "primary" : "secondary", windowDurationMins: duration,
      resetsAt: Math.floor(START / 1_000) + 604_800, usedPercent },
  };
}
function usage(second, tokens, planType = null, extra = {}) {
  return { timestamp: stamp(second), model: "gpt-test",
    components: { input_uncached_tokens: tokens },
    tierSemantics: { codexSpeedMode: "standard", apiServiceTier: "unknown" },
    ...(planType === null ? {} : { planAttribution: { basis: "same_record", planType, planVariant: null } }),
    ...extra };
}
function options(rawUsageEvents, rateLimitSnapshots, extra = {}) {
  return { startAt: stamp(0), endAt: stamp(100), rawUsageEvents, rateLimitSnapshots,
    priceCards, includeSnapshotIntervals: true, ...extra };
}

test("single-plan legacy arithmetic matches the pinned pre-attribution baseline", async () => {
  // These numerical outputs were compared against the actual miner and weekly
  // reporter at c111fded0da1fd58d90b1f87be5d57afeebf133b. Pricing, calibration
  // kernels and fork/ingest handling are unchanged in this comparison.
  const input = options(
    Array.from({ length: 30 }, (_, index) => usage(index * 10 + 5, 12)),
    Array.from({ length: 31 }, (_, index) => quota(index * 10, "pro", index * 2)),
    { endAt: stamp(310) },
  );
  const result = deriveCodexTransitionSeries(input);
  assert.equal(result.cumulativeScanCostUsd, 360);
  assert.deepEqual(result.transitions.map((row) => ({
    prior: row.priorUsedPercent,
    next: row.nextUsedPercent,
    delta: row.marginalApiPricedUsd,
    priorCost: row.lastPriorCumulativeApiPricedUsd,
    nextCost: row.firstNextCumulativeApiPricedUsd,
    usage: row.marginalUsageEventCount,
  })), Array.from({ length: 30 }, (_, index) => ({
    prior: index * 2, next: (index + 1) * 2, delta: 12,
    priorCost: index * 12, nextCost: (index + 1) * 12, usage: 1,
  })));
  const summary = projectBoundedWeeklyCalibrationSummary(result);
  assert.deepEqual(summary.estimate, {
    qualifyingResets: 1,
    medianApiPriceEquivalentUsd: 600,
    plausibleRangeUsd: { lower: 600, upper: 600 },
    minimumUsd: 600,
    maximumUsd: 600,
  });
  assert.deepEqual(summary.validation, {
    selectedCostBasis: "standard_api",
    sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 0,
    priorResetMeanAbsoluteErrorPercentagePoints: null,
    priorResetAbsoluteBiasPercentagePoints: 0,
    forecastErrorP80PercentagePoints: null,
    scoredPriorResets: 0,
    scoredPriorPoints: 0,
  });
  assert.deepEqual(await deriveCodexTransitionSeriesCooperatively(input), result);
});

test("plan eras route quantities once and never glue a Pro return across Plus", async () => {
  const snapshots = [
    quota(0, "pro", 0), quota(10, "pro", 10),
    quota(20, "plus", 0), quota(30, "plus", 10),
    quota(40, "pro", 10), quota(50, "pro", 20),
  ];
  const input = options([
    usage(5, 20, "pro", { usageIntervalStartedAt: stamp(1) }),
    usage(25, 1, "plus", { usageIntervalStartedAt: stamp(21) }),
    usage(45, 30, "pro", { usageIntervalStartedAt: stamp(41) }),
  ], snapshots);
  const result = deriveCodexTransitionSeries(input);
  assert.deepEqual(result.transitions.map((row) => [row.planType, row.marginalApiPricedUsd]),
    [["pro", 20], ["plus", 1], ["pro", 30]]);
  assert.equal(result.cumulativeScanCostUsd, 51, "the accounting ledger is unchanged");
  assert.equal(result.transitions[2].firstNextCumulativeApiPricedUsd, 30,
    "the returned Pro cumulative numerator excludes both earlier eras");
  assert.notEqual(result.transitions[0].planEraKey, result.transitions[2].planEraKey);
  assert.deepEqual(await deriveCodexTransitionSeriesCooperatively(input), result);
});

test("a short quota-only plan conflict survives requested-window filtering", () => {
  const input = options([usage(5, 20), usage(25, 30)], [
    quota(0, "pro", 0), quota(10, "pro", 10),
    quota(15, "plus", 1, { duration: 300 }),
    quota(20, "pro", 10), quota(30, "pro", 20),
  ], { windowDurationMins: 10_080 });
  const result = deriveCodexTransitionSeries(input);
  assert.equal(result.transitions.length, 2);
  assert.notEqual(result.transitions[0].planEraKey, result.transitions[1].planEraKey);
  assert.equal(result.transitions[1].lastPriorObservedAt, stamp(20));
});

test("a crossing cumulative delta is diagnostic without poisoning later clean quantities", () => {
  const input = options([
    usage(21, 80, "plus", { usageIntervalStartedAt: stamp(9) }),
    usage(31, 2, "plus", { usageIntervalStartedAt: stamp(30) }),
  ], [quota(0, "pro", 0), quota(10, "pro", 10), quota(20, "plus", 0),
    quota(30, "plus", 10), quota(40, "plus", 20)]);
  const result = deriveCodexTransitionSeries(input);
  const plus = result.transitions.filter((row) => row.planType === "plus");
  assert.equal(plus[0].aggregationEligibility, "diagnostic_only");
  assert.equal(plus[0].quantityAttribution.unresolvedUsageEvents, 1);
  assert.equal(plus[1].aggregationEligibility, "primary_conditional");
  assert.equal(plus[1].marginalApiPricedUsd, 2);
  assert.equal(result.cumulativeScanCostUsd, 82);
});

test("known other-account quantities do not poison A; unresolved possible A quantities do", () => {
  const snapshots = ["synthetic-a", "synthetic-b"].flatMap((accountScopeId) => [
    quota(0, "pro", 0, { accountScopeId }), quota(10, "pro", 10, { accountScopeId }),
  ]);
  const clean = options([
    usage(5, 20, "pro", { accountScopeId: "synthetic-a" }),
    usage(7, 80, "pro", { accountScopeId: "synthetic-b" }),
  ], snapshots);
  const result = deriveCodexTransitionSeries(clean);
  const a = result.transitions.find((row) => row.accountScopeId === "synthetic-a");
  assert.equal(a.marginalApiPricedUsd, 20);
  assert.equal(a.quantityAttribution.unresolvedUsageEvents, 0);
  const ambiguous = deriveCodexTransitionSeries({ ...clean,
    rawUsageEvents: [...clean.rawUsageEvents, usage(8, 80)] });
  assert.equal(ambiguous.transitions.find((row) => row.accountScopeId === "synthetic-a")
    .aggregationEligibility, "diagnostic_only");
  assert.equal(ambiguous.cumulativeScanCostUsd, 180);
});

test("a full attribution index survives reset-sized derivation batches", () => {
  const snapshots = [
    quota(0, "pro", 0), quota(10, "pro", 10), quota(15, "plus", 0),
    quota(20, "pro", 10), quota(30, "pro", 20),
  ];
  const index = buildPlanAttributionIndex(snapshots.map((snapshot) => ({
    contextKey: planAttributionContextKey("openai_codex", "codex"),
    observedAtMs: Date.parse(snapshot.timestamp), planType: snapshot.window.planType,
  })));
  const result = deriveCodexTransitionSeries(options([usage(25, 2)],
    snapshots.filter((row) => row.window.planType === "pro"), { planAttributionIndex: index }));
  assert.equal(new Set(result.transitions.map((row) => row.planEraKey)).size, 2);
});
