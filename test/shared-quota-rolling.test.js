import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetEvidence,
  buildRollingQuotaComparisons,
} from "@app-usagemonitor/quota-analysis";

function opaqueId(kind, value) {
  return `${kind}:v1:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function instant(day, hour, minute = 0) {
  return new Date(Date.UTC(2026, 6, day, hour, minute)).toISOString();
}

function rollingFixture(duration = 300) {
  const datasetId = opaqueId("dataset", duration);
  const accountTrackId = opaqueId("account-track", 1);
  const quotaSnapshots = Array.from({ length: 5 }, (_, index) => ({
    snapshotId: opaqueId("snapshot", duration * 100 + index),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    slot: "primary",
    windowDurationMinutes: duration,
    resetsAt: instant(1, 6),
    observedAt: instant(1, index + 1),
    receivedAt: instant(1, index + 1),
    usedPercent: index,
    displayPrecision: 0,
    policyEpoch: "quota-v1",
  }));
  const usageEvents = Array.from({ length: 4 }, (_, index) => ({
    eventId: opaqueId("event", duration * 100 + index),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    observedAt: instant(1, index + 1, 30),
    costNanousd: 6_000_000_000,
    pricingStatus: "fully_priced",
    policyEpoch: "quota-v1",
  }));
  return {
    datasets: [{ datasetId, complete: true }],
    quotaSnapshots,
    usageEvents,
  };
}

function forecast() {
  return {
    method: "median_of_prior_completed_resets",
    priorResetCount: 2,
    priorResetKeys: ["prior-reset-1", "prior-reset-2"],
    trainedThrough: instant(0, 23),
    capacityNanousd: 600_000_000_000,
  };
}

function build(input, capacityForecast = forecast()) {
  return buildRollingQuotaComparisons({
    resetEvidence: buildResetEvidence(input).resets[0],
    capacityForecast,
  });
}

function compact(result) {
  return result.comparisons.map((row) => ({
    smoothingHours: row.smoothingHours,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    costNanousd: row.costNanousd,
    observedMovementPp: row.observedMovementPp,
    expectedMovementPp: row.expectedMovementPp,
    differencePp: row.differencePp,
  }));
}

test("one-, two-, and three-hour comparisons are duration-generic", () => {
  const fiveHour = build(rollingFixture(300));
  const sevenDay = build(rollingFixture(10_080));
  assert.equal(fiveHour.status, "conditional_comparison");
  assert.equal(sevenDay.status, "conditional_comparison");
  assert.deepEqual(compact(sevenDay), compact(fiveHour));
  assert.deepEqual(
    [...new Set(fiveHour.comparisons.map((row) => row.smoothingHours))],
    [1, 2, 3],
  );
});

test("rolling endpoints are exact UTC hours inside one reset window", () => {
  const result = build(rollingFixture());
  const resetStartMs = Date.parse(result.resetWindowStart);
  const resetEndMs = Date.parse(result.resetWindowEnd);
  assert.ok(result.comparisons.length > 0);
  for (const row of result.comparisons) {
    assert.match(row.windowStart, /T\d{2}:00:00\.000Z$/u);
    assert.match(row.windowEnd, /T\d{2}:00:00\.000Z$/u);
    assert.ok(Date.parse(row.windowStart) >= resetStartMs);
    assert.ok(Date.parse(row.windowEnd) <= resetEndMs);
    assert.equal(
      Date.parse(row.windowEnd) - Date.parse(row.windowStart),
      row.smoothingHours * 3_600_000,
    );
  }
});

test("missing endpoint observations are not filled across gaps", () => {
  const partial = rollingFixture();
  partial.quotaSnapshots = partial.quotaSnapshots.filter(
    (row) => row.observedAt !== instant(1, 3),
  );
  const result = build(partial);
  assert.equal(result.status, "conditional_comparison");
  assert.ok(result.comparisons.length > 0);
  assert.equal(
    result.comparisons.some(
      (row) => row.windowStart === instant(1, 3)
        || row.windowEnd === instant(1, 3),
    ),
    false,
  );

  const noUsableEndpoints = rollingFixture();
  noUsableEndpoints.quotaSnapshots =
    noUsableEndpoints.quotaSnapshots.filter((_, index) => [0, 4].includes(index));
  const refused = build(noUsableEndpoints);
  assert.equal(refused.status, "not_testable");
  assert.deepEqual(refused.refusalCodes, ["endpoint_brackets_unavailable"]);
  assert.deepEqual(refused.comparisons, []);
});

test("a capacity trained on the current reset is refused", () => {
  const result = build(rollingFixture(), {
    ...forecast(),
    trainedThrough: instant(1, 2),
  });
  assert.equal(result.status, "not_testable");
  assert.deepEqual(result.refusalCodes, ["forecast_not_strictly_prior"]);
  assert.deepEqual(result.comparisons, []);
});

test("a forecast naming the current reset is refused", () => {
  const input = rollingFixture();
  const evidence = buildResetEvidence(input).resets[0];
  const result = buildRollingQuotaComparisons({
    resetEvidence: evidence,
    capacityForecast: {
      ...forecast(),
      priorResetKeys: ["prior-reset-1", evidence.resetKey],
    },
  });
  assert.equal(result.status, "not_testable");
  assert.deepEqual(result.refusalCodes, ["forecast_includes_current_reset"]);
});

test("rolling comparisons reject open forecast objects", () => {
  assert.throws(
    () => build(rollingFixture(), { ...forecast(), score: {} }),
    /quota_rolling_invalid_input/u,
  );
});
