// Unit checks for the GCP fast-path parity compare (Q-2). Synthetic,
// content-free inputs only; no database, no network.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ANALYTICS_V2_DECLARED_MODEL_METADATA,
  ANALYTICS_V2_PARITY_FAMILIES,
  compareAnalyticsV2Parity,
  declaredBreakdownsV13,
  normalizeServedDay,
  perDateExpectationFor,
  withheldModelDatesOf,
} from "./analytics-v2-parity-compare.mjs";
import { comparePerDate } from "./gcp-fastpath-dense-oracle/per-date-compare.mjs";
import { ANALYTICS_V2_Q1_CURRENT_CONTRACT, currentQ1ComparisonInputs, currentQ1PerDateExpected, loadQ1CurrentContract } from "./analytics-v2-parity-current-contract.mjs";

let currentQ1FixturePromise;
function currentQ1Fixture() {
  currentQ1FixturePromise ??= (async () => {
    const goldenDirectory = fileURLToPath(new URL("../analytics-v2-test/golden", import.meta.url));
    const perDateExpectedPath = fileURLToPath(new URL("../analytics-v2-test/golden-q1-node/per-date-expected.json", import.meta.url));
    const read = async (url) => JSON.parse(await readFile(url, "utf8"));
    const [currentContract, golden, goldenPreview, perDateExpected, manifest] = await Promise.all([
      loadQ1CurrentContract({ goldenDirectory, perDateExpectedPath }),
      read(new URL("../analytics-v2-test/golden/community-daily-response.json", import.meta.url)),
      read(new URL("../analytics-v2-test/golden/preview.json", import.meta.url)), read(perDateExpectedPath),
      read(new URL("../analytics-v2-test/golden/manifest.json", import.meta.url)),
    ]);
    const actual = structuredClone(currentContract.expected.golden);
    actual.allowanceBreakdowns = structuredClone(currentContract.expected.perDateExpected.allowanceBreakdowns);
    return { golden, goldenPreview, perDateExpected, currentContract, actual,
      actualPreview: structuredClone(currentContract.expected.perDateExpected.preview),
      withheldModelDates: withheldModelDatesOf(manifest) };
  })();
  return currentQ1FixturePromise;
}

test("the named current Q-1 contract preserves strict legacy rejection and exact current comparisons", async () => {
  const fixture = await currentQ1Fixture();
  const before = JSON.stringify([fixture.actual, fixture.actualPreview]);
  const report = compareAnalyticsV2Parity(fixture);
  assert.equal(report.unexpectedDiffs, 0);
  assert.deepEqual(report.currentContract, { id: ANALYTICS_V2_Q1_CURRENT_CONTRACT, accepted: true });
  const perDate = comparePerDate({ expected: fixture.perDateExpected, response: fixture.actual,
    preview: fixture.actualPreview, currentContract: fixture.currentContract });
  assert.equal(perDate.equal, true);
  assert.deepEqual(perDate.currentContract, report.currentContract);
  const legacy = compareAnalyticsV2Parity({ ...fixture, currentContract: null });
  assert.equal(legacy.unexpectedDiffs, 559, "the historical lane also rejects the appended Terra admin entry");
  const withoutTerra = structuredClone(fixture.actualPreview);
  assert.equal(withoutTerra.models.modelConfig.pop().modelId, "gpt-6.1-terra");
  assert.equal(compareAnalyticsV2Parity({ ...fixture, actualPreview: withoutTerra, currentContract: null }).unexpectedDiffs,
    558, "removing only Terra preserves the prior historical regression signature");
  assert.equal(Object.hasOwn(legacy, "currentContract"), false);
  assert.equal(comparePerDate({ expected: fixture.perDateExpected, response: fixture.actual,
    preview: fixture.actualPreview }).equal, false);
  assert.equal(JSON.stringify([fixture.actual, fixture.actualPreview]), before, "actual inputs are never rewritten");
});

test("the current Q-1 lane rejects changes in historical values and every new declared contract", async (t) => {
  const original = await currentQ1Fixture();
  const cases = [
    ["cost", (f) => { f.actual.days[0].payload.apiEquivalentSpend.knownCostUsd += 1; }],
    ["coverage", (f) => { f.actual.days[0].payload.apiEquivalentSpend.coverage = "other"; }],
    ...["usageEvents", "fullyPricedUsageEvents", "partiallyPricedUsageEvents", "unpricedUsageEvents"].map((key) =>
      [`spend ${key}`, (f) => { f.actual.days[0].payload.apiEquivalentSpend[key] += 1; }]),
    ["price method", (f) => { f.actual.days[0].payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.5"; }],
    ["price registry", (f) => { f.actual.days[0].payload.apiEquivalentSpend.registrySha256 = "0".repeat(64); }],
    ["extra spend key", (f) => { f.actual.days[0].payload.apiEquivalentSpend.extra = 0; }],
    ["missing spend key", (f) => { delete f.actual.days[0].payload.apiEquivalentSpend.currency; }],
    ["missing daily row", (f) => { f.actual.days.pop(); }],
    ["duplicate daily row", (f) => { f.actual.days.push(structuredClone(f.actual.days[0])); }],
    ["extra daily row", (f) => { f.actual.days.push({ ...structuredClone(f.actual.days[0]), day: "2026-01-01" }); }],
    ["daily totals", (f) => { f.actual.days[0].payload.totals.usageEvents += 1; }],
    ["common plan", (f) => { f.actual.allowanceBreakdowns.days[0].byPlanType.pro.participantCount += 1; }],
    ["combined amount", (f) => { f.actual.allowanceBreakdowns.days[0].combined.centralUsd = 123; }],
    ["preview coverage", (f) => { f.actualPreview.coverage.extra = 1; }],
    ["preview basis", (f) => { f.actualPreview.basis = "other"; }],
    ["preview schema", (f) => { f.actualPreview.schemaVersion = "admin-community-allowance-preview-v0.4"; }],
    ["public schema", (f) => { f.actual.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.4"; }],
    ...["basis", "normalization", "modelBasis", "modelGate", "referencePlanType"].map((key) =>
      [`public ${key}`, (f) => { f.actual.allowanceBreakdowns[key] = "other"; }]),
    ["missing plan", (f) => { f.actualPreview.plans.pop(); }],
    ["extra plan", (f) => { f.actualPreview.plans.push({ planType: "other", label: "Other", multiplier: 1 }); }],
    ["duplicate plan", (f) => { f.actualPreview.plans.push(structuredClone(f.actualPreview.plans[0])); }],
    ["reordered plans", (f) => { f.actualPreview.plans.reverse(); }],
    ["plan multiplier", (f) => { f.actualPreview.plans[2].multiplier = 1; }],
    ...["centralUsd", "participantCount", "fitCount", "band80Usd"].flatMap((key) => [
      [`public Pro Max ${key}`, (f) => { f.actual.allowanceBreakdowns.days[0].byPlanType.promax[key] = 1; }],
      [`preview Pro Max ${key}`, (f) => { f.actualPreview.days[0].byPlanType.promax[key] = 1; }],
    ]),
    ["missing Pro Max", (f) => { delete f.actual.allowanceBreakdowns.days[0].byPlanType.promax; }],
    ["extra Pro Max key", (f) => { f.actualPreview.days[0].byPlanType.promax.extra = 0; }],
    ["missing public day", (f) => { f.actual.allowanceBreakdowns.days.pop(); }],
    ["duplicate public day", (f) => { f.actual.allowanceBreakdowns.days.push(structuredClone(f.actual.allowanceBreakdowns.days[0])); }],
    ["extra preview field", (f) => { f.actualPreview.extra = 0; }],
    ["model basis", (f) => { f.actualPreview.models.basis = "other"; }],
    ["catalog stamp", (f) => { f.actualPreview.models.days[0].catalogVersion = "other"; }],
    ["missing model day", (f) => { f.actualPreview.models.days.pop(); }],
    ["duplicate model day", (f) => { f.actualPreview.models.days.push(structuredClone(f.actualPreview.models.days[0])); }],
    ["model count", (f) => { f.actualPreview.models.days[0].refusedParticipantCount += 1; }],
    ["public model value", (f) => { f.actual.allowanceBreakdowns.days.find((day) => day.models.length > 0).models[0][1] += 1; }],
    ["missing admin metadata", (f) => { f.actualPreview.models.modelConfig.pop(); }],
    ["changed admin metadata", (f) => { f.actualPreview.models.modelConfig[0].label = "other"; }],
    ["reordered admin metadata", (f) => { f.actualPreview.models.modelConfig.reverse(); }],
    ["extra public metadata", (f) => { f.actual.allowanceBreakdowns.modelConfig.push(structuredClone(f.actual.allowanceBreakdowns.modelConfig[0])); }],
    ["changed public metadata", (f) => { f.actual.allowanceBreakdowns.modelConfig[0].label = "other"; }],
    ["reordered public metadata", (f) => { f.actual.allowanceBreakdowns.modelConfig.reverse(); }],
    ["public key order", (f) => { const { modelConfig, ...rest } = f.actual.allowanceBreakdowns;
      f.actual.allowanceBreakdowns = { modelConfig, ...rest }; }],
    ["metadata entry key order", (f) => { const entry = f.actual.allowanceBreakdowns.modelConfig[0];
      f.actual.allowanceBreakdowns.modelConfig[0] = Object.fromEntries(Object.entries(entry).reverse()); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = { ...original, actual: structuredClone(original.actual), actualPreview: structuredClone(original.actualPreview) };
      mutate(fixture);
      const report = compareAnalyticsV2Parity(fixture);
      assert.ok(report.unexpectedDiffs > 0);
      assert.equal(report.currentContract.accepted, false);
      if (!name.startsWith("spend ") && !["cost", "coverage", "price method", "price registry", "extra spend key",
        "missing spend key", "missing daily row", "duplicate daily row", "extra daily row", "daily totals"].includes(name)) {
        assert.equal(comparePerDate({ expected: fixture.perDateExpected, response: fixture.actual,
          preview: fixture.actualPreview, currentContract: fixture.currentContract }).equal, false);
      }
    });
  }
});

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

// Owner decision OD-12 (2026-10-01): the fast path publishes each model date
// on its own; d43c8f92 withholds a block. Only the golden's withheld dates may
// differ, only by being published, and only with the values the oracle's
// per-date expectation holds for them.
function perDateFixture() {
  const allowanceDay = (day, models) => ({ day, combined: { centralUsd: 10 }, byPlanType: {}, models });
  const golden = response([]);
  golden.allowanceBreakdowns.days = [allowanceDay("2026-09-29", []), allowanceDay("2026-09-30", [["m", 1, 1]])];
  const actual = structuredClone(golden);
  actual.allowanceBreakdowns.days[0].models = [["m", 2, 1]];
  const goldenPreview = { schemaVersion: "admin-community-allowance-preview-v0.3",
    models: { basis: "b", days: [{ day: "2026-09-30", values: [["m", 1, 1]] }] } };
  const actualPreview = structuredClone(goldenPreview);
  actualPreview.models.days.unshift({ day: "2026-09-29", values: [["m", 2, 1]] });
  // The oracle's per-date publication: the withheld date's values included.
  const perDateExpected = { schemaVersion: "gcp-fastpath-dense-per-date-v1", nowMs: 1, unresolved: [],
    allowanceBreakdowns: structuredClone(actual.allowanceBreakdowns), preview: structuredClone(actualPreview) };
  return { golden, actual, goldenPreview, actualPreview, perDateExpected };
}
const byName = (report) => Object.fromEntries(report.families.map((family) => [family.family, family]));

test("publishing a withheld model date is the accepted per-date difference, and nothing else", () => {
  const fixture = perDateFixture();
  const report = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29"] });
  const families = byName(report);
  assert.equal(report.unexpectedDiffs, 0);
  assert.deepEqual(report.unexpectedFamilies, []);
  assert.equal(families["model-days-per-date"].expected, true);
  assert.equal(families["model-days-per-date"].compared, 2);
  assert.equal(families["model-days-per-date"].diffCount, 2);
  assert.deepEqual(families["model-days-per-date"].diffs.map((diff) => diff.path),
    ["$.allowanceBreakdowns.days[2026-09-29].models", "preview.models.days[2026-09-29]"]);
  assert.equal(families["model-days"].diffCount, 0);
  assert.ok(families["model-days"].equal >= 3, "the shared date and the day lists are still compared");
  assert.deepEqual(report.perDateModelPublication.publishedWithheldDates, ["2026-09-29"]);
  assert.deepEqual(report.perDateModelPublication.unverifiedWithheldDates, []);
  assert.equal(report.perDateModelPublication.valuesHeldTo, "gcp-fastpath-dense-per-date-v1");
  assert.equal(report.perDateModelPublication.withheldDates, 1);
});

test("an accepted date's value must equal the per-date expectation exactly", () => {
  // Any other value on a withheld date, in either place, is an unexpected difference.
  for (const mutate of [
    (fixture) => { fixture.actual.allowanceBreakdowns.days[0].models = [["m", 999.99, 7]]; },
    (fixture) => { fixture.actualPreview.models.days[0] = { day: "2026-09-29", values: [["m", 2, 1]],
      refusedParticipantCount: 0 }; },
    (fixture) => { fixture.perDateExpected.preview.models.days[0].values = [["m", 2.5, 1]]; },
  ]) {
    const fixture = perDateFixture();
    mutate(fixture);
    const report = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29"] });
    assert.deepEqual(report.unexpectedFamilies, ["model-days"]);
    assert.equal(byName(report)["model-days-per-date"].compared, 1);
  }
});

test("without a per-date expectation, or one lacking the date, the publication fails closed", () => {
  const { perDateExpected: _expected, ...fixture } = perDateFixture();
  const report = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29"] });
  assert.deepEqual(report.unexpectedFamilies, ["model-days"]);
  assert.equal(report.unexpectedDiffs, 2);
  assert.deepEqual(byName(report)["model-days"].diffs.map((diff) => [diff.path, diff.golden]), [
    ["$.allowanceBreakdowns.days[2026-09-29].models", "<withheld; no per-date expectation>"],
    ["preview.models.days[2026-09-29]", "<withheld; no per-date expectation>"],
  ]);
  assert.deepEqual(report.perDateModelPublication.unverifiedWithheldDates, ["2026-09-29"]);
  assert.deepEqual(report.perDateModelPublication.publishedWithheldDates, []);
  assert.equal(report.perDateModelPublication.valuesHeldTo, null);
  const lacking = perDateFixture();
  lacking.perDateExpected.allowanceBreakdowns.days.shift();
  lacking.perDateExpected.preview.models.days.shift();
  const lackingReport = compareAnalyticsV2Parity({ ...lacking, withheldModelDates: ["2026-09-29"] });
  assert.deepEqual(lackingReport.unexpectedFamilies, ["model-days"]);
  assert.deepEqual(lackingReport.perDateModelPublication.unverifiedWithheldDates, ["2026-09-29"]);
});

test("a per-date expectation must be the oracle's, for the golden's clock, with nothing unresolved", () => {
  const expectation = perDateFixture().perDateExpected;
  assert.equal(perDateExpectationFor(expectation, { nowMs: 1 }), expectation);
  for (const [value, manifest] of [
    [expectation, { nowMs: 2 }],
    [expectation, null],
    [{ ...expectation, schemaVersion: "other" }, { nowMs: 1 }],
    [{ ...expectation, unresolved: ["2026-09-29"] }, { nowMs: 1 }],
    [{ ...expectation, unresolved: undefined }, { nowMs: 1 }],
    [null, { nowMs: 1 }],
  ]) {
    assert.throws(() => perDateExpectationFor(value, manifest), /ANALYTICS_V2_PARITY_PER_DATE_INVALID/u);
  }
  assert.throws(() => compareAnalyticsV2Parity({ ...perDateFixture(), perDateExpected: [] }),
    /ANALYTICS_V2_PARITY_PER_DATE_INVALID/u);
});

test("without the golden's withheld dates the same publication is unexpected", () => {
  const report = compareAnalyticsV2Parity(perDateFixture());
  assert.deepEqual(report.unexpectedFamilies, ["model-days"]);
  assert.equal(byName(report)["model-days-per-date"].compared, 0);
  assert.deepEqual(report.perDateModelPublication.publishedWithheldDates, []);
});

test("a published date outside the withheld set fails", () => {
  const report = compareAnalyticsV2Parity({ ...perDateFixture(), withheldModelDates: ["2026-09-28"] });
  assert.deepEqual(report.unexpectedFamilies, ["model-days"]);
  const diffs = byName(report)["model-days"].diffs.map((diff) => diff.path);
  assert.ok(diffs.includes("$.allowanceBreakdowns.days[2026-09-29].models[0]"));
  assert.ok(diffs.includes("preview.models.days[*].day[0]"));
});

test("a shared model date must stay byte-equal while a withheld date is accepted", () => {
  const fixture = perDateFixture();
  fixture.actual.allowanceBreakdowns.days[1].models = [["m", 1.01, 1]];
  fixture.actualPreview.models.days[1].values = [["m", 1.01, 1]];
  const report = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29"] });
  assert.deepEqual(report.unexpectedFamilies, ["model-days"]);
  assert.deepEqual(byName(report)["model-days"].diffs.map((diff) => diff.path),
    ["$.allowanceBreakdowns.days[2026-09-30].models[0][1]", "preview.models.days[2026-09-30].values[0][1]"]);
});

test("a withheld date the oracle did publish is compared exactly", () => {
  const fixture = perDateFixture();
  const report = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29", "2026-09-30"] });
  assert.equal(report.unexpectedDiffs, 0);
  fixture.actual.allowanceBreakdowns.days[1].models = [];
  const changed = compareAnalyticsV2Parity({ ...fixture, withheldModelDates: ["2026-09-29", "2026-09-30"] });
  assert.deepEqual(changed.unexpectedFamilies, ["model-days"]);
});

test("only model values may differ on a withheld date; the rest of the day and dropped dates fail", () => {
  const changedCombined = perDateFixture();
  changedCombined.actual.allowanceBreakdowns.days[0].combined = { centralUsd: 11 };
  assert.deepEqual(compareAnalyticsV2Parity({ ...changedCombined, withheldModelDates: ["2026-09-29"] })
    .unexpectedFamilies, ["allowance-breakdowns"]);
  const dropped = perDateFixture();
  dropped.actual.allowanceBreakdowns.days.shift();
  assert.deepEqual(compareAnalyticsV2Parity({ ...dropped, withheldModelDates: ["2026-09-29"] }).unexpectedFamilies,
    ["allowance-breakdowns"]);
  const nullModels = perDateFixture();
  nullModels.actual.allowanceBreakdowns.days[0].models = null;
  assert.deepEqual(compareAnalyticsV2Parity({ ...nullModels, withheldModelDates: ["2026-09-29"] }).unexpectedFamilies,
    ["model-days"]);
  const missingPreviewDay = perDateFixture();
  missingPreviewDay.actualPreview.models.days.pop();
  assert.deepEqual(compareAnalyticsV2Parity({ ...missingPreviewDay, withheldModelDates: ["2026-09-29"] })
    .unexpectedFamilies, ["model-days"]);
});

test("the withheld dates come from the golden manifest and are validated", () => {
  assert.deepEqual(withheldModelDatesOf({ modelPublications: { missing: ["2026-07-25", "2026-07-24"] } }),
    ["2026-07-24", "2026-07-25"]);
  assert.deepEqual(withheldModelDatesOf({}), []);
  for (const missing of [["2026-7-24"], ["2026-07-24", "2026-07-24"], "2026-07-24", [null]]) {
    assert.throws(() => withheldModelDatesOf({ modelPublications: { missing } }), /WITHHELD_DATES_INVALID/u);
  }
});

// Owner decision round 7 (2026-10-02): GCP serves breakdowns v1.3, d43c8f92's
// v1.1 plus the catalog baseline's model-metadata block, as a declared
// difference. Every other byte of the block is still held to the oracle.
function v11Breakdowns() {
  return {
    schemaVersion: "community-allowance-breakdowns-v1.1",
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_plus_x20",
    modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition",
    modelGate: "shared_composition_kernel_identification",
    generatedAt: "2026-10-01T12:00:00.000Z",
    days: [{ day: "2026-09-30", combined: { centralUsd: 10 }, byPlanType: {}, models: [["gpt-6-sol", 1, 1]] }],
  };
}

function v13Fixture() {
  const golden = response([], { allowanceBreakdowns: v11Breakdowns() });
  const actual = response([], { allowanceBreakdowns: {
    ...v11Breakdowns(), schemaVersion: "community-allowance-breakdowns-v1.3",
    modelConfig: structuredClone(ANALYTICS_V2_DECLARED_MODEL_METADATA),
  } });
  return { golden, actual };
}

test("the declared block is the committed manifest_version 1 public roster", () => {
  // The six models the d43c8f92 public page charts, in its card order; never
  // a model the owner's selected comparison keeps off the page, such as GPT-5.5.
  assert.deepEqual([...ANALYTICS_V2_DECLARED_MODEL_METADATA].sort((left, right) => left.order - right.order)
    .map(({ id, family, order }) => [id, family, order]), [
    ["gpt-6-astra", "astra", 0], ["gpt-6-sol", "sol", 1], ["gpt-6-luna", "luna", 2],
    ["gpt-5.6-terra", "terra", 3], ["gpt-5.6-sol", "sol", 4], ["gpt-5.6-luna", "luna", 5],
  ]);
  assert.deepEqual(ANALYTICS_V2_DECLARED_MODEL_METADATA.find((entry) => entry.id === "gpt-6-astra"),
    { id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 });
  assert.equal(ANALYTICS_V2_DECLARED_MODEL_METADATA.some((entry) => entry.id === "gpt-5.5"), false);
});

test("a served v1.3 block is the declared difference and nothing else", () => {
  const report = compareAnalyticsV2Parity(v13Fixture());
  assert.equal(report.unexpectedDiffs, 0);
  assert.deepEqual(report.breakdownsV13, { decision: report.breakdownsV13.decision, served: true, accepted: true,
    declaredEntries: 6 });
  const declared = byName(report)["breakdowns-v13-metadata"];
  assert.equal(declared.expected, true);
  assert.deepEqual(declared.diffs.map((diff) => diff.path),
    ["$.allowanceBreakdowns.schemaVersion", "$.allowanceBreakdowns.modelConfig"]);
  // The plain v1.1 oracle shape served as-is is equal and declares nothing.
  const plain = compareAnalyticsV2Parity({ golden: v13Fixture().golden, actual: v13Fixture().golden });
  assert.equal(plain.unexpectedDiffs, 0);
  assert.deepEqual([plain.breakdownsV13.served, plain.breakdownsV13.accepted], [false, false]);
});

test("every other byte of a v1.3 block is still held to the oracle", () => {
  const changedValue = v13Fixture();
  changedValue.actual.allowanceBreakdowns.days[0].combined.centralUsd = 11;
  assert.deepEqual(compareAnalyticsV2Parity(changedValue).unexpectedFamilies, ["allowance-breakdowns"]);
  const changedModel = v13Fixture();
  changedModel.actual.allowanceBreakdowns.days[0].models[0][1] = 2;
  assert.deepEqual(compareAnalyticsV2Parity(changedModel).unexpectedFamilies, ["model-days"]);
  const changedHeader = v13Fixture();
  changedHeader.actual.allowanceBreakdowns.generatedAt = "2026-10-01T12:00:01.000Z";
  assert.deepEqual(compareAnalyticsV2Parity(changedHeader).unexpectedFamilies, ["allowance-breakdowns"]);
});

test("a v1.3 block outside the declared shape or with another block is unexpected", () => {
  const mutations = [
    (block) => { block.modelConfig[0].label = "Codex Auto Review"; },
    (block) => { block.modelConfig.pop(); },
    (block) => { block.modelConfig.push({ id: "synthetic-unseen", label: "Unseen", family: "generic", order: 99 }); },
    (block) => { block.modelConfig[0].order = 8; block.modelConfig[1].order = 7; },
    (block) => { block.modelConfig[0].tone = "x"; },
    (block) => { delete block.modelConfig; },
    (block) => { block.catalogManifestVersion = 1; },
    (block) => { const { modelConfig, ...rest } = structuredClone(block);
      for (const key of Object.keys(block)) delete block[key];
      Object.assign(block, { modelConfig, ...rest }); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = v13Fixture();
    mutate(fixture.actual.allowanceBreakdowns);
    const report = compareAnalyticsV2Parity(fixture);
    assert.ok(report.unexpectedFamilies.includes("allowance-breakdowns"), `mutation ${index}`);
    assert.equal(report.breakdownsV13.accepted, false, `mutation ${index}`);
    assert.equal(byName(report)["breakdowns-v13-metadata"].diffCount, 0, `mutation ${index}`);
  }
  // Against a v1.1 oracle, a v1.3 claim is never the v1.1 bytes by itself.
  const relabelOnly = v13Fixture();
  relabelOnly.golden.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.0";
  assert.deepEqual(compareAnalyticsV2Parity(relabelOnly).unexpectedFamilies, ["allowance-breakdowns"]);
});

test("the per-date compare holds the reduced v1.1 block and the declared block", () => {
  const { actual } = v13Fixture();
  const expected = { decision: "d", preview: { p: 1 }, allowanceBreakdowns: v11Breakdowns() };
  const equal = comparePerDate({ expected, response: actual, preview: { p: 1 } });
  assert.equal(equal.equal, true);
  assert.deepEqual(equal.breakdownsV13, { served: true, accepted: true });
  const wrongBlock = structuredClone(actual);
  wrongBlock.allowanceBreakdowns.modelConfig[3].family = "sol";
  assert.equal(comparePerDate({ expected, response: wrongBlock, preview: { p: 1 } }).equal, false);
  const wrongValue = structuredClone(actual);
  wrongValue.allowanceBreakdowns.days[0].models = [];
  assert.equal(comparePerDate({ expected, response: wrongValue, preview: { p: 1 } }).equal, false);
  assert.equal(declaredBreakdownsV13(null).served, false);
});

// Hash-bound expected-input admission checks share this registered owning suite.
{
const FIXTURES = fileURLToPath(new URL("../analytics-v2-test/", import.meta.url));
const OPTIONS = { goldenDirectory: join(FIXTURES, "golden"),
  perDateExpectedPath: join(FIXTURES, "golden-q1-node/per-date-expected.json") };
const PUBLIC_KEYS = ["schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis",
  "modelGate", "generatedAt", "days", "modelConfig"];
const PLAN_KEYS = ["pro", "prolite", "promax", "plus"];
const EMPTY = { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null };
const CURRENT_BASIS = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25";
const CURRENT_MODEL_BASIS = "seven_day_codex_pro20x_equivalent_per_model_composition_promax25";
let contract, original;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const equal = (actual, expected, message) => assert.equal(isDeepStrictEqual(actual, expected), true, message);
before(async () => {
  contract = await loadQ1CurrentContract(OPTIONS);
  original = { golden: await readJson(join(OPTIONS.goldenDirectory, "community-daily-response.json")),
    goldenPreview: await readJson(join(OPTIONS.goldenDirectory, "preview.json")),
    perDateExpected: await readJson(OPTIONS.perDateExpectedPath) };
});

function frozenTree(value) {
  return value === null || typeof value !== "object"
    || (Object.isFrozen(value) && Object.values(value).every(frozenTree));
}

function checkPublic(value) {
  equal(Object.keys(value), PUBLIC_KEYS, "current public wire order");
  equal(Object.keys(value.modelConfig[0]), ["id", "label", "family", "order"], "public metadata key order");
  assert.equal(value.schemaVersion, "community-allowance-breakdowns-v1.5");
  assert.equal(value.basis, CURRENT_BASIS);
  assert.equal(value.referencePlanType, "pro");
  assert.equal(value.normalization, "pro_x1_prolite_x4_promax_x0_8_plus_x20");
  assert.equal(value.modelBasis, CURRENT_MODEL_BASIS);
  assert.equal(value.modelGate, "shared_composition_kernel_identification");
  assert.equal(value.days.length, 69);
  assert.equal(value.modelConfig.length, 8);
  equal(value.modelConfig[4], { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", family: "terra", order: 4 },
    "current Terra presentation precedes its predecessor");
  for (const day of value.days) {
    equal(Object.keys(day.byPlanType), PLAN_KEYS, "current public plan order");
    equal(Object.keys(day.byPlanType.promax), Object.keys(EMPTY), "public empty summary shape");
    equal(day.byPlanType.promax, EMPTY, "public Pro Max remains empty");
  }
}

function checkPreview(value, expectedModelDays) {
  assert.equal(value.schemaVersion, "admin-community-allowance-preview-v0.5");
  assert.equal(value.basis, `${CURRENT_BASIS}_preview`);
  assert.equal(value.referencePlanType, "pro");
  equal(value.plans, [
    { planType: "pro", label: "Pro 20x", multiplier: 1 },
    { planType: "prolite", label: "Pro 5x", multiplier: 4 },
    { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
    { planType: "plus", label: "Plus", multiplier: 20 },
  ], "literal current plan labels and ratios");
  assert.equal(value.days.length, 70);
  for (const day of value.days) {
    equal(Object.keys(day.byPlanType), PLAN_KEYS, "current preview plan order");
    equal(Object.keys(day.byPlanType.promax), ["fitCount", "participantCount", "centralUsd", "band80Usd"],
      "preview empty summary shape");
    equal(day.byPlanType.promax, EMPTY, "preview Pro Max remains empty");
  }
  assert.equal(value.models.basis, CURRENT_MODEL_BASIS);
  assert.equal(value.models.gate, "shared_composition_kernel_identification");
  assert.equal(value.models.modelConfig.length, 44);
  equal(value.models.modelConfig[43], { modelId: "gpt-6.1-terra", label: "GPT-6.1 Terra",
    allowanceTrack: "primary", pricingStatus: "published" }, "Terra appends to current wire metadata");
  assert.equal(value.models.days.length, expectedModelDays);
  for (const day of value.models.days) {
    assert.equal(day.catalogVersion, "reviewed-model-catalog-2026-10-26.1");
    assert.equal(day.values.some(([id]) => id === "gpt-6.1-terra"), false, "metadata cannot invent historical Terra evidence");
  }
}

test("the explicitly selected Q1 contract has fixed provenance and deeply frozen expected copies", () => {
  assert.equal(ANALYTICS_V2_Q1_CURRENT_CONTRACT, "q1-pro20-four-plan-v1");
  assert.equal(contract.id, ANALYTICS_V2_Q1_CURRENT_CONTRACT);
  assert.equal(contract.sourceCommit, "d43c8f92a059d9c577776f7eca8a331eb305b8a6");
  assert.equal(contract.corpusSha256, "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e");
  assert.equal(contract.nowMs, 1790856000000);
  assert.equal(frozenTree(contract), true);
  assert.equal(currentQ1ComparisonInputs(contract, original), contract.expected);
  assert.equal(currentQ1PerDateExpected(contract, original.perDateExpected), contract.expected.perDateExpected);
  assert.notEqual(contract.expected.golden, original.golden);
  assert.throws(() => { contract.expected.golden.allowanceBreakdowns.days[0].byPlanType.promax.fitCount = 1; }, TypeError);
});

test("all added headers, empty summaries, metadata and catalog stamps have the declared current shape", async () => {
  const expected = currentQ1ComparisonInputs(contract, original);
  checkPublic(expected.golden.allowanceBreakdowns);
  checkPublic(expected.perDateExpected.allowanceBreakdowns);
  checkPreview(expected.goldenPreview, 56);
  checkPreview(expected.perDateExpected.preview, 70);
  assert.equal(expected.perDateExpected.days.length, 70);
  for (const day of expected.perDateExpected.days) assert.equal(day.payload.catalogVersion, "reviewed-model-catalog-2026-10-26.1");
  const admin = await readJson(join(FIXTURES, "fixtures/allowance-preview-v04.json"));
  const publicFixture = await readJson(join(FIXTURES, "fixtures/allowance-breakdowns-v14-expected.json"));
  equal(expected.goldenPreview.models.modelConfig.slice(0, 43), admin.models.modelConfig, "pinned retained admin metadata unchanged");
  equal(expected.golden.allowanceBreakdowns.modelConfig.filter(({ id }) => id !== "gpt-6.1-terra")
    .map((entry, order) => ({ ...entry, order })), publicFixture.modelConfig, "pinned retained public metadata order unchanged");
  equal(expected.goldenPreview.models.modelConfig.slice(0, 42), original.goldenPreview.models.modelConfig,
    "all historical roster metadata remain exact");
  for (const day of expected.golden.days) {
    assert.equal(day.payload.apiEquivalentSpend.pricingMethodVersion, "server-api-price-equivalent-v0.6");
    assert.equal(day.payload.apiEquivalentSpend.registrySha256,
      "206544769b43e4b9645284258edd38f7c07a226022db10f5ec0181335df236ab");
  }
});

function restoreBreakdowns(value, old) {
  for (const key of ["schemaVersion", "basis", "normalization", "modelBasis"]) value[key] = old[key];
  delete value.modelConfig;
  for (const day of value.days) delete day.byPlanType.promax;
}

function restorePreview(value, old) {
  value.schemaVersion = old.schemaVersion;
  value.basis = old.basis;
  value.plans = structuredClone(old.plans);
  value.models.basis = old.models.basis;
  value.models.modelConfig = structuredClone(old.models.modelConfig);
  for (const day of value.days) delete day.byPlanType.promax;
  for (const day of value.models.days) day.catalogVersion = "reviewed-model-catalog-2026-09-23.1";
}

test("undoing only the declared additions leaves every common numeric and nonnumeric field unchanged", () => {
  const copy = structuredClone(contract.expected);
  for (const day of copy.golden.days) {
    day.payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.5";
    day.payload.apiEquivalentSpend.registrySha256 = "48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9";
  }
  restoreBreakdowns(copy.golden.allowanceBreakdowns, original.golden.allowanceBreakdowns);
  restoreBreakdowns(copy.perDateExpected.allowanceBreakdowns, original.perDateExpected.allowanceBreakdowns);
  restorePreview(copy.goldenPreview, original.goldenPreview);
  restorePreview(copy.perDateExpected.preview, original.perDateExpected.preview);
  for (const day of copy.perDateExpected.days) day.payload.catalogVersion = "reviewed-model-catalog-2026-09-23.1";
  equal(copy, original, "all common fields, including all eight other spend fields, must remain exact");
});

test("forged contracts, missing inputs, an actual input and already-current inputs cannot select this lane", () => {
  for (const forged of [null, {}, { ...contract }, structuredClone(contract)]) {
    assert.throws(() => currentQ1ComparisonInputs(forged, original), /CONTRACT_INVALID/u);
    assert.throws(() => currentQ1PerDateExpected(forged, original.perDateExpected), /CONTRACT_INVALID/u);
  }
  for (const key of Object.keys(original)) {
    const incomplete = { ...original }; delete incomplete[key];
    assert.throws(() => currentQ1ComparisonInputs(contract, incomplete), /COMPARISON_INPUT_INVALID/u);
  }
  assert.throws(() => currentQ1ComparisonInputs(contract, { ...original, actual: original.golden }), /COMPARISON_INPUT_INVALID/u);
  assert.throws(() => currentQ1ComparisonInputs(contract, contract.expected), /COMPARISON_INPUT_INVALID/u);
  assert.throws(() => currentQ1PerDateExpected(contract, contract.expected.perDateExpected), /PER_DATE_INPUT_INVALID/u);
});

test("wrong, missing or extra historical fields cannot be erased by the expected-only transform", () => {
  const changes = [
    (input) => { input.golden.days[0].payload.apiEquivalentSpend.knownCostUsd += 1; },
    (input) => { delete input.golden.days[0].payload.apiEquivalentSpend.coverage; },
    (input) => { input.golden.days[0].payload.apiEquivalentSpend.extra = 0; },
    (input) => { input.golden.days[0].payload.apiEquivalentSpend.pricingMethodVersion = "server-api-price-equivalent-v0.6"; },
    (input) => { input.golden.allowanceBreakdowns.days[0].byPlanType.promax = EMPTY; },
    (input) => { input.goldenPreview.models.modelConfig[0].label = "changed"; },
    (input) => { input.perDateExpected.preview.models.days[0].catalogVersion = "reviewed-model-catalog-2026-09-29.1"; },
    (input) => { input.perDateExpected.nowMs += 1; },
    (input) => { input.perDateExpected.unresolved.push({}); },
  ];
  for (const change of changes) {
    const altered = structuredClone(original); change(altered);
    assert.throws(() => currentQ1ComparisonInputs(contract, altered), /COMPARISON_INPUT_INVALID/u);
    if (!isDeepStrictEqual(altered.perDateExpected, original.perDateExpected)) {
      assert.throws(() => currentQ1PerDateExpected(contract, altered.perDateExpected), /PER_DATE_INPUT_INVALID/u);
    }
  }
});

async function filesUnder(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...await filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`));
    else paths.push(`${prefix}${entry.name}`);
  }
  return paths.sort();
}

test("every complete Q1 source-data file and per-date provenance is independently hash-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "q1-current-contract-"));
  try {
    const options = { goldenDirectory: join(root, "golden"), perDateExpectedPath: join(root, "per-date/per-date-expected.json") };
    await cp(OPTIONS.goldenDirectory, options.goldenDirectory, { recursive: true });
    await cp(dirname(OPTIONS.perDateExpectedPath), dirname(options.perDateExpectedPath), { recursive: true });
    const files = (await filesUnder(options.goldenDirectory)).map((path) => join(options.goldenDirectory, path));
    assert.equal(files.length, 12);
    files.push(options.perDateExpectedPath, join(dirname(options.perDateExpectedPath), "SOURCE.json"));
    for (const path of files) {
      const bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
      await assert.rejects(loadQ1CurrentContract(options), /INPUT_HASH_MISMATCH/u);
      await writeFile(path, bytes);
    }
    await rm(join(options.goldenDirectory, "dump/usage-monitor-db.json"));
    await assert.rejects(loadQ1CurrentContract(options), /INPUT_UNAVAILABLE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong lanes and incomplete loader options fail instead of falling back to historical parity", async () => {
  await assert.rejects(loadQ1CurrentContract({}), /ARGUMENT_INVALID/u);
  await assert.rejects(loadQ1CurrentContract({ goldenDirectory: OPTIONS.goldenDirectory }), /ARGUMENT_INVALID/u);
  await assert.rejects(loadQ1CurrentContract({ ...OPTIONS, actual: {} }), /ARGUMENT_INVALID/u);
  await assert.rejects(loadQ1CurrentContract({ ...OPTIONS, goldenDirectory: join(FIXTURES, "golden-dense") }),
    /INPUT_HASH_MISMATCH|INPUT_UNAVAILABLE/u);
  await assert.rejects(loadQ1CurrentContract({ ...OPTIONS, perDateExpectedPath: join(FIXTURES, "golden-dense/per-date-expected.json") }),
    /INPUT_HASH_MISMATCH/u);
});

}
