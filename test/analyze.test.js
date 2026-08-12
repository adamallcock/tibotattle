import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeObservations,
  analyzeSeries,
  ordinaryLeastSquares,
  roundedPercentageCapacityInterval,
} from "../src/analyze.js";

test("OLS recovers a synthetic quota capacity", () => {
  const points = Array.from({ length: 10 }, (_, index) => ({ x: index * 6, y: 10 + index }));
  const fit = ordinaryLeastSquares(points);
  assert.ok(Math.abs(fit.capacityUsd - 600) < 1e-9);
  assert.equal(fit.rSquared, 1);
});

test("rounding interval contains the synthetic capacity", () => {
  const points = Array.from({ length: 12 }, (_, index) => ({ x: index * 6, y: Math.round(12.2 + index) }));
  const interval = roundedPercentageCapacityInterval(points);
  assert.equal(interval.feasible, true);
  assert.ok(interval.capacityUsd.min <= 600);
  assert.ok(interval.capacityUsd.max >= 600);
});

test("observations are isolated by reset identity", () => {
  const observations = [
    ["a", 10, 0],
    ["a", 11, 6],
    ["b", 1, 0],
    ["b", 2, 12],
  ].map(([identity, usedPercent, cost], index) => ({
    kind: "codex_quota_observation",
    capturedAt: new Date(index * 1_000).toISOString(),
    controlled: true,
    windows: [{
      identity,
      limitId: "codex",
      slot: "primary",
      windowDurationMins: 10_080,
      resetsAt: identity === "a" ? 100 : 200,
      usedPercent,
      local: {
        runcost: { totalUsd: cost },
        ccusage: { totals: { costUsd: cost } },
      },
    }],
  }));
  const result = analyzeObservations(observations);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((group) => group.apiPricing.observations), [2, 2]);
});

test("observations sharing a reset are partitioned by account scope and plan variant", () => {
  const base = {
    kind: "codex_quota_observation",
    capturedAt: "2026-07-23T00:00:00.000Z",
    controlled: true,
    windows: [{
      identity: "same-reset",
      limitId: "codex",
      slot: "primary",
      windowDurationMins: 10_080,
      resetsAt: 100,
      usedPercent: 10,
      local: { runcost: { totalUsd: 1 }, ccusage: { totals: { costUsd: 1 } } },
    }],
  };
  const result = analyzeObservations([
    { ...base, accountScope: { status: "available", scopeId: "scope-a" }, planType: "pro" },
    { ...base, accountScope: { status: "available", scopeId: "scope-b" }, planType: "prolite" },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((group) => [group.accountScopeId, group.planType]), [
    ["scope-a", "pro"],
    ["scope-b", "prolite"],
  ]);
});

test("legacy snapshot analysis suppresses an origin-aligned capacity", () => {
  const result = analyzeSeries([{
    capturedAt: "2026-07-23T00:00:00.000Z",
    controlled: true,
    x: 1_800,
    y: 90,
  }], { originAligned: true });
  assert.equal(result.originAlignedEstimate, null);
  assert.equal(result.roundedInterval.capacityUsd, null);
  assert.equal(result.identifiability.reportedCapacityUsd, null);
});

test("schema 0.2 API pricing takes precedence over a legacy RunCost field", () => {
  const result = analyzeObservations([{
    schemaVersion: "0.2",
    kind: "codex_quota_observation",
    capturedAt: "2026-07-23T00:00:00.000Z",
    controlled: true,
    windows: [{
      identity: "codex:primary:10080:1",
      limitId: "codex",
      slot: "primary",
      windowDurationMins: 10_080,
      resetsAt: 1,
      usedPercent: 50,
      local: {
        apiPricing: { totalUsd: 100, warningCounts: {} },
        runcost: { totalUsd: 999, warningCounts: {} },
        ccusage: { totals: { costUsd: 101 } },
      },
    }],
  }]);
  assert.equal(result[0].apiPricing.originAlignedEstimate, null);
  assert.equal(result[0].apiPricing.identifiability.verdict, "non_identifiable");
  assert.equal(result[0].apiPricing.identifiability.reportedCapacityUsd, null);
});

test("a two-point perfect fit remains diagnostic and never becomes a reported capacity", () => {
  const result = analyzeSeries([
    { capturedAt: "2026-07-23T00:00:00.000Z", controlled: true, x: 100, y: 10 },
    { capturedAt: "2026-07-23T00:01:00.000Z", controlled: true, x: 110, y: 11 },
  ], { originAligned: true });

  assert.equal(result.fit, null);
  assert.equal(result.identifiability.verdict, "non_identifiable");
  assert.equal(result.identifiability.reportedCapacityUsd, null);
  assert.ok(result.identifiability.failures.includes("fewer_than_20_observations"));
  assert.ok(result.identifiability.failures.includes("legacy_snapshot_report_is_diagnostic_use_transitions_and_infer"));
});

test("collector-only usage snapshots are outside the quota-observation report input", () => {
  const collectorOnly = {
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    model: "unknown",
    components: { input_uncached_tokens: 77_749, input_cache_read_tokens: 3_614_208 },
  };
  assert.deepEqual(analyzeObservations([collectorOnly]), []);
});
