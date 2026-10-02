// Unit checks for the GCP fast-path parity compare (Q-2). Synthetic,
// content-free inputs only; no database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
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
