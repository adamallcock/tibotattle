import test from "node:test";
import assert from "node:assert/strict";
import {
  isExactWeeklyPaceForecast,
  projectWeeklyPaceOutlook,
  WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
} from "../src/weekly-pace-projection.js";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-08-03T12:30:00.000Z");
const RESET_AT = new Date(NOW + 100 * HOUR_MS).toISOString();

function forecast({
  status = "available",
  remainingPercent = 50,
  activeRate = .5,
  overallRate = .5,
  observationCount = 3,
  elapsedHours = 2,
  resetsAt = RESET_AT,
  etaAt = new Date(NOW + HOUR_MS).toISOString(),
} = {}) {
  return {
    schemaVersion: "local-weekly-pace-forecast-v0.2",
    status,
    currentUsedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt,
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: Math.max(0, observationCount - 1),
      elapsedHours,
      movementPp: status === "insufficient_observations"
        ? 0
        : overallRate === null ? null : overallRate * elapsedHours,
      activePercentagePointsPerHour: activeRate,
      overallPercentagePointsPerHour: overallRate,
    },
    observationCount,
    etaAt: status === "available" ? etaAt : null,
    hoursToExhaustion: status === "available" ? 1 : null,
    hoursToReset: 100,
  };
}

function assertExactOutlookKeys(outlook) {
  assert.deepEqual(Object.keys(outlook).sort(), [
    "critical",
    "earlyEstimate",
    "elapsedHours",
    "observationCount",
    "projection",
    "rates",
    "remainingPercent",
    "resetsAt",
    "schemaVersion",
    "standing",
    "status",
    "track",
  ]);
  assert.deepEqual(Object.keys(outlook.rates).sort(), [
    "activePercentagePointsPerHour",
    "headlinePercentagePointsPerHour",
    "overallPercentagePointsPerHour",
    "ratio",
    "sustainablePercentagePointsPerHour",
  ]);
  assert.deepEqual(Object.keys(outlook.projection).sort(), [
    "coveredHours",
    "dryHours",
    "hoursToReset",
    "projectedExhaustionAt",
    "sparePercent",
  ]);
  assert.deepEqual(Object.keys(outlook.track).sort(), [
    "activeExhaustionFraction",
    "coveredFraction",
  ]);
}

test("weekly pace outlook publishes one exact privacy-safe presentation DTO", () => {
  const outlook = projectWeeklyPaceOutlook({
    forecast: forecast({
      remainingPercent: 3,
      activeRate: 11.3,
      overallRate: 11.3,
      observationCount: 4,
      elapsedHours: 2,
    }),
    nowMs: NOW,
  });

  assertExactOutlookKeys(outlook);
  assert.equal(outlook.schemaVersion, WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION);
  assert.equal(outlook.status, "available");
  assert.equal(outlook.standing, "over");
  assert.equal(outlook.critical, true);
  assert.equal(outlook.earlyEstimate, false);
  assert.ok(outlook.projection.coveredHours < .3);
  assert.ok(outlook.projection.dryHours > 99.7);
  assert.equal(outlook.projection.sparePercent, 0);
  assert.equal(
    outlook.projection.projectedExhaustionAt,
    new Date(NOW + outlook.projection.coveredHours * HOUR_MS).toISOString(),
  );
  assert.equal(outlook.track.coveredFraction, (
    outlook.projection.coveredHours / outlook.projection.hoursToReset
  ));

  const serialized = JSON.stringify(outlook);
  assert.doesNotMatch(
    serialized,
    /account|scope|path|credit|redeem|token|provider/iu,
  );
});

test("standing bands and the critical threshold are shared exactly", async (t) => {
  const projectRatio = (ratio) => projectWeeklyPaceOutlook({
    forecast: forecast({
      // 50pp across 100 hours sustains .5pp/hour.
      activeRate: ratio * .5,
      overallRate: ratio * .5,
    }),
    nowMs: NOW,
  });

  await t.test("the 0.85 edge is on pace", () => {
    assert.equal(projectRatio(.849).standing, "under");
    assert.equal(projectRatio(.85).standing, "on");
  });
  await t.test("the 1.15 edge is on pace", () => {
    assert.equal(projectRatio(1.15).standing, "on");
    assert.equal(projectRatio(1.151).standing, "over");
  });
  await t.test("critical starts at exactly twice sustainable pace", () => {
    assert.equal(projectRatio(1.999).critical, false);
    const critical = projectRatio(2);
    assert.equal(critical.standing, "over");
    assert.equal(critical.critical, true);
    assert.equal(critical.projection.coveredHours, 50);
    assert.equal(critical.projection.dryHours, 50);
  });
});

test("outlook carries spare allowance and the active no-pause edge", () => {
  const under = projectWeeklyPaceOutlook({
    forecast: forecast({ activeRate: .2, overallRate: .2 }),
    nowMs: NOW,
  });
  assert.equal(under.standing, "under");
  assert.equal(under.projection.coveredHours, 100);
  assert.equal(under.projection.dryHours, 0);
  assert.equal(under.projection.sparePercent, 30);
  assert.equal(under.track.coveredFraction, 1);
  assert.equal(under.track.activeExhaustionFraction, null);
  assert.equal(under.projection.projectedExhaustionAt, null);

  const activeEdge = projectWeeklyPaceOutlook({
    forecast: forecast({ activeRate: 2, overallRate: .5 }),
    nowMs: NOW,
  });
  assert.equal(activeEdge.standing, "on");
  assert.equal(activeEdge.track.coveredFraction, 1);
  assert.equal(activeEdge.track.activeExhaustionFraction, .25);
});

test("early estimate semantics remain tied to the forecast evidence state", () => {
  const early = projectWeeklyPaceOutlook({
    forecast: forecast({ observationCount: 2, elapsedHours: .5 }),
    nowMs: NOW,
  });
  assert.equal(early.earlyEstimate, true);

  const resetFirst = projectWeeklyPaceOutlook({
    forecast: forecast({
      status: "will_reach_reset_first",
      activeRate: .2,
      overallRate: .2,
      observationCount: 2,
      elapsedHours: .5,
    }),
    nowMs: NOW,
  });
  assert.equal(resetFirst.status, "available");
  assert.equal(resetFirst.standing, "under");
  assert.equal(resetFirst.earlyEstimate, false);
});

test("one clean observation becomes collecting and no evidence is unavailable", () => {
  const collecting = projectWeeklyPaceOutlook({
    forecast: forecast({
      status: "insufficient_observations",
      remainingPercent: 80,
      activeRate: null,
      overallRate: null,
      observationCount: 1,
      elapsedHours: 0,
    }),
    nowMs: NOW,
  });
  assertExactOutlookKeys(collecting);
  assert.equal(collecting.status, "collecting");
  assert.equal(collecting.remainingPercent, 80);
  assert.equal(collecting.observationCount, 1);
  assert.equal(collecting.projection.hoursToReset, 100);
  assert.deepEqual(Object.values(collecting.rates), [null, null, null, null, null]);
  assert.deepEqual(Object.values(collecting.track), [null, null]);

  const unavailable = projectWeeklyPaceOutlook();
  assertExactOutlookKeys(unavailable);
  assert.deepEqual(unavailable, {
    schemaVersion: WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
    status: "unavailable",
    standing: null,
    critical: false,
    earlyEstimate: false,
    remainingPercent: null,
    resetsAt: null,
    observationCount: 0,
    elapsedHours: null,
    rates: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
      headlinePercentagePointsPerHour: null,
      sustainablePercentagePointsPerHour: null,
      ratio: null,
    },
    projection: {
      hoursToReset: null,
      coveredHours: null,
      dryHours: null,
      sparePercent: null,
      projectedExhaustionAt: null,
    },
    track: {
      coveredFraction: null,
      activeExhaustionFraction: null,
    },
  });
});

test("projection fails closed on a malformed, elapsed or contradictory forecast", () => {
  assert.equal(isExactWeeklyPaceForecast(forecast()), true);
  const { currentUsedPercent: _omitted, ...partialForecast } = forecast();
  const collecting = forecast({
    status: "insufficient_observations",
    remainingPercent: 80,
    activeRate: null,
    overallRate: null,
    observationCount: 1,
    elapsedHours: 0,
  });
  const cases = [
    partialForecast,
    { ...forecast(), accountScope: "private" },
    { ...forecast(), observationCount: 4 },
    { ...forecast(), currentUsedPercent: 49 },
    { ...forecast(), pace: { ...forecast().pace, method: null } },
    { ...forecast(), schemaVersion: "local-weekly-pace-forecast-v9" },
    forecast({ resetsAt: new Date(NOW - HOUR_MS).toISOString() }),
    forecast({ status: "unavailable" }),
    forecast({ overallRate: null, activeRate: null }),
    forecast({ elapsedHours: 0 }),
    forecast({ etaAt: new Date(NOW + 101 * HOUR_MS).toISOString() }),
    {
      ...collecting,
      pace: {
        ...collecting.pace,
        elapsedHours: 1,
        movementPp: 2,
        activePercentagePointsPerHour: 2,
        overallPercentagePointsPerHour: 2,
      },
    },
  ];
  for (const malformed of cases) {
    assert.equal(
      projectWeeklyPaceOutlook({ forecast: malformed, nowMs: NOW }).status,
      "unavailable",
    );
  }
});
