import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload } from "../public/data-client.js";

function forecast(overrides = {}) {
  return {
    schemaVersion: "local-weekly-pace-forecast-v0.2",
    status: "available",
    currentUsedPercent: 30,
    remainingPercent: 70,
    resetsAt: "2026-08-10T12:00:00.000Z",
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 1,
      elapsedHours: 0.25,
      movementPp: 10,
      activePercentagePointsPerHour: 40,
      overallPercentagePointsPerHour: 40,
    },
    observationCount: 2,
    etaAt: "2026-08-03T14:15:00.000Z",
    hoursToExhaustion: 1.75,
    hoursToReset: 167.5,
    ...overrides,
  };
}

function outlook(overrides = {}) {
  const {
    rates: rateOverrides = {},
    projection: projectionOverrides = {},
    track: trackOverrides = {},
    ...rootOverrides
  } = overrides;
  return {
    schemaVersion: "local-weekly-pace-outlook-v0.1",
    status: "available",
    standing: "over",
    critical: true,
    earlyEstimate: true,
    remainingPercent: 70,
    resetsAt: "2026-08-10T12:00:00.000Z",
    observationCount: 2,
    elapsedHours: .25,
    rates: {
      activePercentagePointsPerHour: 40,
      overallPercentagePointsPerHour: 40,
      headlinePercentagePointsPerHour: 40,
      sustainablePercentagePointsPerHour: 70 / 167.5,
      ratio: 40 / (70 / 167.5),
      ...rateOverrides,
    },
    projection: {
      hoursToReset: 167.5,
      coveredHours: 1.75,
      dryHours: 165.75,
      sparePercent: 0,
      projectedExhaustionAt: "2026-08-03T14:15:00.000Z",
      ...projectionOverrides,
    },
    track: {
      coveredFraction: 1.75 / 167.5,
      activeExhaustionFraction: null,
      ...trackOverrides,
    },
    ...rootOverrides,
  };
}

function collectingForecast(overrides = {}) {
  return forecast({
    status: "insufficient_observations",
    currentUsedPercent: 20,
    remainingPercent: 80,
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 0,
      elapsedHours: 0,
      movementPp: 0,
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
    },
    observationCount: 1,
    etaAt: null,
    hoursToExhaustion: null,
    ...overrides,
  });
}

test("weekly browser data boundary retains only the exact safe pace forecast", () => {
  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: forecast() },
  });
  assert.deepEqual(normalized.weekly.paceForecast, forecast());
  assert.equal(normalized.weekly.paceOutlook, undefined);

  const rejected = normalizeDashboardPayload({
    weekly: {
      paceForecast: {
        ...forecast(),
        accountScope: "openai-account:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  });
  assert.equal(rejected.weekly.paceForecast, null);
});

test("weekly browser data boundary hides contradictory pace forecasts", () => {
  const contradictory = [
    forecast({
        etaAt: "2026-08-11T12:00:00.000Z",
    }),
    forecast({
      pace: {
        ...forecast().pace,
        sampleCount: 0,
      },
    }),
    forecast({ currentUsedPercent: 31 }),
    {
      ...forecast(),
      status: "unavailable",
      etaAt: null,
      hoursToExhaustion: null,
    },
    collectingForecast({
      pace: {
        ...collectingForecast().pace,
        elapsedHours: 1,
        movementPp: 2,
        activePercentagePointsPerHour: 2,
        overallPercentagePointsPerHour: 2,
      },
    }),
  ];
  for (const paceForecast of contradictory) {
    const normalized = normalizeDashboardPayload({
      weekly: { paceForecast, paceOutlook: outlook() },
    });
    assert.equal(normalized.weekly.paceForecast, null);
    assert.equal(normalized.weekly.paceOutlook, null);
  }
});

test("weekly browser data boundary retains one clean observation as an explainable waiting state", () => {
  const waiting = collectingForecast();
  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: waiting },
  });
  assert.deepEqual(normalized.weekly.paceForecast, waiting);
});

test("weekly browser boundary retains the exact shared outlook beside its forecast", () => {
  const normalized = normalizeDashboardPayload({
    weekly: {
      paceForecast: forecast(),
      paceOutlook: outlook(),
    },
  });
  assert.deepEqual(normalized.weekly.paceForecast, forecast());
  assert.deepEqual(normalized.weekly.paceOutlook, outlook());
});

test("weekly browser boundary rejects privacy-expanding or inexact outlook shapes", () => {
  const privateShape = {
    ...outlook(),
    accountScope: "openai-account:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const nestedPrivateShape = outlook({
    track: {
      path: "/Users/example/.codex",
    },
  });
  for (const paceOutlook of [privateShape, nestedPrivateShape]) {
    const normalized = normalizeDashboardPayload({
      weekly: { paceForecast: forecast(), paceOutlook },
    });
    assert.deepEqual(normalized.weekly.paceForecast, forecast());
    assert.equal(normalized.weekly.paceOutlook, null);
  }
});

test("weekly browser boundary verifies outlook standing and geometry", () => {
  const malformed = [
    outlook({ standing: "under" }),
    outlook({ elapsedHours: 0 }),
    outlook({ track: { coveredFraction: .5 } }),
    outlook({ rates: { activePercentagePointsPerHour: 0 } }),
    outlook({
      projection: {
        projectedExhaustionAt: "2026-08-03T14:15:00.002Z",
      },
    }),
  ];
  for (const paceOutlook of malformed) {
    const normalized = normalizeDashboardPayload({
      weekly: { paceForecast: forecast(), paceOutlook },
    });
    assert.equal(normalized.weekly.paceOutlook, null);
  }
});

test("weekly browser boundary binds outlook evidence to its sibling forecast", () => {
  const divergent = [
    outlook({ earlyEstimate: false }),
    outlook({
      remainingPercent: 69,
      rates: {
        sustainablePercentagePointsPerHour: 69 / 167.5,
        ratio: 40 / (69 / 167.5),
      },
      projection: {
        coveredHours: 1.725,
        dryHours: 165.775,
        projectedExhaustionAt: "2026-08-03T14:13:30.000Z",
      },
      track: { coveredFraction: 1.725 / 167.5 },
    }),
    outlook({
      resetsAt: "2026-08-10T13:00:00.000Z",
      projection: {
        projectedExhaustionAt: "2026-08-03T15:15:00.000Z",
      },
    }),
    outlook({ observationCount: 3 }),
    outlook({ elapsedHours: 2 }),
  ];
  for (const paceOutlook of divergent) {
    const normalized = normalizeDashboardPayload({
      weekly: { paceForecast: forecast(), paceOutlook },
    });
    assert.deepEqual(normalized.weekly.paceForecast, forecast());
    assert.equal(normalized.weekly.paceOutlook, null);
  }
});

test("weekly browser boundary accepts collecting and unavailable outlook states", () => {
  const collecting = outlook({
    status: "collecting",
    standing: null,
    critical: false,
    earlyEstimate: false,
    remainingPercent: 80,
    observationCount: 1,
    elapsedHours: 0,
    rates: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
      headlinePercentagePointsPerHour: null,
      sustainablePercentagePointsPerHour: null,
      ratio: null,
    },
    projection: {
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
  const unavailable = outlook({
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
  const collectingNormalized = normalizeDashboardPayload({
    weekly: {
      paceForecast: collectingForecast(),
      paceOutlook: collecting,
    },
  });
  assert.deepEqual(collectingNormalized.weekly.paceOutlook, collecting);
  const unavailableNormalized = normalizeDashboardPayload({
    weekly: { paceOutlook: unavailable },
  });
  assert.deepEqual(unavailableNormalized.weekly.paceOutlook, unavailable);
});
