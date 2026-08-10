import assert from "node:assert/strict";
import test from "node:test";

import {
  FIVE_HOUR_WINDOW_MINUTES,
  formatQuotaWindowDuration,
  isSupportedQuotaWindowDuration,
  isValidQuotaWindowDuration,
  MAX_QUOTA_WINDOW_DURATION_MINUTES,
  quotaWindowLabel,
  selectPrimaryQuotaWindow,
  SEVEN_DAY_WINDOW_MINUTES,
  SUPPORTED_QUOTA_WINDOW_DURATIONS,
} from "../src/quota-windows.js";
import { fitResetCapacity } from "../src/quota-calibration.js";
import { analyzeQuotaPace, QUOTA_PACE_POLICY } from "../src/quota-pace-forecast.js";
import { buildRollingQuotaComparisons } from "../src/quota-rolling.js";
import { buildResetEvidence } from "../src/quota-tracks.js";

function opaqueId(kind, value) {
  return `${kind}:v1:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function instant(hour, minute = 0) {
  return new Date(Date.UTC(2026, 7, 5, hour, minute)).toISOString();
}

function quotaFixture(windowDurationMinutes = 43_200) {
  const datasetId = opaqueId("dataset", 1);
  const accountTrackId = opaqueId("account-track", 1);
  const quotaSnapshots = Array.from({ length: 8 }, (_, index) => ({
    snapshotId: opaqueId("snapshot", index + 1),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    slot: "primary",
    windowDurationMinutes,
    resetsAt: instant(12),
    observedAt: instant(index),
    receivedAt: instant(index),
    usedPercent: index,
    displayPrecision: 0,
    policyEpoch: "quota-v1",
  }));
  const usageEvents = Array.from({ length: 7 }, (_, index) => ({
    eventId: opaqueId("event", index + 1),
    datasetId,
    accountTrackId,
    provider: "openai",
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    observedAt: instant(index, 30),
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

function paceSnapshot(observedAt, usedPercent) {
  return {
    accountTrackId: "account-track:test",
    provider: "openai_codex",
    planType: "pro",
    planVariant: "current",
    limitId: "codex",
    slot: "primary",
    windowDurationMinutes: 43_200,
    resetsAt: "2026-08-08T00:00:00.000Z",
    observedAt,
    receivedAt: observedAt,
    usedPercent,
    policyEpoch: "quota-v1",
  };
}

test("named windows remain available while supported validation admits bounded provider windows", () => {
  assert.equal(FIVE_HOUR_WINDOW_MINUTES, 300);
  assert.equal(SEVEN_DAY_WINDOW_MINUTES, 10_080);
  assert.deepEqual(
    SUPPORTED_QUOTA_WINDOW_DURATIONS,
    [FIVE_HOUR_WINDOW_MINUTES, SEVEN_DAY_WINDOW_MINUTES],
  );

  for (const duration of [1, 300, 10_080, 43_200, MAX_QUOTA_WINDOW_DURATION_MINUTES]) {
    assert.equal(isValidQuotaWindowDuration(duration), true, String(duration));
    assert.equal(isSupportedQuotaWindowDuration(duration), true, String(duration));
  }
  for (const duration of [0, -1, 1.5, 525_601, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isValidQuotaWindowDuration(duration), false, String(duration));
    assert.equal(isSupportedQuotaWindowDuration(duration), false, String(duration));
  }
});

test("tracks, calibration, and rolling comparisons preserve a generic duration", () => {
  const evidence = buildResetEvidence(quotaFixture()).resets[0];
  assert.equal(evidence.windowDurationMinutes, 43_200);

  const calibration = fitResetCapacity(evidence);
  assert.equal(calibration.windowDurationMinutes, 43_200);

  const rolling = buildRollingQuotaComparisons({
    resetEvidence: evidence,
    capacityForecast: {
      method: "median_of_prior_completed_resets",
      priorResetCount: 2,
      priorResetKeys: ["prior-reset-1", "prior-reset-2"],
      trainedThrough: "2026-08-04T23:00:00.000Z",
      capacityNanousd: 600_000_000_000,
    },
  });
  assert.equal(rolling.windowDurationMinutes, 43_200);
});

test("pace inputs retain generic duration while the weekly policy stays seven-day", () => {
  const result = analyzeQuotaPace({
    currentSnapshot: paceSnapshot("2026-08-03T00:00:00.000Z", 80),
    observations: [
      paceSnapshot("2026-08-01T00:00:00.000Z", 60),
      paceSnapshot("2026-08-02T00:00:00.000Z", 70),
    ],
  });
  assert.equal(result.windowDurationMinutes, 43_200);
  assert.equal(QUOTA_PACE_POLICY.windowDurationMinutes, SEVEN_DAY_WINDOW_MINUTES);
});

test("primary selection and labels preserve named semantics for provider windows", () => {
  const windows = [
    { id: "five-hour", limitId: "codex", slot: "primary", windowDurationMinutes: 300 },
    { id: "weekly", limitId: "codex", slot: "secondary", windowDurationMinutes: 10_080 },
    { id: "provider-30-day", limitId: "codex", slot: "primary", windowDurationMinutes: 43_200 },
    { id: "spark", limitId: "codex_bengalfox", slot: "primary", windowDurationMinutes: 525_600 },
  ];

  assert.equal(selectPrimaryQuotaWindow(windows)?.id, "provider-30-day");
  assert.equal(
    selectPrimaryQuotaWindow([
      { id: "secondary", limitId: "codex", slot: "secondary", windowDurationMinutes: 43_200 },
      { id: "primary", limitId: "codex", slot: "primary", windowDurationMinutes: 43_200 },
    ])?.id,
    "primary",
  );
  assert.equal(formatQuotaWindowDuration(43_200), "30-day");
  assert.equal(quotaWindowLabel("codex", 300), "Five-hour allowance");
  assert.equal(quotaWindowLabel("codex", 10_080), "Seven-day allowance");
  assert.equal(quotaWindowLabel("codex", 43_200), "Provider-reported 30-day window");
  assert.doesNotMatch(quotaWindowLabel("codex", 43_200), /month/iu);
  assert.equal(formatQuotaWindowDuration(0), null);
  assert.equal(quotaWindowLabel("codex", 0), "Unknown quota window");
  assert.equal(selectPrimaryQuotaWindow(null), null);
});
