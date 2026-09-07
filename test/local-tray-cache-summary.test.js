import test from "node:test";
import assert from "node:assert/strict";
import { projectTrayCacheSummary } from "../src/local-companion-data.js";
import { normalizeTrayCacheSummary, normalizeDashboardPayload } from "../apps/web/public/data-client.js";

const period = (periodId, comparableReturns, reusedMoreThanHalfReturns, coverageStatus = "complete") => ({
  periodId, comparableReturns, reusedMoreThanHalfReturns,
  reusedHalfOrLessReturns: comparableReturns - reusedMoreThanHalfReturns, coverageStatus,
});
const impact = (...periods) => ({ status: "available", periods });

test("tray cache summary preserves the dashboard follow-up denominator and partial coverage", () => {
  const summary = projectTrayCacheSummary(impact(period("30d", 80, 60, "incomplete"), period("7d", 10, 9)));
  assert.deepEqual(summary.periods.map(({ periodId, reusePercent, coverageStatus }) => ({periodId, reusePercent, coverageStatus})), [
    { periodId: "7d", reusePercent: 90, coverageStatus: "complete" },
    { periodId: "30d", reusePercent: 75, coverageStatus: "incomplete" },
  ]);
  assert.deepEqual(normalizeTrayCacheSummary(summary), summary);
  const dashboard = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: { trayCacheSummary: summary } });
  assert.deepEqual(dashboard.accounting.trayCacheSummary, summary);
});

test("no comparable follow-ups differs from observed zero reuse and unavailable evidence", () => {
  const summary = projectTrayCacheSummary(impact(period("7d", 0, 0), period("30d", 3, 0)));
  assert.equal(summary.periods[0].status, "available");
  assert.equal(summary.periods[0].reusePercent, null);
  assert.equal(summary.periods[1].reusePercent, 0);
  assert.deepEqual(normalizeTrayCacheSummary(summary), summary);
  for (const input of [null, {}, { status: "unavailable", periods: [period("7d", 2, 1)] }]) {
    const result = projectTrayCacheSummary(input);
    assert.ok(result.periods.every(row => row.status === "unavailable" && row.reusePercent === null));
  }
});

test("ambiguous or malformed windows never borrow the other period's result", () => {
  for (const bad of [
    { ...period("7d", 4, 3), comparableReturns: "4" },
    { ...period("7d", 4, 3), comparableReturns: -1 },
    { ...period("7d", 4, 3), reusedMoreThanHalfReturns: 6 },
    { ...period("7d", 4, 3), reusedHalfOrLessReturns: 2 },
    { ...period("7d", 4, 3), coverageStatus: "unknown" },
  ]) {
    const result = projectTrayCacheSummary(impact(bad, period("30d", 10, 5)));
    assert.equal(result.periods[0].status, "unavailable");
    assert.equal(result.periods[1].reusePercent, 50);
  }
  const duplicate = projectTrayCacheSummary(impact(period("7d", 4, 3), period("7d", 4, 3), period("30d", 10, 5)));
  assert.equal(duplicate.periods[0].status, "unavailable");
  assert.equal(duplicate.periods[1].reusePercent, 50);
});

test("browser boundary rejects forged percentages, future schemas and extra fields", () => {
  const valid = projectTrayCacheSummary(impact(period("7d", 4, 3), period("30d", 10, 5)));
  for (const bad of [
    { ...valid, schemaVersion: 2 }, { ...valid, unexpected: "private" },
    { ...valid, periods: [valid.periods[0], valid.periods[0]] },
  ]) assert.ok(normalizeTrayCacheSummary(bad).periods.every(row => row.status === "unavailable"));
  for (const patch of [
    { reusePercent: 74 }, { reusePercent: "75" }, { reusePercent: NaN },
    { comparableReturns: 0 }, { unexpected: "private" }, { reusedMoreThanHalfReturns: -1 },
  ]) {
    const result = normalizeTrayCacheSummary({ ...valid, periods: [{ ...valid.periods[0], ...patch }, valid.periods[1]] });
    assert.equal(result.periods[0].status, "unavailable");
    assert.equal(result.periods[1].reusePercent, 50);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});
