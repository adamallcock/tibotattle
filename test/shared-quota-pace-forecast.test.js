import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQuotaPace,
  QUOTA_PACE_POLICY,
} from "@app-usagemonitor/quota-analysis";

const RESET = "2026-08-08T00:00:00.000Z";
const TRACK = {
  accountTrackId: "account-track:test",
  provider: "openai_codex",
  planType: "pro",
  planVariant: "current",
  limitId: "codex",
  slot: "primary",
  windowDurationMinutes: 10080,
  resetsAt: RESET,
  policyEpoch: "quota-v1",
};

function snapshot(observedAt, usedPercent, overrides = {}) {
  return {
    ...TRACK,
    observedAt,
    receivedAt: observedAt,
    usedPercent,
    ...overrides,
  };
}

function run(current, observations) {
  return analyzeQuotaPace({ currentSnapshot: current, observations });
}

test("pace is order-independent and returns an ETA when it beats reset", () => {
  const current = snapshot("2026-08-03T00:00:00.000Z", 80);
  const observations = [
    snapshot("2026-08-01T00:00:00.000Z", 60),
    snapshot("2026-08-02T00:00:00.000Z", 70),
  ];
  const expected = run(current, observations);
  const reversed = run(current, [...observations].reverse());
  assert.deepEqual(reversed, expected);
  assert.equal(expected.status, "available");
  assert.deepEqual(expected.refusalCodes, []);
  assert.equal(expected.pace.method, "median_adjacent_quota_slope");
  assert.equal(expected.pace.sampleCount, 2);
  assert.equal(expected.pace.percentagePointsPerHour, 0.416667);
  assert.equal(expected.hoursToExhaustion, 48);
  assert.equal(expected.etaAt, "2026-08-05T00:00:00.000Z");
  assert.equal(expected.hoursToReset, 120);
});

test("pace accepts a 43,200-minute provider-reported window with the same calculation", () => {
  const weekly = run(
    snapshot("2026-08-03T00:00:00.000Z", 80),
    [
      snapshot("2026-08-01T00:00:00.000Z", 60),
      snapshot("2026-08-02T00:00:00.000Z", 70),
    ],
  );
  const thirtyDay = run(
    snapshot("2026-08-03T00:00:00.000Z", 80, {
      windowDurationMinutes: 43_200,
    }),
    [
      snapshot("2026-08-01T00:00:00.000Z", 60, {
        windowDurationMinutes: 43_200,
      }),
      snapshot("2026-08-02T00:00:00.000Z", 70, {
        windowDurationMinutes: 43_200,
      }),
    ],
  );
  assert.deepEqual(
    { ...thirtyDay, windowDurationMinutes: 10_080 },
    weekly,
  );
  assert.equal(thirtyDay.windowDurationMinutes, 43_200);
});

test("the generic pace validator still admits the five-hour window", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 40, {
      windowDurationMinutes: 300,
    }),
    [],
  );
  assert.equal(result.status, "insufficient_observations");
  assert.equal(result.windowDurationMinutes, 300);
  assert.equal(QUOTA_PACE_POLICY.windowDurationMinutes, 10_080);
});

test("zero movement is unavailable rather than an infinite ETA", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 20),
    [snapshot("2026-08-02T00:00:00.000Z", 20)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["non_positive_pace"]);
  assert.equal(result.etaAt, null);
  assert.equal(result.hoursToExhaustion, null);
  assert.equal(result.pace.percentagePointsPerHour, null);
});

test("backward observations fail closed", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 20),
    [snapshot("2026-08-02T00:00:00.000Z", 30)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["backward_observation"]);
  assert.equal(result.etaAt, null);
});

test("a noisy positive spike is damped by the median adjacent slope", () => {
  const result = run(
    snapshot("2026-08-04T00:00:00.000Z", 98),
    [
      snapshot("2026-08-01T00:00:00.000Z", 10),
      snapshot("2026-08-02T00:00:00.000Z", 11),
      snapshot("2026-08-03T00:00:00.000Z", 90),
    ],
  );
  assert.equal(result.status, "available");
  assert.equal(result.pace.percentagePointsPerHour, 0.333333);
  assert.equal(result.hoursToExhaustion, 6);
});

test("stale observations are excluded and refuse the forecast", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 40),
    [
      snapshot("2026-08-02T00:00:00.000Z", 30, {
        receivedAt: "2026-08-02T00:06:00.000Z",
      }),
      snapshot("2026-08-01T00:00:00.000Z", 20),
    ],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["stale_observation"]);
  assert.equal(result.etaAt, null);
});

test("incompatible track observations cannot contaminate the ETA", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 40),
    [
      snapshot("2026-08-02T00:00:00.000Z", 30),
      snapshot("2026-08-01T00:00:00.000Z", 20, { provider: "other" }),
    ],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["incompatible_observation"]);
  assert.equal(result.etaAt, null);
});

test("one point cannot establish a pace", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 40),
    [],
  );
  assert.equal(result.status, "insufficient_observations");
  assert.deepEqual(result.refusalCodes, ["insufficient_observations"]);
  assert.equal(result.pace.sampleCount, 0);
  assert.equal(result.etaAt, null);
});

test("the reset boundary is explicit when exhaustion comes later", () => {
  const current = snapshot("2026-08-03T00:00:00.000Z", 50);
  const resetFirst = run(current, [snapshot("2026-08-02T00:00:00.000Z", 40)]);
  assert.equal(resetFirst.status, "will_reach_reset_first");
  assert.equal(resetFirst.hoursToExhaustion, 120);
  assert.equal(resetFirst.hoursToReset, 120);
  assert.equal(resetFirst.etaAt, "2026-08-08T00:00:00.000Z");

  const beforeReset = run(
    snapshot("2026-08-03T00:00:00.000Z", 90),
    [snapshot("2026-08-02T00:00:00.000Z", 80)],
  );
  assert.equal(beforeReset.status, "available");
  assert.equal(beforeReset.hoursToExhaustion, 24);
});

test("a current observation at the reset boundary is unavailable", () => {
  const result = run(
    snapshot(RESET, 100),
    [snapshot("2026-08-07T00:00:00.000Z", 90)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["reset_elapsed"]);
  assert.equal(result.hoursToReset, 0);
  assert.equal(result.etaAt, null);
});

test("an implausible percentage slope produces no ETA", () => {
  const result = run(
    snapshot("2026-08-03T00:10:00.000Z", 50),
    [snapshot("2026-08-03T00:00:00.000Z", 30)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["implausible_pace"]);
  assert.equal(result.etaAt, null);
  assert.equal(QUOTA_PACE_POLICY.maximumPacePpPerHour, 100);
});

test("a tiny positive slope that overflows its ETA fails closed", () => {
  const result = run(
    snapshot("2026-08-03T01:00:00.000Z", Number.MIN_VALUE),
    [snapshot("2026-08-03T00:00:00.000Z", 0)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["implausible_pace"]);
  assert.equal(result.etaAt, null);
  assert.equal(result.hoursToExhaustion, null);
});

test("malformed and invalid-duration inputs fail closed with a stable error", () => {
  assert.throws(
    () => analyzeQuotaPace({
      currentSnapshot: snapshot("2026-08-03T00:00:00.000Z", 40),
      observations: {},
    }),
    /quota_pace_invalid_input/u,
  );
  for (const duration of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, 525_601]) {
    assert.throws(
      () => analyzeQuotaPace({
        currentSnapshot: {
          ...snapshot("2026-08-03T00:00:00.000Z", 40),
          windowDurationMinutes: duration,
        },
        observations: [],
      }),
      /quota_pace_invalid_input/u,
      String(duration),
    );
  }
});
