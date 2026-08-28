import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQuotaPace,
} from "@app-usagemonitor/quota-analysis";
import { QUOTA_PACE_POLICY } from "../packages/quota-analysis/src/quota-pace-forecast.js";

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
  // Evenly spaced points that all moved: the working rate and the wall-clock
  // rate are the same number, so this fixture cannot tell them apart. That is
  // exactly why the divergence needs its own test below.
  assert.equal(expected.pace.activePercentagePointsPerHour, 0.416667);
  assert.equal(expected.pace.overallPercentagePointsPerHour, 0.416667);
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
  // Neither field reports a rate for a window that did not move.
  assert.equal(result.pace.activePercentagePointsPerHour, null);
  assert.equal(result.pace.overallPercentagePointsPerHour, null);
});

test("backward observations fail closed", () => {
  const result = run(
    snapshot("2026-08-03T00:00:00.000Z", 20),
    [snapshot("2026-08-02T00:00:00.000Z", 30)],
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.refusalCodes, ["backward_observation"]);
  assert.equal(result.etaAt, null);
  // Movement is negative here. Neither rate may report that as a pace, or a
  // reader downstream would take -40pp/hour for a real rate instead of the
  // refusal it is.
  assert.equal(result.pace.movementPp, -10);
  assert.equal(result.pace.activePercentagePointsPerHour, null);
  assert.equal(result.pace.overallPercentagePointsPerHour, null);
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
  assert.equal(result.pace.activePercentagePointsPerHour, 0.333333);
  // The ETA is deliberately NOT damped. The median answers "what is a typical
  // working rate", and one spike should not define it. Consumption is a total,
  // and the spike is part of the total: 88pp over 72 hours is 1.222pp/hour, so
  // the 2pp that are left last about an hour and a half, not six.
  assert.equal(result.pace.overallPercentagePointsPerHour, 1.222222);
  assert.equal(result.hoursToExhaustion, 1.636364);
});

test("the ETA follows wall-clock pace, not pace while working", () => {
  // The regression this whole change exists for. Four hours of dense polling
  // in which only one ten-minute interval moved: the working rate is 6pp/hour,
  // the wall-clock rate is 0.25pp/hour, and they disagree about the answer and
  // not merely the number - at the working rate this window is already lost,
  // at the wall-clock rate it comfortably survives.
  const observations = [];
  for (let minute = 0; minute < 240; minute += 10) {
    const at = new Date(Date.parse("2026-08-03T00:00:00.000Z") + minute * 60_000);
    observations.push(snapshot(at.toISOString(), minute < 20 ? 0 : 1));
  }
  const result = run(snapshot("2026-08-03T04:00:00.000Z", 1), observations);

  assert.deepEqual(result.refusalCodes, []);
  assert.equal(result.pace.activePercentagePointsPerHour, 6);
  assert.equal(result.pace.overallPercentagePointsPerHour, 0.25);
  // 99pp left. At the working rate that is 16.5 hours, which would land well
  // inside the 116 hours to reset and publish "available". At the wall-clock
  // rate it is 396 hours, which does not.
  assert.equal(result.hoursToExhaustion, 396);
  assert.equal(result.hoursToReset, 116);
  assert.equal(result.status, "will_reach_reset_first");
  assert.equal(
    result.etaAt,
    new Date(Date.parse("2026-08-03T04:00:00.000Z") + 396 * 3_600_000)
      .toISOString(),
  );
  assert.equal(QUOTA_PACE_POLICY.etaBasis, "overall_percentage_points_per_hour");
});

test("a spiky working rate does not refuse an otherwise sound forecast", () => {
  // Four idle hours then one heavy ten-minute interval: the working rate is
  // 360pp/hour, well past the cap, while the wall-clock rate is a perfectly
  // ordinary 15pp/hour. Under v0.1 the cap applied to the only rate there was
  // and this blanked the card. The ETA no longer rides on that rate, so the
  // forecast stands and the unstateable working rate is reported as null.
  const observations = [];
  for (let minute = 0; minute < 240; minute += 10) {
    const at = new Date(Date.parse("2026-08-03T00:00:00.000Z") + minute * 60_000);
    observations.push(snapshot(at.toISOString(), 0));
  }
  const result = run(snapshot("2026-08-03T04:00:00.000Z", 60), observations);

  assert.deepEqual(result.refusalCodes, []);
  assert.equal(result.status, "available");
  assert.equal(result.pace.activePercentagePointsPerHour, null);
  assert.equal(result.pace.overallPercentagePointsPerHour, 15);
  // 40pp left at 15pp/hour.
  assert.equal(result.hoursToExhaustion, 2.666667);
});

test("an implausible wall-clock rate still refuses, whatever the working rate", () => {
  // 20pp in ten minutes is 120pp/hour by either measure, and no ETA built on
  // it could be trusted.
  const result = run(
    snapshot("2026-08-03T00:10:00.000Z", 50),
    [snapshot("2026-08-03T00:00:00.000Z", 30)],
  );
  assert.deepEqual(result.refusalCodes, ["implausible_pace"]);
  assert.equal(result.pace.overallPercentagePointsPerHour, 120);
  assert.equal(result.etaAt, null);
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
