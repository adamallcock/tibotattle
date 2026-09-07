import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeDashboardPayload,
  selectAllowancePlanPopulation,
} from "../public/data-client.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const BASIS_FAMILY =
  "codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30:event_time:observed_declared_scenario";
const COHORT_ID = "a".repeat(64);

function planScope(planType) {
  return {
    methodVersion: "plan-era-v1",
    planType,
    basisFamilyId: BASIS_FAMILY,
    cohortId: COHORT_ID,
    sourceGeneration: 17,
    sourceGenerationFingerprint: "generation-fingerprint-17",
  };
}

function capacityScenario(scenario) {
  return {
    basisId: `${BASIS_FAMILY}:${scenario}`,
    medianCapacityUsd: 2_400,
    plausibleRangeUsd: { lower: 2_000, upper: 2_800 },
    qualifyingResets: 3,
    cohortId: COHORT_ID,
    validation: {
      sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 1,
      priorResetMeanAbsoluteErrorPercentagePoints: 2,
      priorResetAbsoluteBiasPercentagePoints: 0,
      forecastErrorP80PercentagePoints: 3,
      scoredPriorResets: 2,
      scoredPriorPoints: 8,
    },
  };
}

function allowanceCapacity(planType) {
  return {
    status: "available",
    reason: null,
    basisFamilyId: BASIS_FAMILY,
    selectedScenario: "unresolved_as_standard",
    scenarios: {
      unresolved_as_standard: capacityScenario("unresolved_as_standard"),
      unresolved_as_fast: capacityScenario("unresolved_as_fast"),
    },
    planScope: planScope(planType),
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true,
    },
  };
}

function usageRow({ events = 1, standardUsd = 4, fastUsd = 8 } = {}) {
  return {
    startAt: "2026-08-30T11:45:00.000Z",
    endAt: "2026-08-30T12:00:00.000Z",
    usageEvents: events,
    totalTokens: 1_000,
    apiPriceEquivalentUsd: standardUsd,
    components: { input_uncached_tokens: 1_000 },
    pricingCoverage: {
      fullyPricedEvents: events,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    allowanceWeighting: [
      0, standardUsd, standardUsd, 0, 0, events, 0, 0,
      0, fastUsd, fastUsd, 0, 0, events, 0, 0,
    ],
  };
}

function compactPlanRow(row) {
  return [Date.parse(row.startAt), row.usageEvents,
    ...["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens",
      "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"].map((key) => row.components[key] ?? 0),
    row.apiPriceEquivalentUsd, row.allowanceWeighting[1], row.allowanceWeighting[9],
    row.allowanceWeighting[3], row.allowanceWeighting[4], row.pricingCoverage.fullyPricedEvents,
    row.pricingCoverage.partiallyPricedEvents, row.totalTokens];
}

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

function dashboard({ current = "plus", plus = null, comparison = "unavailable",
  scopedRows = [usageRow()], scopedIntervals = [[Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z")]],
} = {}) {
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
    timeline: {
      allowanceWeightingEncoding: {
        schemaVersion: "quota-weighted-timeline-v0.1",
        basisFamilyId: BASIS_FAMILY,
        scenarioOrder: ["unresolved_as_standard", "unresolved_as_fast"],
        selectedScenario: "unresolved_as_standard",
      },
      usage: [usageRow({ events: 2, standardUsd: 10, fastUsd: 20 })],
      calibrationUsage: [],
      allowanceCapacity: allowanceCapacity(current),
      planScoped: {
        schemaVersion: "local-plan-scoped-accounting-timeline-v1",
        encoding: "plan_bucket_v1",
        status: "available",
        reason: null,
        planScope: planScope(current),
        usage: scopedRows.map(compactPlanRow),
        comparisonIntervals: scopedIntervals,
        quota: [[Date.parse("2026-08-30T11:45:00.000Z"), Date.parse("2026-09-01T00:00:00.000Z") / 1000, 30]],
      },
      quota: [],
    },
  });
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
  assert.deepEqual(selected.timeline.selectedPlanUsage, []);
  assert.equal(selected.timeline.usage[0].usageEvents, 2,
    "the all-plan ledger remains conserved while the sparse current plan is unavailable");
});

test("selected quota is independent of generic cross-plan collapse and all-plan data stays intact", () => {
  const data = dashboard({ current: "pro", plus: 85 });
  data.timeline.quota = [{ ...data.timeline.planScoped.quota[0], planType: "plus", usedPercent: 90 }];
  const selected = selectAllowancePlanPopulation(data);
  assert.deepEqual(selected.timeline.quota.map((row) => [row.planType, row.usedPercent]), [["pro", 30]]);
  assert.deepEqual(data.timeline.quota.map((row) => [row.planType, row.usedPercent]), [["plus", 90]]);
});

test("valid scoped history beyond 3000 buckets is retained, not rejected or truncated", () => {
  const start = Date.parse("2026-07-01T00:00:00Z");
  const rows = Array.from({ length: 4_000 }, (_, i) => ({ ...usageRow(),
    startAt: new Date(start + i * 900_000).toISOString(),
    endAt: new Date(start + (i + 1) * 900_000).toISOString() }));
  const data = dashboard({ current: "pro", plus: 85, scopedRows: rows });
  const selected = selectAllowancePlanPopulation(data);
  assert.equal(selected.allowancePlanSelection.comparisonAvailable, true);
  assert.equal(selected.timeline.selectedPlanUsage.length, 4_000);
  assert.equal(selected.timeline.selectedPlanUsage[0].startAt, rows[0].startAt);
  assert.equal(selected.timeline.selectedPlanUsage.at(-1).endAt, rows.at(-1).endAt);
});

test("a scoped bucket crossing an attribution gap fails closed", () => {
  const start = Date.parse(usageRow().startAt);
  const data = dashboard({ current: "pro", plus: 85, scopedIntervals: [[start - 900_000, start]] });
  assert.equal(data.timeline.planScoped.status, "unavailable");
  assert.equal(selectAllowancePlanPopulation(data).allowancePlanSelection.comparisonAvailable, false);
  assert.equal(data.timeline.usage[0].usageEvents, 2);
});

test("compact plan rows preserve partial pricing, unknown coverage, and event-summed tokens", () => {
  for (const [fullyPricedEvents, partiallyPricedEvents, unpricedEvents] of [[4, 0, 0], [1, 3, 0], [1, 1, 2]]) {
    const row = usageRow({ events: 4 });
    row.components = { input_uncached_tokens: 10, output_text_tokens: 2,
      output_reasoning_tokens: 3, output_combined_tokens: 7 };
    row.totalTokens = 22;
    row.allowanceWeighting[3] = 1;
    row.allowanceWeighting[4] = 1;
    row.pricingCoverage = { fullyPricedEvents, partiallyPricedEvents, unpricedEvents };
    const data = dashboard({ current: "pro", scopedRows: [row] });
    assert.equal(data.timeline.planScoped.status, "available");
    const decoded = data.timeline.planScoped.usage[0];
    assert.equal(decoded.totalTokens, 22);
    assert.deepEqual(decoded.pricingCoverage, row.pricingCoverage);
    assert.equal(decoded.components.output_combined_tokens, 7);
    const standard = decoded.allowanceWeighting.scenarios.unresolved_as_standard;
    assert.equal(standard.quotaWeightedUsd, unpricedEvents ? null : 4);
    assert.deepEqual(standard.coverage, { totalEvents: 4, observedEvents: unpricedEvents ? 0 : 1,
      declaredFromConfigEvents: unpricedEvents ? 0 : 1, assumedEvents: unpricedEvents ? 0 : 2,
      inferredEvents: 0, unknownEvents: unpricedEvents ? 4 : 0,
      observedSharePercent: unpricedEvents ? 0 : 25, unknownSharePercent: unpricedEvents ? 100 : 0 });
    assert.equal(decoded.allowanceWeighting.status, unpricedEvents ? "unavailable" : "complete");
  }
});

test("malformed compact counts and pricing quarantine the optional lane without losing the ledger", () => {
  for (const mutate of [
    (row) => { row.usageEvents = 1.5; },
    (row) => { row.apiPriceEquivalentUsd = "4"; },
    (row) => { row.allowanceWeighting[3] = 2; },
    (row) => { row.pricingCoverage.partiallyPricedEvents = 1; },
    (row) => { row.totalTokens = -1; },
  ]) {
    const row = usageRow();
    mutate(row);
    const data = dashboard({ current: "pro", scopedRows: [row] });
    assert.equal(data.timeline.planScoped.status, "unavailable");
    assert.equal(data.timeline.usage[0].usageEvents, 2);
  }
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
  assert.deepEqual(pro.timeline.selectedPlanUsage, []);
  assert.deepEqual(data, before, "selection cannot mutate or discard retained evidence");
  const plus = selectAllowancePlanPopulation(pro, "plus");
  assert.equal(plus.weekly.summary.median_weekly_value_usd, 85);
  assert.strictEqual(plus.weekly.paceForecast, data.weekly.paceForecast);
  assert.strictEqual(selectAllowancePlanPopulation(data, "pro"), pro,
    "stable selected views preserve the chart's identity-based memoization");
});

test("only an exact current-plan generation/cohort match preserves the comparison", () => {
  const covered = dashboard({ current: "pro", plus: 85, comparison: "single_plan_conditional" });
  const selected = selectAllowancePlanPopulation(covered);
  assert.equal(selected.allowancePlanSelection.comparisonAvailable, true);
  assert.strictEqual(selected.timeline.allowanceCapacity, covered.timeline.allowanceCapacity);
  assert.equal(selected.timeline.selectedPlanUsage[0].usageEvents, 1);
  assert.equal(selected.timeline.usage[0].usageEvents, 2,
    "selecting Trends cannot rewrite the all-plan accounting timeline");
  const historical = selectAllowancePlanPopulation(covered, "plus");
  assert.equal(historical.allowancePlanSelection.comparisonAvailable, false);
  assert.equal(historical.timeline.allowanceCapacity, null);
  assert.equal(historical.weekly.paceForecast, null);
  const mixed = selectAllowancePlanPopulation(dashboard({ current: "pro", plus: 85 }));
  assert.equal(mixed.allowancePlanSelection.comparisonAvailable, true,
    "an older alternate plan does not invalidate an independently scoped current-plan numerator");
  assert.equal(mixed.timeline.allowanceCapacity.status, "available");
});

test("basis, plan, cohort, or generation mismatches fail closed", () => {
  for (const mutate of [
    (scope) => { scope.planType = "plus"; },
    (scope) => { scope.basisFamilyId = "wrong-basis"; },
    (scope) => { scope.cohortId = "b".repeat(64); },
    (scope) => { scope.sourceGeneration = "generation-18"; },
    (scope) => { scope.sourceGenerationFingerprint = "other-fingerprint"; },
  ]) {
    const data = dashboard({ current: "pro", plus: 85 });
    mutate(data.timeline.planScoped.planScope);
    const selected = selectAllowancePlanPopulation(data);
    assert.equal(selected.allowancePlanSelection.comparisonAvailable, false);
    assert.deepEqual(selected.timeline.selectedPlanUsage, []);
    assert.equal(selected.timeline.usage[0].usageEvents, 2);
  }
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

test("manual refresh includes detailed accounting while automatic refresh stays quick", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="recalculate-detailed-accounting"/u,
    "the accounting page does not offer a duplicate manual refresh action");
  assert.match(source, /localClient\.recalculateDetailedAccounting\(\)/u);
  assert.match(source, /async function requestRefresh\(\{ autoContinue = false, detailed = false \} = \{\}\)/u,
    "the shared default stays quick for startup and automatic callers");
  assert.match(source, /requestRefresh\(\{ detailed: true \}\)/u);
  assert.match(source, /if \(detailed\) scheduleReindexAutoContinuation\(\);/u,
    "ordinary quick refresh cannot schedule a history continuation");
  assert.match(source, /requestRefresh\(\{ autoContinue: true, detailed: true \}\)/u,
    "bounded continuation preserves the original explicit detailed operation");
});
