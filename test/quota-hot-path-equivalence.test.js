import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetEvidence,
  fitResetCapacity,
} from "../packages/quota-analysis/index.js";

const LARGE_COST = 89_999_999_999_999;

function opaqueId(kind, value) {
  return `${kind}:v1:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function instant(hour, minute = 0) {
  return new Date(Date.UTC(2026, 7, 5, hour, minute)).toISOString();
}

function trackInputWithLargeInterleavedCosts() {
  const datasetId = opaqueId("dataset", 1);
  const accountTrackId = opaqueId("account-track", 1);
  const quotaSnapshots = Array.from({ length: 4 }, (_, index) => ({
    snapshotId: opaqueId("snapshot", index + 1),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    slot: "primary",
    windowDurationMinutes: 43_200,
    resetsAt: instant(24),
    observedAt: instant(index),
    receivedAt: instant(index),
    usedPercent: index * 20,
    displayPrecision: 0,
    policyEpoch: "quota-v1",
  }));

  const usageEvents = [];
  function addUsage(hour, minute, costNanousd) {
    usageEvents.push({
      eventId: opaqueId("event", usageEvents.length + 1),
      datasetId,
      accountTrackId,
      provider: "openai",
      planType: "subscription",
      planVariant: "pro",
      limitId: "shared-quota",
      observedAt: instant(hour, minute),
      costNanousd,
      pricingStatus: "fully_priced",
      policyEpoch: "quota-v1",
    });
  }

  // The start-time cost belongs to total usage, but is excluded from every
  // boundary's start-exclusive cumulative cost.
  addUsage(0, 0, LARGE_COST);
  for (let index = 0; index < 52; index += 1) addUsage(0, 30, LARGE_COST);
  addUsage(0, 30, 1);
  addUsage(1, 0, 3);
  for (let index = 0; index < 54; index += 1) addUsage(1, 30, LARGE_COST);
  addUsage(1, 30, 1);
  addUsage(2, 0, 5);
  addUsage(2, 30, 7);
  addUsage(3, 0, 11);

  return {
    input: {
      datasets: [{ datasetId, complete: true }],
      quotaSnapshots,
      usageEvents,
    },
    quotaSnapshots,
    usageEvents,
  };
}

function legacyCumulativeCostAt(usage, firstObservedMs, timestampMs) {
  return usage.reduce((sum, row) => {
    const observedMs = Date.parse(row.observedAt);
    return observedMs > firstObservedMs && observedMs <= timestampMs
      ? sum + row.costNanousd
      : sum;
  }, 0);
}

test("cumulative boundaries match ordered reductions across ties and sums above safe integers", () => {
  const { input, quotaSnapshots, usageEvents } = trackInputWithLargeInterleavedCosts();
  const evidence = buildResetEvidence(input).resets[0];
  const orderedUsage = [...usageEvents].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.eventId.localeCompare(right.eventId)
  ));
  const firstObservedMs = Date.parse(quotaSnapshots[0].observedAt);
  const expected = [{
    usedPercent: quotaSnapshots[0].usedPercent,
    lowerCostNanousd: 0,
    upperCostNanousd: 0,
    observedAt: quotaSnapshots[0].observedAt,
  }];

  for (let index = 1; index < quotaSnapshots.length; index += 1) {
    const prior = quotaSnapshots[index - 1];
    const current = quotaSnapshots[index];
    expected.push({
      usedPercent: current.usedPercent,
      lowerCostNanousd: legacyCumulativeCostAt(
        orderedUsage,
        firstObservedMs,
        Date.parse(prior.observedAt),
      ),
      upperCostNanousd: legacyCumulativeCostAt(
        orderedUsage,
        firstObservedMs,
        Date.parse(current.observedAt),
      ),
      observedAt: current.observedAt,
    });
  }

  assert.equal(evidence.status, "eligible");
  assert.deepEqual(evidence.boundaries, expected);
  assert.ok(evidence.boundaries[2].upperCostNanousd > Number.MAX_SAFE_INTEGER);
  assert.equal(evidence.boundaries[1].lowerCostNanousd, 0);
});

test("extended ISO years retain legacy results when lexical boundaries go backward", () => {
  const datasetId = opaqueId("dataset", 2);
  const accountTrackId = opaqueId("account-track", 2);
  const timestamps = [
    "-000001-01-01T00:00:00.000Z",
    "-000001-12-01T00:00:00.000Z",
    "-000002-12-01T00:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
  ];
  const resetsAt = "+010000-01-01T00:00:00.000Z";
  for (const timestamp of [...timestamps, resetsAt]) {
    assert.equal(new Date(Date.parse(timestamp)).toISOString(), timestamp);
  }
  const quotaSnapshots = timestamps.map((observedAt, index) => ({
    snapshotId: opaqueId("snapshot", index + 20),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    slot: "primary",
    windowDurationMinutes: 43_200,
    resetsAt,
    observedAt,
    receivedAt: observedAt,
    usedPercent: index * 30,
    displayPrecision: 0,
    policyEpoch: "quota-v1",
  }));
  const usageEvents = [
    "-000001-06-01T00:00:00.000Z",
    "-000001-11-01T00:00:00.000Z",
  ].map((observedAt, index) => ({
    eventId: opaqueId("event", index + 200),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    observedAt,
    costNanousd: (index + 1) * 5,
    pricingStatus: "fully_priced",
    policyEpoch: "quota-v1",
  }));
  const evidence = buildResetEvidence({
    datasets: [{ datasetId, complete: true }],
    quotaSnapshots,
    usageEvents,
  }).resets[0];
  const orderedQuota = [...quotaSnapshots].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.slot.localeCompare(right.slot)
    || left.snapshotId.localeCompare(right.snapshotId)
  ));
  const orderedUsage = [...usageEvents].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.eventId.localeCompare(right.eventId)
  ));
  const firstObservedMs = Date.parse(orderedQuota[0].observedAt);
  const expected = [{
    usedPercent: orderedQuota[0].usedPercent,
    lowerCostNanousd: 0,
    upperCostNanousd: 0,
    observedAt: orderedQuota[0].observedAt,
  }];
  for (let index = 1; index < orderedQuota.length; index += 1) {
    const prior = orderedQuota[index - 1];
    const current = orderedQuota[index];
    expected.push({
      usedPercent: current.usedPercent,
      lowerCostNanousd: legacyCumulativeCostAt(
        orderedUsage,
        firstObservedMs,
        Date.parse(prior.observedAt),
      ),
      upperCostNanousd: legacyCumulativeCostAt(
        orderedUsage,
        firstObservedMs,
        Date.parse(current.observedAt),
      ),
      observedAt: current.observedAt,
    });
  }

  assert.equal(evidence.status, "eligible");
  assert.deepEqual(evidence.boundaries, expected);
  assert.deepEqual(
    [evidence.boundaries[2].lowerCostNanousd, evidence.boundaries[2].upperCostNanousd],
    [15, 0],
  );
});

function calibrationEvidence(boundaryCount, includeTinyPercentStep) {
  const boundaries = Array.from({ length: boundaryCount }, (_, index) => {
    const usedPercent = includeTinyPercentStep && index === 1
      ? Number.MIN_VALUE
      : index * 10;
    const cost = index * 1_000_000_000_000 + index ** 2 * 1_000_000_000;
    return {
      usedPercent,
      lowerCostNanousd: cost,
      upperCostNanousd: cost,
      observedAt: instant(index),
    };
  });
  return {
    schemaVersion: "quota-reset-evidence-v0.1",
    status: "eligible",
    refusalCodes: [],
    continuityKey: "continuity:test",
    resetKey: "reset:test",
    accountTrackId: "account-track:test",
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    windowDurationMinutes: 43_200,
    policyEpoch: "quota-v1",
    resetsAt: instant(boundaryCount + 1),
    slots: ["primary"],
    firstObservedAt: boundaries[0].observedAt,
    lastObservedAt: boundaries.at(-1).observedAt,
    snapshotCount: boundaryCount,
    usageEventCount: boundaryCount - 1,
    totalCostNanousd: boundaries.at(-1).upperCostNanousd,
    sourceDatasetCount: 1,
    boundaries,
    quotaSeries: [],
    usageSeries: [],
  };
}

function legacyQuantile(values, probability) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}

function legacyTrainingCandidates(boundaries) {
  const points = [...boundaries].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.usedPercent - right.usedPercent
  ));
  const cutoff = points[0].usedPercent
    + (points.at(-1).usedPercent - points[0].usedPercent) * 0.7;
  let training = points.filter((point) => point.usedPercent <= cutoff);
  let holdout = points.filter((point) => point.usedPercent > cutoff);
  if (training.length < 5 || holdout.length < 2) {
    const split = Math.max(5, Math.min(
      points.length - 2,
      Math.floor(points.length * 0.7),
    ));
    training = points.slice(0, split);
    holdout = points.slice(split);
  }

  const candidates = [];
  for (let left = 0; left < training.length; left += 1) {
    for (let right = left + 1; right < training.length; right += 1) {
      const percentDelta = training[right].usedPercent - training[left].usedPercent;
      const leftCost = (
        training[left].lowerCostNanousd + training[left].upperCostNanousd
      ) / 2;
      const rightCost = (
        training[right].lowerCostNanousd + training[right].upperCostNanousd
      ) / 2;
      const costDelta = rightCost - leftCost;
      if (percentDelta > 0 && costDelta > 0) {
        candidates.push(100 * costDelta / percentDelta);
      }
    }
  }
  return { training, holdout, candidates };
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

test("fit sensitivity reuses one ordered candidate set without changing quantiles", () => {
  for (const [boundaryCount, includeTinyPercentStep] of [
    [8, false], // five training points produce an even candidate count
    [9, true], // six training points produce odd candidates and one infinite slope
  ]) {
    const evidence = calibrationEvidence(boundaryCount, includeTinyPercentStep);
    const { training, candidates } = legacyTrainingCandidates(evidence.boundaries);
    const capacity = legacyQuantile(candidates, 0.5);
    const lower = legacyQuantile(candidates, 0.1);
    const upper = legacyQuantile(candidates, 0.9);
    const result = fitResetCapacity(evidence);

    assert.equal(result.status, "conditional_estimate");
    assert.equal(result.training.boundaryCount, training.length);
    assert.equal(result.capacityNanousd, round(capacity));
    assert.equal(result.training.capacityNanousd, round(capacity));
    assert.deepEqual(result.sensitivityRangeNanousd, {
      lower: round(lower),
      upper: round(upper),
    });
    assert.equal(result.relativeSensitivityWidth, round((upper - lower) / capacity));
  }
});
