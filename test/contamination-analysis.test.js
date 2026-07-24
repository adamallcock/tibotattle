import test from "node:test";
import assert from "node:assert/strict";
import { analyzeContamination, renderContaminationReport } from "../src/contamination-analysis.js";
import { stableJson } from "../src/storage.js";

const RESET = 1784854800;
const START = Date.parse("2026-07-23T00:00:00.000Z");

function at(index) {
  return new Date(START + index * 60_000).toISOString();
}

function transition({
  index,
  prior = index - 1,
  next = index,
  capacityUsd = 100,
  priorCostUsd = (prior * capacityUsd) / 100,
  nextCostUsd = (next * capacityUsd) / 100,
  eventCount = 1,
  controlledState = "controlled",
  reset = RESET,
  planType = "pro",
  priceCardIds = ["openai:gpt-test:price-a"],
  modelMix = { "gpt-test": { events: 1, costUsd: 1, components: {} } },
  snapshotAgeMs = null,
  localReceiptLagMs = null,
  warnings = [],
  sourceMarker = null,
} = {}) {
  const eventTime = at(index);
  return {
    parserVersion: "0.3.0",
    provider: "openai_codex",
    planType,
    limitId: "codex",
    slot: "primary",
    windowDurationMins: 10080,
    resetsAt: reset,
    resetIdentity: new Date(reset * 1000).toISOString(),
    eventTime,
    priorUsedPercent: prior,
    nextUsedPercent: next,
    lastPriorObservedAt: at(index - 0.1),
    firstNextObservedAt: eventTime,
    lastPriorCumulativeApiPricedUsd: priorCostUsd,
    firstNextCumulativeApiPricedUsd: nextCostUsd,
    marginalApiPricedUsd: nextCostUsd - priorCostUsd,
    marginalUsageEventCount: eventCount,
    marginalComponents: eventCount > 0 ? { input_uncached_tokens: 100 } : {},
    modelMix,
    aggregateToolClassMix: {},
    controlledState,
    priceCardIds,
    snapshot: {
      source: "rollout_token_count",
      providerSnapshotAgeMs: snapshotAgeMs,
      localReceiptLagMs,
      // A deliberately private-looking field.  Analysis output must aggregate
      // evidence and never serialize source-event, rollout, or session IDs.
      sourceMarker,
    },
    displayLagEnvelopes: {
      byEventCount: [{ maxLagEvents: 1, lowerCumulativeApiPricedUsd: priorCostUsd, upperCumulativeApiPricedUsd: nextCostUsd }],
      byElapsedTime: [{ maxLagMs: 60_000, lowerCumulativeApiPricedUsd: priorCostUsd, upperCumulativeApiPricedUsd: nextCostUsd }],
    },
    quality: {
      localCoverage: { elapsedTimeCoverageFraction: 1, fullWindowStartsAt: at(-100) },
      pricingWarnings: [],
      attributionWarnings: [],
      warnings,
    },
  };
}

function transitionDataset(transitions) {
  return {
    schemaVersion: "0.3",
    parserVersion: "0.3.0",
    materializedAt: at(99),
    scope: {
      provider: "openai_codex",
      localOnly: true,
      startAt: at(-100),
      endAt: at(100),
    },
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions,
  };
}

function inferenceReport({ capacityUsd = 100, rangeIdentified = true } = {}) {
  return {
    schemaVersion: "0.3",
    estimatorVersion: "interval-boundary-v0.3.0",
    materializedAt: at(99),
    source: { transitionSchemaVersion: "0.3", scope: { startAt: at(-100), endAt: at(100) } },
    overallVerdict: rangeIdentified ? "range_identified" : "non_identifiable",
    series: [{
      classification: {
        provider: "openai_codex",
        planType: "pro",
        limitId: "codex",
        slot: "primary",
        windowDurationMins: 10080,
      },
      models: {
        floor: {
          robustEstimate: { capacityUsd },
          jointlyFeasibleCapacityUsd: {
            feasible: rangeIdentified,
            lowerUsd: rangeIdentified ? capacityUsd - 1 : null,
            upperUsd: rangeIdentified ? capacityUsd + 1 : null,
          },
        },
      },
      identifiability: {
        verdict: rangeIdentified ? "range_identified" : "non_identifiable",
        reportedCapacityRangeUsd: rangeIdentified ? { lower: capacityUsd - 1, upper: capacityUsd + 1 } : null,
      },
    }],
  };
}

function analyze(transitions, options = {}) {
  return analyzeContamination({
    transitionDataset: transitionDataset(transitions),
    inferenceReport: inferenceReport(options),
    experimentResults: options.experimentResults ?? [],
  });
}

function records(value) {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(records)];
}

function containsTerms(value, terms) {
  const text = stableJson(value).toLowerCase();
  return terms.every((term) => text.includes(term));
}

function assertHasEvidence(value, terms, message) {
  assert.ok(records(value).some((record) => containsTerms(record, terms)), message);
}

function assertCommonShape(result) {
  assert.ok(Array.isArray(result.intervals), "analysis should retain interval-level evidence");
  assert.equal(typeof result.views, "object");
  assert.equal(typeof result.views.byControlState, "object");
  assert.ok(Array.isArray(result.views.changePoints));
  assert.ok(Array.isArray(result.views.structuralChanges));
  assert.ok(Array.isArray(result.views.staleCatchUps));
  assert.ok(Array.isArray(result.views.sensitivity));
  assert.equal(typeof result.dataBoundaries, "object");
  assert.equal(typeof result.views.explainedMovement, "object");
}

test("explained movement is explicitly unavailable when the capacity/control gate is non-identifiable", () => {
  const result = analyze([
    transition({ index: 1, prior: 10, next: 11, priorCostUsd: 10, nextCostUsd: 11 }),
  ], { rangeIdentified: false });

  assert.equal(result.overallVerdict, "non_identifiable");
  assert.equal(result.views.explainedMovement.count, null);
  assert.match(result.views.explainedMovement.status, /not_measurable|non_identifiable/i);
  assert.equal(typeof result.views.unexplainedMovement.count, "number");
  assert.match(renderContaminationReport(result), /Explained movement: not measurable/i);
});

test("distinguishes an injected other-device quota burn from missing local usage events", () => {
  const result = analyze([
    transition({ index: 10, prior: 10, next: 15, priorCostUsd: 10, nextCostUsd: 10, eventCount: 0, controlledState: "uncontrolled" }),
    transition({ index: 11, prior: 15, next: 17, priorCostUsd: 10, nextCostUsd: 10, eventCount: 0, controlledState: "controlled" }),
  ]);

  assertCommonShape(result);
  assert.equal(result.views.byControlState.uncontrolled.intervals, 1, "the uncontrolled interval must stay outside the controlled view");
  assertHasEvidence(result.intervals, ["quota_movement_without_local_cost"], "a controlled quota movement without local events must be marked as a missing-local-event possibility");
  assertHasEvidence(result.intervals, ["other", "surface", "device"], "a positive unexplained residual must retain other-device/surface use as a competing hypothesis");
  assert.equal(result.dataBoundaries.causalInterpretation, "not_supported_by_residuals_alone");
});

test("recognizes a stale snapshot followed by a local catch-up jump", () => {
  const result = analyze([
    transition({ index: 20, prior: 20, next: 20, priorCostUsd: 20, nextCostUsd: 23, snapshotAgeMs: 240_000, localReceiptLagMs: 240_000 }),
    transition({ index: 21, prior: 20, next: 23, priorCostUsd: 23, nextCostUsd: 23.1, snapshotAgeMs: 0, localReceiptLagMs: 0 }),
  ]);

  assertCommonShape(result);
  assert.ok(result.views.staleCatchUps.length > 0, "delayed snapshots followed by a multi-point jump need a stale/catch-up explanation");
  assertHasEvidence(result.intervals, ["stale_provider_snapshot"], "catch-up evidence must be explicitly labelled as stale rather than capacity movement");
});

test("records plan/reset and pricing-source changes as structural boundaries", () => {
  const result = analyze([
    transition({ index: 30, prior: 30, next: 31, priorCostUsd: 30, nextCostUsd: 31 }),
    transition({ index: 31, prior: 31, next: 32, priorCostUsd: 31, nextCostUsd: 32, planType: "team", reset: RESET + 604800, priceCardIds: ["openai:gpt-test:price-b"] }),
    transition({ index: 32, prior: 32, next: 33, priorCostUsd: 32, nextCostUsd: 33, planType: "team", reset: RESET + 2 * 604800, priceCardIds: ["openai:gpt-test:price-b"] }),
  ]);

  assertCommonShape(result);
  assertHasEvidence(result.views.structuralChanges, ["plan"], "a plan/reset boundary must not be treated as an ordinary residual change");
  assertHasEvidence(result.views.structuralChanges, ["reset"], "the new reset identity must be reported as structural");
  assertHasEvidence(result.views.structuralChanges, ["pric"], "a changed price-card source must be reported as structural");
});

test("keeps model fallback and mixed-model intervals visible to sensitivity analysis", () => {
  const result = analyze([
    transition({ index: 40, prior: 40, next: 41, priorCostUsd: 40, nextCostUsd: 41 }),
    transition({
      index: 41,
      prior: 41,
      next: 42,
      priorCostUsd: 41,
      nextCostUsd: 43,
      modelMix: {
        "gpt-test": { events: 1, costUsd: 1, components: {} },
        "gpt-fallback": { events: 1, costUsd: 1, components: {} },
      },
    }),
  ]);

  assertCommonShape(result);
  assert.ok(result.views.sensitivity.length > 0, "capacity sensitivity must be emitted rather than silently pooling model compositions");
  assertHasEvidence(result.intervals, ["mixed_model_or_fallback_activity"], "a fallback model must remain identifiable in the aggregate output");
});

test("flags a genuine capacity/residual change point but not ordinary bounded noise", () => {
  const trueChange = analyze([
    ...Array.from({ length: 8 }, (_, offset) => transition({ index: 50 + offset, prior: offset, next: offset + 1, priorCostUsd: offset, nextCostUsd: offset + 1 })),
    ...Array.from({ length: 8 }, (_, offset) => transition({ index: 70 + offset, prior: offset, next: offset + 1, capacityUsd: 200, priorCostUsd: offset * 2, nextCostUsd: (offset + 1) * 2, reset: RESET + 604800 })),
  ], { capacityUsd: 100 });
  const boundedNoise = analyze(Array.from({ length: 12 }, (_, offset) => {
    const noise = [0.08, -0.07, 0.03, -0.04][offset % 4];
    return transition({ index: 100 + offset, prior: offset, next: offset + 1, priorCostUsd: offset + noise, nextCostUsd: offset + 1 + noise });
  }));

  assertCommonShape(trueChange);
  assert.ok(trueChange.views.changePoints.some((item) => item.tested && item.flagged), "a sustained 100-to-200 USD change must appear as a capacity/residual change point");
  assert.equal(boundedNoise.views.changePoints.some((item) => item.flagged), false, "sub-percent bounded noise around a 100 USD capacity must not flag a change point");
});

test("separates controlled, uncontrolled, and unknown views without pooling their conclusions", () => {
  const result = analyze([
    transition({ index: 120, controlledState: "controlled" }),
    transition({ index: 121, controlledState: "uncontrolled" }),
    transition({ index: 122, controlledState: "unknown" }),
  ]);

  assertCommonShape(result);
  for (const state of ["controlled", "uncontrolled", "unknown"]) {
    assert.ok(result.views.byControlState[state], `missing ${state} view`);
    assert.equal(result.views.byControlState[state].intervals, 1, `${state} evidence must remain separately inspectable`);
  }
});

test("retains completed-experiment cost without quota movement, serializes deterministically, and removes stable identifiers", () => {
  const privateId = "rollout-private-stable-id-7f3f0e53";
  const experimentResults = [{
    schemaVersion: "0.3",
    kind: "controlled_micro_workload_result",
    status: "completed",
    controlledState: "controlled",
    experimentId: "private-experiment-id",
    startedAt: at(140),
    endedAt: at(141),
    before: { windows: [{ provider: "openai_codex", planType: "pro", limitId: "codex", slot: "primary", windowDurationMins: 10080, resetsAt: RESET }] },
    measuredLocal: { apiPricedUsd: 0.84, models: { "gpt-test": { events: 1 } }, diagnostics: { pricedEvents: 1 } },
    quotaChanges: [{ limitId: "codex", slot: "primary", windowDurationMins: 10080, resetsAt: RESET, beforeUsedPercent: 40, afterUsedPercent: 40 }],
  }];
  const transitions = [transition({ index: 140, sourceMarker: privateId })];
  const first = analyze(transitions, { experimentResults });
  const second = analyze(transitions, { experimentResults });

  assertCommonShape(first);
  assertHasEvidence(first.intervals, ["controlled_experiment", "cost_without_quota_movement"], "completed local cost with zero displayed movement must remain visible as a controlled experiment interval");
  assert.equal(stableJson(first), stableJson(second), "contamination analysis must be deterministic");
  const serialized = stableJson(first);
  assert.equal(serialized.includes(privateId), false, "raw source/rollout identifiers must not leak into the analysis artifact");
  assert.equal(serialized.includes("private-experiment-id"), false, "stable experiment identifiers must not leak into the analysis artifact");
  assert.equal(serialized.includes("private-reset-id"), false, "stable reset identifiers must not leak into the analysis artifact");
});

test("official daily buckets remain lagging signals and cannot change interval residual arithmetic", () => {
  const transitions = [transition({ index: 150, prior: 10, next: 11, priorCostUsd: 10, nextCostUsd: 11 })];
  const input = {
    transitionDataset: transitionDataset(transitions),
    inferenceReport: inferenceReport(),
  };
  const withoutBuckets = analyzeContamination(input);
  const withBuckets = analyzeContamination({
    ...input,
    captureObservations: [{
      kind: "codex_quota_observation",
      capturedAt: at(151),
      windows: [{
        limitId: "codex",
        slot: "primary",
        windowDurationMins: 10080,
        resetsAt: RESET,
        officialTokenActivity: {
          currentUtcDayTokens: 1000,
          dateBucketTotalSinceStartDate: 2000,
          localToOfficialCurrentDayRatio: 0.5,
        },
      }],
    }],
  });
  assert.deepEqual(withBuckets.intervals, withoutBuckets.intervals);
  assert.deepEqual(withBuckets.summary, withoutBuckets.summary);
  assert.equal(withBuckets.views.dailyBucketSignals.length, 1);
  assert.equal(withBuckets.views.dailyBucketSignals[0].role, "lagging_anomaly_signal_only_not_interval_denominator_or_correction");
});
