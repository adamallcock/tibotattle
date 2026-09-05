import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload, selectAllowancePlanPopulation } from "../public/data-client.js";
import { projectWeeklyPaceOutlook } from "../../../src/weekly-pace-projection.js";

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

function outlook() {
  return projectWeeklyPaceOutlook({ forecast: forecast(), nowMs: Date.parse("2026-08-03T12:30:00.000Z") });
}

test("the browser retains the native pace outlook from the canonical companion producer", () => {
  const available = outlook();
  assert.equal(available.status, "available");
  assert.equal(available.standing, "over");
  const unavailable = projectWeeklyPaceOutlook();
  const collecting = { ...unavailable, status: "collecting", remainingPercent: 70,
    resetsAt: available.resetsAt, observationCount: 1, elapsedHours: 0,
    projection: { ...unavailable.projection, hoursToReset: 167.5 } };
  for (const paceOutlook of [available, collecting, unavailable]) {
    const normalized = normalizeDashboardPayload({ weekly: { paceOutlook } });
    assert.deepEqual(normalized.weekly.paceOutlook, paceOutlook);
    assert.notEqual(normalized.weekly.paceOutlook, paceOutlook);
    assert.notEqual(normalized.weekly.paceOutlook.rates, paceOutlook.rates);
  }
});

test("the outlook boundary rejects private fields and invalid numeric or semantic states", () => {
  const valid = outlook();
  for (const paceOutlook of [
    { ...valid, accountId: "synthetic-private" },
    { ...valid, rates: { ...valid.rates, raw: "synthetic-private" } },
    { ...valid, track: { ...valid.track, coveredFraction: 2 } },
    { ...valid, rates: { ...valid.rates, ratio: Infinity } },
    { ...valid, critical: "true" },
    { ...valid, observationCount: 8_193 },
    { ...valid, status: "collecting" },
    { ...valid, standing: "under", critical: true },
    { ...valid, projection: { ...valid.projection, projectedExhaustionAt: valid.resetsAt } },
    { ...valid, schemaVersion: "future" },
  ]) assert.equal(normalizeDashboardPayload({ weekly: { paceOutlook } }).weekly.paceOutlook, null);
});

test("historical plan selection cannot carry the current account's pace outlook", () => {
  const attribution = { methodVersion: "plan-era-v1", status: "historical_plan_conditional", accountVerified: false };
  const normalized = normalizeDashboardPayload({ weekly: {
    planType: "pro", selectedPlanType: "pro", planAttribution: attribution, paceOutlook: outlook(),
    planPopulations: ["pro", "plus"].map(planType => ({ planType, planAttribution: attribution })),
  } });
  assert.deepEqual(selectAllowancePlanPopulation(normalized, "pro").weekly.paceOutlook, outlook());
  assert.equal(selectAllowancePlanPopulation(normalized, "plus").weekly.paceOutlook, null);
});

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
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
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
