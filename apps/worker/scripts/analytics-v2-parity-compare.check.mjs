// Unit checks for the GCP fast-path parity compare (Q-2). Synthetic,
// content-free inputs only; no database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANALYTICS_V2_PARITY_FAMILIES,
  compareAnalyticsV2Parity,
  normalizeServedDay,
} from "./analytics-v2-parity-compare.mjs";

function servedDay(day, revision, overrides = {}) {
  const releasedAt = `2026-10-0${revision}T12:00:00.000Z`;
  return {
    day,
    revision,
    releasedAt,
    payload: {
      aggregateId: `community-daily:${day}:r${revision}`,
      day,
      revision,
      releasedAt,
      schemaVersion: "community-daily-aggregate-v1.0",
      totals: { usageEvents: 3, quotaObservations: 1 },
      cells: [{ modelId: "synthetic-model", usageEvents: 3 }],
      cellsTruncated: false,
      apiEquivalentSpend: { usageEvents: 3, knownCostUsd: 1.5 },
      ...overrides,
    },
  };
}

function response(days, extra = {}) {
  return {
    schemaVersion: "community-daily-read-v1.0",
    from: "2026-09-29",
    to: "2026-10-01",
    allowanceState: "ready",
    allowanceReadState: "confirmed",
    allowanceBreakdowns: {
      schemaVersion: "community-allowance-breakdowns-v1.1",
      days: [{ day: "2026-09-30", combined: { centralUsd: 10 }, models: [["synthetic-model", 1, 1]] }],
    },
    cacheRetention: {
      schemaVersion: "community-cache-retention-v1.0",
      metric: "cache_retention_by_pause",
      methodVersion: "cache-retention-v2",
      measures: "consecutive_requests",
      gapBasis: "response_end_to_response_end",
      windows: [{ window: "day", days: 1, bands: [{ band: "under_one_minute", startMs: 0, endMs: 60_000, sessions: 2 }] }],
    },
    days,
    ...extra,
  };
}

const preview = { schemaVersion: "admin-community-allowance-preview-v0.3", models: { days: [{ day: "2026-09-30", values: [] }] } };

test("only the publication-schedule fields are normalized", () => {
  assert.deepEqual(normalizeServedDay(servedDay("2026-09-30", 4)), normalizeServedDay(servedDay("2026-09-30", 1)));
  const normalized = normalizeServedDay(servedDay("2026-09-30", 3));
  assert.equal(normalized.payload.aggregateId, "community-daily:2026-09-30");
  assert.equal(Object.hasOwn(normalized, "revision"), false);
  assert.equal(Object.hasOwn(normalized.payload, "releasedAt"), false);
  assert.equal(normalized.payload.day, "2026-09-30", "the day itself is never normalized");
});

test("identical outputs at different revisions compare equal in every family", () => {
  const report = compareAnalyticsV2Parity({
    golden: response([servedDay("2026-09-30", 7)]),
    actual: response([servedDay("2026-09-30", 1)]),
    goldenPreview: preview,
    actualPreview: structuredClone(preview),
  });
  assert.equal(report.unexpectedDiffs, 0);
  assert.deepEqual(report.families.map((family) => family.family), [...ANALYTICS_V2_PARITY_FAMILIES]);
  assert.ok(report.families.every((family) => family.diffCount === 0));
});

test("each family reports its own differences, and only cache counts are expected", () => {
  const golden = response([servedDay("2026-09-29", 1), servedDay("2026-09-30", 1)]);
  const actual = response([servedDay("2026-09-30", 1, {
    totals: { usageEvents: 4, quotaObservations: 1 },
    apiEquivalentSpend: { usageEvents: 3, knownCostUsd: 1.6 },
  })]);
  actual.allowanceBreakdowns.days[0].models = [];
  actual.cacheRetention.windows[0].bands[0].sessions = 3;
  const report = compareAnalyticsV2Parity({ golden, actual, goldenPreview: preview, actualPreview: preview });
  const byFamily = Object.fromEntries(report.families.map((family) => [family.family, family]));
  assert.deepEqual(report.days.missingInActual, ["2026-09-29"]);
  assert.equal(byFamily["daily-days"].diffCount > 0, true);
  assert.equal(byFamily["daily-totals"].diffCount, 1);
  assert.equal(byFamily["daily-totals"].diffs[0].path, "$.days[2026-09-30].payload.totals.usageEvents");
  assert.equal(byFamily.spend.diffCount, 1);
  assert.equal(byFamily["daily-cells"].diffCount, 0);
  assert.equal(byFamily["model-days"].diffCount, 1);
  assert.equal(byFamily["cache-structure"].diffCount, 0);
  assert.equal(byFamily["cache-counts"].diffCount, 1);
  assert.equal(byFamily["cache-counts"].expected, true);
  assert.deepEqual(report.unexpectedFamilies, ["daily-days", "daily-totals", "spend", "model-days"]);
  assert.equal(report.unexpectedDiffs,
    byFamily["daily-days"].diffCount + byFamily["daily-totals"].diffCount + byFamily.spend.diffCount
    + byFamily["model-days"].diffCount);
});

test("a changed cache band id is a structure difference, not an expected count difference", () => {
  const actual = response([]);
  actual.cacheRetention.windows[0].bands[0].band = "one_to_two_minutes";
  const report = compareAnalyticsV2Parity({ golden: response([]), actual });
  assert.deepEqual(report.unexpectedFamilies, ["cache-structure"]);
});
