import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeDashboardPayload,
  selectAllowancePlanPopulation,
} from "../public/data-client.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

function population(planType, value, comparisonEligibility = "unavailable") {
  return {
    planType,
    status: value === null ? "insufficient_evidence" : "available",
    planAttribution: {
      methodVersion: "plan-era-v1",
      status: "historical_plan_conditional",
      accountVerified: false,
      comparisonEligibility,
    },
    datasets: {
      summary: [{
        plan_type: planType,
        median_weekly_value_usd: value,
        lower_80_across_resets_usd: value === null ? null : value * .8,
        upper_80_across_resets_usd: value === null ? null : value * 1.2,
        qualifying_resets: value === null ? 0 : 3,
      }],
      weekly_values: value === null ? [] : [{
        plan_type: planType,
        plan_variant: "unknown",
        aggregation_eligibility: "primary_conditional",
        last_observed_at: "2026-08-29T12:00:00.000Z",
        first_observed_at: "2026-08-22T12:00:00.000Z",
        reset_due_at: "2026-08-30T12:00:00.000Z",
        displayed_span_pp: 75,
        value_usd: value,
      }],
    },
  };
}

function dashboard({ current = "plus", plus = null, comparison = "unavailable" } = {}) {
  const populations = [population("pro", 2_400, comparison), population("plus", plus, comparison)];
  const selected = populations.find((row) => row.planType === current);
  const data = normalizeDashboardPayload({
    weekly: {
      ...selected,
      selectedPlanType: current,
      planPopulations: populations,
      paceForecast: {
        schemaVersion: "local-weekly-pace-forecast-v0.2",
        status: "available",
        currentUsedPercent: 30,
        remainingPercent: 70,
        resetsAt: "2026-08-10T12:00:00.000Z",
        pace: {
          method: "median_adjacent_quota_slope",
          sampleCount: 1,
          elapsedHours: .25,
          movementPp: 10,
          activePercentagePointsPerHour: 40,
          overallPercentagePointsPerHour: 40,
        },
        observationCount: 2,
        etaAt: "2026-08-03T14:15:00.000Z",
        hoursToExhaustion: 1.75,
        hoursToReset: 167.5,
      },
    },
    quotaWindows: ["pro", "plus"].map((planType) => ({
      planType, limitId: "codex", durationMinutes: 10_080,
      observedAt: "2026-08-30T12:00:00.000Z",
      usedPercent: 30, remainingPercent: 70,
    })),
  });
  // The selector treats the already-normalized comparison as an opaque
  // contract. Detailed capacity/ledger validation has its own boundary tests.
  data.timeline.allowanceCapacity = { status: "available", medianCapacityUsd: 2_400 };
  return data;
}

test("latest-plan selection remains insufficient instead of borrowing the old plan's fit", () => {
  const data = dashboard();
  assert.equal(data.weekly.paceForecast.status, "available",
    "the fixture carries a real non-null forecast, so selection cannot pass by comparing missing values");
  const selected = selectAllowancePlanPopulation(data);
  assert.equal(selected.weekly.planType, "plus");
  assert.equal(selected.weekly.status, "insufficient_evidence");
  assert.equal(selected.weekly.summary.median_weekly_value_usd, null);
  assert.deepEqual(selected.weekly.weeklyValues, []);
  assert.deepEqual(selected.weekly.planPopulations.map((row) => row.planType), ["pro", "plus"]);
  assert.equal(selected.weekly.planPopulations[0].summary.median_weekly_value_usd, 2_400);
  assert.strictEqual(selected.weekly.paceForecast, data.weekly.paceForecast);
  assert.deepEqual(selected.quotaWindows.map((row) => row.planType), ["plus"]);
  assert.equal(selected.timeline.allowanceCapacity, null);
});

test("historical-plan selection changes the fitted population but never current pace or the all-plan ledger", () => {
  const data = dashboard({ plus: 85 });
  const before = structuredClone(data);
  const pro = selectAllowancePlanPopulation(data, "pro");
  assert.equal(pro.weekly.summary.median_weekly_value_usd, 2_400);
  assert.deepEqual(pro.weekly.weeklyValues.map((row) => row.planType), ["pro"]);
  assert.equal(pro.weekly.paceForecast, null);
  assert.deepEqual(pro.quotaWindows, []);
  assert.equal(pro.timeline.allowanceCapacity, null);
  assert.strictEqual(pro.accounting, data.accounting);
  assert.strictEqual(pro.pricing, data.pricing);
  assert.strictEqual(pro.timeline.usage, data.timeline.usage);
  assert.deepEqual(data, before, "selection cannot mutate or discard retained evidence");
  const plus = selectAllowancePlanPopulation(pro, "plus");
  assert.equal(plus.weekly.summary.median_weekly_value_usd, 85);
  assert.strictEqual(plus.weekly.paceForecast, data.weekly.paceForecast);
  assert.strictEqual(selectAllowancePlanPopulation(data, "pro"), pro,
    "stable selected views preserve the chart's identity-based memoization");
});

test("only explicit current single-plan coverage preserves the comparison", () => {
  const covered = dashboard({ current: "pro", plus: 85, comparison: "single_plan_conditional" });
  const selected = selectAllowancePlanPopulation(covered);
  assert.equal(selected.allowancePlanSelection.comparisonAvailable, true);
  assert.strictEqual(selected.timeline.allowanceCapacity, covered.timeline.allowanceCapacity);
  const historical = selectAllowancePlanPopulation(covered, "plus");
  assert.equal(historical.allowancePlanSelection.comparisonAvailable, false);
  assert.equal(historical.timeline.allowanceCapacity, null);
  assert.equal(historical.weekly.paceForecast, null);
  const mixed = selectAllowancePlanPopulation(dashboard({ current: "pro", plus: 85 }));
  assert.equal(mixed.allowancePlanSelection.comparisonAvailable, false);
  assert.equal(mixed.timeline.allowanceCapacity, null);
});

test("unsupported selections cannot create a pooled plan and legacy payloads are unchanged", () => {
  const data = dashboard({ plus: 85 });
  for (const plan of ["all", "private-plan", null, undefined]) {
    assert.equal(selectAllowancePlanPopulation(data, plan).weekly.planType, "plus");
  }
  const legacy = normalizeDashboardPayload({ weekly: { datasets: { summary: [{ median_weekly_value_usd: 75 }] } } });
  assert.strictEqual(selectAllowancePlanPopulation(legacy), legacy);
});

test("population normalization quarantines duplicate plans and strips private era/context columns", () => {
  const pro = population("pro", 2_400);
  const plus = population("plus", 85);
  plus.datasets.weekly_values[0].planEraKey = "private-context-not-for-browser";
  plus.datasets.weekly_values[0].accountScope = "private-context-not-for-browser";
  plus.datasets.weekly_values.push(pro.datasets.weekly_values[0]);
  const data = normalizeDashboardPayload({ weekly: {
    ...plus,
    selectedPlanType: "plus",
    planPopulations: [pro, plus, { ...pro }, population("unsupported-private-plan", 10)],
  } });
  assert.deepEqual(data.weekly.planPopulations.map((row) => row.planType), ["plus"]);
  assert.equal(data.weekly.planPopulations[0].weeklyValues.length, 1);
  assert.equal(data.weekly.planPopulations[0].weeklyValues[0].planVariant, "unknown");
  assert.equal(data.weekly.planPopulations[0].weeklyValues[0].aggregationEligibility, "primary_conditional");
  assert.doesNotMatch(JSON.stringify(data.weekly.planPopulations), /private-context|unsupported-private-plan/u);
});

test("a missing selected population stays unavailable instead of falling back to another plan", () => {
  const data = dashboard();
  data.weekly.planPopulations = data.weekly.planPopulations.filter((row) => row.planType === "pro");
  const selected = selectAllowancePlanPopulation(data);
  assert.equal(selected.weekly.planType, "plus");
  assert.deepEqual(selected.weekly.summary, {});
  assert.deepEqual(selected.weekly.weeklyValues, []);
  assert.equal(selected.timeline.allowanceCapacity, null);
});

test("plan selection and conditional-account copy is present in every dashboard locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "weekly.plan.label", "weekly.plan.aria", "weekly.plan.unknown",
      "weekly.plan.latestOption", "weekly.plan.historyOption",
      "weekly.plan.conditional", "weekly.plan.historicalConditional",
      "weekly.plan.comparisonConditional", "weekly.plan.comparisonPending",
      "weekly.headline.planLabel", "weekly.headline.planRange",
      "share.caveat.planConditional", "share.stat.recordedActivityAllPlans",
      "share.planAllowance",
    ]) {
      const copy = translate(key, { plan: "Plus", lower: "$70", upper: "$90" }, locale);
      assert.ok(copy.length > 0 && copy !== key, `${locale}: ${key}`);
      assert.doesNotMatch(copy, /\{(?:plan|lower|upper)\}/u);
    }
  }
});

test("dynamic plan labels and share transcripts cannot be replaced by static localization placeholders", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /<span id="weekly-estimate-label">/u,
    "renderWeekly owns the selected-plan label and its runtime localization registry");
  assert.match(source, /canvas\.removeAttribute\("data-i18n-aria-label"\);\s*canvas\.setAttribute\("aria-label", shareCardText\(shareCard\)\);/u,
    "a localized redraw keeps the selected-plan transcript, never the initial empty-card placeholder");
  assert.match(source, /const legacyDemo = data\.mode === "demo" && !data\.allowancePlanSelection;/u,
    "even a labelled fixture cannot borrow a global legacy rate for an insufficient selected plan");
});
