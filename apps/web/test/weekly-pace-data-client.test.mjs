import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload } from "../public/data-client.js";

function forecast(overrides = {}) {
  return {
    schemaVersion: "local-weekly-pace-forecast-v0.1",
    status: "available",
    currentUsedPercent: 30,
    remainingPercent: 70,
    resetsAt: "2026-08-10T12:00:00.000Z",
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 1,
      elapsedHours: 0.25,
      movementPp: 10,
      percentagePointsPerHour: 40,
    },
    observationCount: 2,
    etaAt: "2026-08-03T14:15:00.000Z",
    hoursToExhaustion: 1.75,
    hoursToReset: 167.5,
    ...overrides,
  };
}

test("weekly browser data boundary retains only the exact safe pace forecast", () => {
  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: forecast() },
  });
  assert.deepEqual(normalized.weekly.paceForecast, forecast());

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
  const normalized = normalizeDashboardPayload({
    weekly: {
      paceForecast: forecast({
        etaAt: "2026-08-11T12:00:00.000Z",
      }),
    },
  });
  assert.equal(normalized.weekly.paceForecast, null);
});

test("weekly browser data boundary retains one clean observation as an explainable waiting state", () => {
  const waiting = forecast({
    status: "insufficient_observations",
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 0,
      elapsedHours: null,
      movementPp: null,
      percentagePointsPerHour: null,
    },
    observationCount: 1,
    etaAt: null,
    hoursToExhaustion: null,
  });
  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: waiting },
  });
  assert.deepEqual(normalized.weekly.paceForecast, waiting);
});
