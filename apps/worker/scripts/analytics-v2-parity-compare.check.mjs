// Unit checks for the GCP fast-path parity compare (Q-2). Synthetic,
// content-free inputs only; no database, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION, projectAdminModelHistoryDay }
  from "@app-usagemonitor/telemetry-contract";
import {
  ANALYTICS_V2_DECLARED_MODEL_METADATA,
  ANALYTICS_V2_PARITY_FAMILIES,
  ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION,
  compareAnalyticsV2CurrentContract,
  compareAnalyticsV2Parity,
  declaredBreakdownsV13,
  normalizeServedDay,
  perDateExpectationFor,
  parseAnalyticsV2ParityCompareArgs,
  withheldModelDatesOf,
} from "./analytics-v2-parity-compare.mjs";
import { comparePerDate } from "./gcp-fastpath-dense-oracle/per-date-compare.mjs";
import {
  assessCurrentQ1ReferenceCompleteness,
  buildCurrentQ1AdmissionIdentities,
  classifyCurrentQ1VerifiedNativeOutcome,
  validateCurrentQ1NativeEvidence,
} from "../postgres-test/fixtures/current-q1-d1-reference.mjs";
import { rehearsalComparisonGates } from "./gcp-fastpath-rehearsal.mjs";

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

test("comparison CLI retains historical default and requires an explicit complete current mode", () => {
  const historical = ["--golden", "synthetic-golden", "--actual", "synthetic-actual.json"];
  assert.equal(parseAnalyticsV2ParityCompareArgs(historical).mode, "historical");
  assert.equal(parseAnalyticsV2ParityCompareArgs(["--comparison-mode", "historical", ...historical]).mode, "historical");
  const current = ["--comparison-mode", "current-worker-d1", "--current-reference", "synthetic-reference.json",
    "--current-reference-binding", "synthetic-binding.json", "--current-reference-sha256", "a".repeat(64),
    "--actual", "synthetic-actual.json",
    "--actual-preview", "synthetic-preview.json"];
  assert.equal(parseAnalyticsV2ParityCompareArgs(current).mode, "current-worker-d1");
  for (const invalid of [
    [], ["--comparison-mode", "unknown", ...historical], [...historical, "--unknown", "x"],
    [...historical, "--actual", "duplicate"], [...historical, "--actual-preview"],
    [...historical, "--current-reference", "x"], [...historical, "--current-reference-binding", "x"],
    [...historical, "--current-reference-sha256", "a".repeat(64)],
    [...current, "--golden", "x"], [...current, "--per-date-expected", "x"],
    current.slice(0, -2), current.filter((_value, index) => index !== 2 && index !== 3),
    current.filter((_value, index) => index !== 4 && index !== 5),
    current.filter((_value, index) => index !== 6 && index !== 7),
    ["--actual", "--golden", "x"], [...historical, "--actual-preview", ""],
  ]) assert.throws(() => parseAnalyticsV2ParityCompareArgs(invalid), /ANALYTICS_V2_PARITY_ARGUMENTS_INVALID/u);
});

const jsonSha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const corpusIndex = JSON.parse(readFileSync(new URL("../analytics-v2-test/golden/corpus/corpus.json", import.meta.url), "utf8"));
const corpusShards = new Map(["a", "b", "c", "d"].map((key) => [key,
  JSON.parse(readFileSync(new URL(`../analytics-v2-test/golden/corpus/corpus-owner-${key}.json`, import.meta.url), "utf8"))]));
const dates = (from, length) => Array.from({ length }, (_, index) =>
  new Date(Date.parse(`${from}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));
const CURRENT_Q1_BOUNDS = Object.freeze({ bootstrap: 64, settleRounds: 8, delivery: 512, daily: 256,
  dailyConvergence: 4_096, forcedDailyPerHead: 64, dailyRetirement: 16, cachePasses: 4_096,
  nativeInvocations: 128, nativeStall: 8 });
const CURRENT_Q1_RUNTIME_CONTRACTS = Object.freeze({ v1: 1, v11: 1 });
function v1ExtraAdmissionDescriptors() {
  return corpusIndex.owners.flatMap((owner) => corpusShards.get(owner.key).days.flatMap((day) =>
    Object.entries(day.v1Extra ?? {}).filter(([, rows]) => rows.length > 0).map(([stream, rows]) => ({
      ownerKey: owner.key, participantId: owner.participantId, day: day.day, format: "v1", stream,
      records: rows.length, corpusRowsSha256: jsonSha(rows),
    })))).sort((left, right) => {
    const a = `${left.ownerKey}\0${left.day}\0${left.stream}`, b = `${right.ownerKey}\0${right.day}\0${right.stream}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function currentQ1SyntheticAdmissions(v1ExtraEntries) {
  const primary = corpusIndex.owners.flatMap((owner) => corpusShards.get(owner.key).days.map((day) => {
    const format = owner.key === "c" ? "v12" : "v11";
    const chunks = ["quota", "session", "usage"].flatMap((stream) => {
      const rows = day.records[stream];
      return rows.length === 0 ? [] : [{ chunkId: `synthetic:${day.day}:${stream}`,
        chunkDigest: jsonSha(rows), recordCount: rows.length }];
    });
    return { participantId: owner.participantId, format, day: day.day,
      manifestDigest: jsonSha({ participantId: owner.participantId, format, day: day.day, chunks }), chunks };
  }));
  const extras = v1ExtraEntries.map((entry) => ({ participantId: entry.participantId, format: "v1", day: entry.day,
    chunkDigest: jsonSha({ ownerKey: entry.ownerKey, day: entry.day, stream: entry.stream,
      records: entry.records, corpusRowsSha256: entry.corpusRowsSha256 }), stream: entry.stream,
    records: entry.records, corpusRowsSha256: entry.corpusRowsSha256 }));
  return [...primary, ...extras];
}

async function currentQ1PublicBuilderAdmissions() {
  const workerRoot = fileURLToPath(new URL("..", import.meta.url));
  const cacheRoot = mkdtempSync(join(tmpdir(), "current-q1-admission-identities-"));
  let vite;
  try {
    vite = await createServer({ root: workerRoot, cacheDir: cacheRoot, configFile: false,
      appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    const P = {};
    for (const path of ["/test/helpers/telemetry-v11.ts", "/src/crypto.ts", "/src/canonical-json.ts",
      "/src/telemetry-v1.ts", "/src/telemetry-v11-compatibility.ts"]) {
      Object.assign(P, await vite.ssrLoadModule(path));
    }
    Object.assign(P, await vite.ssrLoadModule("/node_modules/@app-usagemonitor/telemetry-contract/index.js"));
    const corpus = {
      owners: corpusIndex.owners.map((owner) => ({ ...owner, days: corpusShards.get(owner.key).days })),
      window: corpusIndex.window,
      expectedDailyDays: dates(corpusIndex.window.fromDay, corpusIndex.window.days)
        .filter((day) => !corpusIndex.conflict.days.includes(day)),
      conflictDays: [...corpusIndex.conflict.days].sort(),
    };
    return await buildCurrentQ1AdmissionIdentities(P, corpus);
  } finally {
    await vite?.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

/** Manually declared, content-free inputs for pure guard/comparison checks.
 * This is not an executed D1 reference and establishes no runtime gate. */
function currentContractFixture() {
  const migrations = ["migrations", "analytics-migrations"].map((directory) =>
    ({ path: `apps/worker/${directory}/0001_synthetic.sql`, sha256: "a".repeat(64) }));
  const files = [...migrations, { path: "apps/worker/src/synthetic-reference.ts", sha256: "b".repeat(64) }]
    .sort((left, right) => left.path.localeCompare(right.path));
  const source = { head: "1".repeat(40), files, sha256: jsonSha(files) };
  const runtime = { version: "v26.2.0", platform: "linux", arch: "x64",
    binarySha256: "030a5e93e4f7a022b12a3ec80fecd22af9614356904a05ece6b1b2dbf4c1f588",
    pinnedNowMs: 1_790_856_000_000, randomSeed: "current-q1-reference", sqliteVersion: "synthetic-sqlite-version" };
  const corpus = { synthetic: true, sourceCommit: corpusIndex.sourceCommit,
    canonicalSha256: "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e",
    recordCount: 14_832, primaryRecordCount: 14_830, owners: 4, daysPerOwner: 170,
    files: ["corpus.json", ...["a", "b", "c", "d"].map((key) => `corpus-owner-${key}.json`)]
      .map((name) => ({ path: `apps/worker/analytics-v2-test/golden/corpus/${name}`, sha256: "c".repeat(64) })) };
  const expectedDailyDays = dates(corpusIndex.window.fromDay, corpusIndex.window.days)
    .filter((day) => !corpusIndex.conflict.days.includes(day));
  const v1ExtraEntries = v1ExtraAdmissionDescriptors();
  const v1ExtraAdmissions = { count: v1ExtraEntries.length, sha256: jsonSha(v1ExtraEntries), entries: v1ExtraEntries };
  const admissionIdentities = currentQ1SyntheticAdmissions(v1ExtraEntries).sort((left, right) => {
    const a = JSON.stringify([left.participantId, left.format, left.day]);
    const b = JSON.stringify([right.participantId, right.format, right.day]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const corpusStructure = { owners: corpusIndex.owners.map(({ key, participantId, pinnedOwnerDigest, models }) =>
    ({ key, participantId, pinnedOwnerDigest, models })), window: corpusIndex.window, expectedDailyDays,
    conflictDays: [...corpusIndex.conflict.days].sort(), v1ExtraAdmissions, admissionIdentities };
  const referenceBinding = { schemaVersion: "current-q1-d1-reference-binding-v3", sourceId: "gcp-fastpath-oracle",
    sourceNamespace: "gcp-fastpath-oracle", source, migrations, migrationSha256: jsonSha(migrations), runtime,
    bounds: CURRENT_Q1_BOUNDS, runtimeContracts: CURRENT_Q1_RUNTIME_CONTRACTS, corpus, corpusStructure };
  const admissions = structuredClone(admissionIdentities);
  const admissionSha256 = jsonSha(admissions);
  const previewDays = dates("2026-07-24", 70), publicDays = previewDays.slice(0, -1);
  const summary = () => ({ fitCount: 3, participantCount: 3, centralUsd: 10,
    band80Usd: { lowerUsd: 9, upperUsd: 11 } });
  const plans = [{ planType: "pro", label: "Pro 20x", multiplier: 1 },
    { planType: "prolite", label: "Pro 5x", multiplier: 4 },
    { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
    { planType: "plus", label: "Plus", multiplier: 20 }];
  const allowanceDays = previewDays.map((day) => ({ day, combined: summary(),
    byPlanType: Object.fromEntries(plans.map(({ planType }) => [planType, summary()])) }));
  const modelDays = previewDays.map((day) => projectAdminModelHistoryDay({ day,
    catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION, values: [["gpt-5.6-sol", 10, 1]],
    fittedParticipantCount: 1, unstableParticipantCount: 0, staleParticipantCount: 0,
    refusedParticipantCount: 1, v1ParticipantCount: 2, unsupportedSourceParticipantCount: 0 }));
  assert.ok(modelDays.every((day) => day !== null));
  const adminPreview = { schemaVersion: "admin-community-allowance-preview-v0.5",
    generatedAt: "2026-10-01T12:00:00.000Z", from: previewDays[0], to: previewDays.at(-1),
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25_preview", referencePlanType: "pro",
    trailingDays: 30, qualification: "shared_reset_fit_gates_25pp_span_floor", spanFloorPp: 25, plans,
    coverage: { uploadingParticipantCount: 4, cachedParticipantCount: 4, recentFittedParticipantCount: 3,
      mergeEligibleParticipantCount: 3, noQualifyingFitParticipantCount: 1, noRecentFitParticipantCount: 0,
      unsupportedPlanParticipantCount: 0 }, days: allowanceDays,
    models: { modelConfig: structuredClone(ADMIN_MODEL_CONFIG),
      basis: "seven_day_codex_pro20x_equivalent_per_model_composition_promax25",
      gate: "shared_composition_kernel_identification", days: modelDays } };
  const publicModels = [["gpt-6-astra", "astra"], ["gpt-6.1-sol", "sol"], ["gpt-6-sol", "sol"],
    ["gpt-6-luna", "luna"], ["gpt-5.6-terra", "terra"], ["gpt-5.6-sol", "sol"], ["gpt-5.6-luna", "luna"]];
  const body = { schemaVersion: "community-daily-read-v1.0", from: corpusIndex.window.fromDay,
    to: corpusIndex.window.throughDay, allowanceState: "ready", allowanceReadState: "confirmed",
    allowanceBreakdowns: { schemaVersion: "community-allowance-breakdowns-v1.5",
      basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25", referencePlanType: "pro",
      normalization: "pro_x1_prolite_x4_promax_x0_8_plus_x20",
      modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition_promax25",
      modelGate: "shared_composition_kernel_identification", generatedAt: adminPreview.generatedAt,
      days: publicDays.map((day, index) => ({ ...allowanceDays[index], models: modelDays[index].values })),
      modelConfig: publicModels.map(([id, family], order) =>
        ({ id, family, order, label: ADMIN_MODEL_CONFIG.find((model) => model.modelId === id).label })) },
    cacheRetention: { schemaVersion: "community-cache-retention-v1.0", metric: "cache_retention_by_pause",
      methodVersion: "cache-retention-v2", measures: "consecutive_requests", gapBasis: "response_end_to_response_end",
      windows: [{ window: "day", days: 1, bands: [{ band: "under_one_minute", startMs: 0, endMs: 60_000,
        sessions: 2, cachedTokens: 3 }] }, { window: "week", days: 7, bands: [] }] },
    days: expectedDailyDays.map((day) => servedDay(day, 1, {
      immutableRevision: true, recomputesOnLateData: true, policyVersion: "community-daily-v1.0",
      suppression: "none_daily_grain_by_owner_decision",
      totals: { contributingParticipants: 3, contributingDevices: 3, usageEvents: 3, quotaObservations: 1,
        sessionDimensions: 3, inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: 0 },
      cells: [{ provider: "openai_codex", modelId: "gpt-5.6-sol", usageEvents: 3,
        inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: 0 }],
      apiEquivalentSpend: { basis: "reported_usage_event_time_api_price_equivalent_v1", currency: "USD", knownCostUsd: 1.5,
        coverage: "complete", usageEvents: 3, fullyPricedUsageEvents: 3, partiallyPricedUsageEvents: 0,
        unpricedUsageEvents: 0, pricingMethodVersion: "server-api-price-equivalent-v0.6",
        registrySha256: "d57a7443bb43a756f1458872897dfcfcafdde0893433fc83b1036d58184de78d" },
    })) };
  const readiness = { state: "ready", reasons: [], expectedDailyDays, expectedPreviewDays: previewDays,
    expectedPublicAllowanceDays: publicDays };
  const snapshot = { publicResponse: { status: 200, body }, adminPreview, readiness };
  const syntheticConvergence = (collectionRevision) => ({ publishedDays: expectedDailyDays,
    retainedQueue: corpusStructure.conflictDays.map((day) => ({ day, revision: 1 })),
    conflictEvidence: corpusStructure.conflictDays.map((day) => ({ day, rows: 1, conflictRows: 1, sha256: "a".repeat(64) })),
    admissionSha256, sourceInvariantSha256: "c".repeat(64),
    fence: { authority: { sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle", publicAuthorityEpoch: 1,
      policyRevision: 1, collectionRevision, graphInvalidationEpoch: 1, sourceEpoch: 1, sequence: 1 },
      journalMax: 1, cursorSequence: 1, cursorReceipt: true, sourceTerminalEpoch: 0, deliveredTerminalEpoch: 0,
      pendingErasureJobs: 0, cacheIdle: true },
    selector: { filteredIdle: true, unfiltered: { state: "deferred", reason: "projection_pending", ownersAdvanced: 0,
      day: corpusStructure.conflictDays[0] } },
    dailyPasses: [false, true].map(() => ({ iterations: 171, outcomes: { published: 168, unchanged: 0, progress: 0, conflicts: 2 },
      filteredIdle: true })) });
  const reference = { schemaVersion: "current-q1-d1-reference-v2", synthetic: true, qualification: "complete",
    sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle", bounds: CURRENT_Q1_BOUNDS,
    provenance: { source, runtime, corpus, migrations, migrationSha256: jsonSha(migrations),
      runtimeContracts: CURRENT_Q1_RUNTIME_CONTRACTS, admissions, admissionSha256,
      cohort: [...corpusStructure.owners].sort((left, right) => left.participantId < right.participantId ? -1
        : left.participantId > right.participantId ? 1 : 0).map((owner) =>
        ({ participantId: owner.participantId, ownerDigest: owner.pinnedOwnerDigest })) },
    beforeForcedRecompute: structuredClone(snapshot), afterForcedRecompute: structuredClone(snapshot), afterNativeProbes: snapshot,
    // Explicit synthetic gate inputs, not an executed recomputation or refusal.
    recomputation: { schemaVersion: "current-q1-d1-recomputation-v1", actual: true,
      liveCohort: { members: 4, sha256: "d".repeat(64) },
      importSelection: { daily: expectedDailyDays.map((day) => ({ day, revision: 1, sha256: "e".repeat(64) })),
        modelDays: previewDays.map((day) => ({ day, sha256: "e".repeat(64) })), preview: { sha256: "f".repeat(64) } },
      dailyForced: expectedDailyDays.map((day) => ({ day, cohortDigest: "d".repeat(64), recomputedSha256: "e".repeat(64),
        importedSha256: "e".repeat(64), d1Drift: false })),
      graphForced: { modelDays: previewDays.map((day) => ({ day, recomputedSha256: "e".repeat(64) })),
        previewSha256: "f".repeat(64) },
      cacheRetention: { fromDay: null, resumeSeriesSha256: "a".repeat(64), rebuildSeriesSha256: "a".repeat(64),
        rebuildTableSha256: Object.fromEntries(["analytics_cache_retention_day_marks", "analytics_cache_retention_day_progress",
          "analytics_cache_retention_day_values", "analytics_cache_retention_day_bands", "analytics_cache_retention_day_carry"]
          .map((table) => [table, "b".repeat(64)])) },
      invocations: { daily: 342, graph: 30, cacheResume: 1, cacheRebuild: 1 },
      graphExecution: { state: "converged", reason: "quiet_rotation", iterations: 30, quiet: 30, rotation: 30 },
      controlTransition: { beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64), auditRowsBefore: 0, auditRowsAfter: 1,
        auditSequenceBefore: 0, auditSequenceAfter: 1 },
      collectionRevision: { before: 1, after: 2 }, sourceInvariantSha256: { before: "c".repeat(64), after: "c".repeat(64) } },
    corpusConvergence: { schemaVersion: "current-q1-d1-corpus-convergence-v1",
      beforeRecompute: syntheticConvergence(1), afterRecompute: syntheticConvergence(2) },
    strictExportRefusal: { schemaVersion: "current-q1-d1-strict-export-refusal-v1", actual: true,
      code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows"], queueRows: 2 },
    graphPublications: previewDays.map((day) => ({ day, state: "published", sha256: "e".repeat(64) })),
    // All 70 model scopes and the preview are present, so the exact missing-scope set is empty.
    nativeEvidence: [] };
  return { reference: structuredClone(reference), referenceBinding: structuredClone(referenceBinding), referenceSha256: jsonSha(reference), actual: structuredClone(body),
    actualPreview: structuredClone(adminPreview) };
}

test("current contract full equality accepts valid scheduling changes only", () => {
  const fixture = currentContractFixture();
  for (const day of fixture.actual.days) {
    day.revision = 7; day.releasedAt = "2026-10-02T12:00:00.000Z";
    day.payload.revision = 7; day.payload.releasedAt = day.releasedAt;
    day.payload.aggregateId = `community-daily:${day.day}:r7`;
  }
  const report = compareAnalyticsV2CurrentContract(fixture);
  assert.equal(report.schemaVersion, ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION);
  assert.equal(report.comparisonMode, "current-worker-d1");
  assert.equal(report.evidenceScope, "reference-comparison-only");
  assert.equal(report.establishesNativeExecution, false);
  assert.equal(report.referenceBound, true); assert.equal(report.referenceComplete, true);
  assert.equal(report.referenceSha256, fixture.referenceSha256);
  for (const field of ["recomputationComplete", "corpusConvergenceComplete", "strictExportRefusalVerified"]) {
    assert.equal(report[field], true, field);
  }
  for (const field of ["recomputation", "corpusConvergence", "strictExportRefusal"]) {
    assert.equal(report[`${field}Sha256`], jsonSha(fixture.reference[field]), field);
  }
  assert.equal(report.equal, true); assert.equal(report.unexpectedDiffs, 0);
  assert.ok(report.families.every((family) => family.expected === false && family.diffCount === 0));
});

test("consumer accepts admission identities captured by the current public builders", async () => {
  const fixture = currentContractFixture();
  const identities = await currentQ1PublicBuilderAdmissions();
  assert.equal(identities.length, 682);
  const extras = identities.filter((entry) => entry.format === "v1");
  assert.equal(extras.length, 2);
  const extraDescriptors = fixture.referenceBinding.corpusStructure.v1ExtraAdmissions.entries;
  assert.equal(extraDescriptors.length, extras.length);
  for (const descriptor of extraDescriptors) {
    const identity = extras.find((entry) => entry.participantId === descriptor.participantId
      && entry.day === descriptor.day);
    assert.ok(identity, "every captured v1 extra has an admission identity");
    assert.deepEqual({ participantId: identity.participantId, format: identity.format, day: identity.day,
      stream: identity.stream, records: identity.records, corpusRowsSha256: identity.corpusRowsSha256 },
    { participantId: descriptor.participantId, format: descriptor.format, day: descriptor.day,
      stream: descriptor.stream, records: descriptor.records, corpusRowsSha256: descriptor.corpusRowsSha256 });
  }
  fixture.referenceBinding.corpusStructure.admissionIdentities = structuredClone(identities);
  fixture.reference.provenance.admissions = structuredClone(identities);
  fixture.reference.provenance.admissionSha256 = jsonSha(identities);
  fixture.reference.corpusConvergence.beforeRecompute.admissionSha256 = jsonSha(identities);
  fixture.reference.corpusConvergence.afterRecompute.admissionSha256 = jsonSha(identities);
  fixture.referenceSha256 = jsonSha(fixture.reference);
  const completeness = assessCurrentQ1ReferenceCompleteness({ reference: fixture.reference,
    corpus: fixture.referenceBinding.corpusStructure, snapshotReadiness: {
      afterForcedRecompute: fixture.reference.afterForcedRecompute.readiness,
      afterNativeProbes: fixture.reference.afterNativeProbes.readiness,
    } });
  assert.deepEqual(completeness, { state: "complete", reasons: [] });
  const report = compareAnalyticsV2CurrentContract(fixture);
  assert.equal(report.referenceBound, true);
  assert.equal(report.referenceComplete, true);
});

test("current contract amounts, cache, metadata, models, refusals, order and omissions have no waiver", () => {
  const mutations = [
    (fixture) => { fixture.actual.days[0].payload.apiEquivalentSpend.knownCostUsd++; },
    (fixture) => { fixture.actual.cacheRetention.windows[0].bands[0].sessions++; },
    (fixture) => { fixture.actual.cacheRetention.windows[0].bands[0].cachedTokens++; },
    (fixture) => { fixture.actual.cacheRetention.windows.reverse(); },
    (fixture) => { fixture.actual.allowanceBreakdowns.modelConfig[0].label = "changed"; },
    (fixture) => { fixture.actual.allowanceBreakdowns.modelConfig.reverse(); },
    (fixture) => { fixture.actual.allowanceBreakdowns.days[0].models[0][1]++; },
    (fixture) => { fixture.actualPreview.models.days[0].refusedParticipantCount++; },
    (fixture) => { fixture.actualPreview.models.days[0].catalogVersion = "unknown"; },
    (fixture) => { fixture.actualPreview.models.modelConfig.pop(); },
    (fixture) => { fixture.actualPreview.plans.reverse(); },
    (fixture) => { fixture.actualPreview.days.reverse(); },
    (fixture) => { fixture.actual.days.reverse(); },
    (fixture) => { fixture.actual.days.pop(); },
    (fixture) => { fixture.actual.days.push(structuredClone(fixture.actual.days[0])); },
    (fixture) => { fixture.actual.allowanceBreakdowns.days[0].combined.band80Usd = null; },
    (fixture) => { delete fixture.actual.allowanceBreakdowns.days[0].combined.band80Usd; },
    (fixture) => { fixture.actual.extra = null; },
    (fixture) => { fixture.actualPreview.extra = null; },
    (fixture) => { delete fixture.actualPreview.models; },
    (fixture) => { fixture.actualPreview = null; },
    (fixture) => { fixture.actual.allowanceState = "updating"; },
    (fixture) => { fixture.actual.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.3"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = currentContractFixture(); mutate(fixture);
    const report = compareAnalyticsV2CurrentContract(fixture);
    assert.equal(report.equal, false, `mutation ${index}`);
    assert.ok(report.unexpectedDiffs > 0, `mutation ${index}`);
    assert.ok(report.families.every((family) => family.expected === false), `mutation ${index}`);
  }
});

test("current contract rejects malformed scheduling before normalization", () => {
  const mutations = [
    (day) => { delete day.revision; }, (day) => { delete day.releasedAt; },
    (day) => { day.revision = 0; }, (day) => { day.revision = 1.5; },
    (day) => { day.revision = Number.MAX_SAFE_INTEGER + 1; },
    (day) => { day.payload.revision = 2; }, (day) => { day.payload.day = "2026-09-30"; },
    (day) => { day.payload.aggregateId = `community-daily:${day.day}:r2`; },
    (day) => { day.payload.aggregateId += ":unreviewed"; },
    (day) => { delete day.payload.aggregateId; },
    (day) => { day.releasedAt = "2026-10-01T12:00:00Z"; day.payload.releasedAt = day.releasedAt; },
    (day) => { day.releasedAt = "not-a-date"; day.payload.releasedAt = day.releasedAt; },
    (day) => { day.payload.releasedAt = "2026-10-02T12:00:00.000Z"; },
    (day) => { day.payload = null; },
  ];
  for (const mutate of mutations) {
    const fixture = currentContractFixture(); mutate(fixture.actual.days[0]);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /ANALYTICS_V2_CURRENT_SCHEDULE_INVALID/u);
  }
});

test("current contract requires an independently preserved full reference digest", () => {
  for (const digest of [undefined, null, "", "z".repeat(64), "a".repeat(64)]) {
    const fixture = currentContractFixture(); fixture.referenceSha256 = digest;
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH/u);
  }
  for (const mutate of [
    (fixture) => { fixture.reference.afterNativeProbes.publicResponse.body.days[0].payload.apiEquivalentSpend.knownCostUsd++; },
    (fixture) => { fixture.reference.afterNativeProbes.adminPreview.models.days[0].values[0][1]++; },
  ]) {
    const fixture = currentContractFixture(); mutate(fixture);
    // Mutating the actual to agree cannot mint a new accepted producer digest.
    fixture.actual = structuredClone(fixture.reference.afterNativeProbes.publicResponse.body);
    fixture.actualPreview = structuredClone(fixture.reference.afterNativeProbes.adminPreview);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH/u);
  }
});

test("a caller-reminted saved reference digest establishes comparison only, never native execution", () => {
  const fixture = currentContractFixture();
  const acceptedProducerDigest = fixture.referenceSha256;
  fixture.reference.afterNativeProbes.publicResponse.body.days[0].payload.apiEquivalentSpend.knownCostUsd++;
  fixture.actual = structuredClone(fixture.reference.afterNativeProbes.publicResponse.body);
  assert.throws(() => compareAnalyticsV2CurrentContract({ ...fixture, referenceSha256: acceptedProducerDigest }),
    /ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH/u);

  // An untrusted saved-file caller can replace its own expectation. Equality
  // then describes only those files; no producer receipt has been established.
  fixture.referenceSha256 = jsonSha(fixture.reference);
  const report = compareAnalyticsV2CurrentContract(fixture);
  assert.equal(report.equal, true);
  assert.equal(report.evidenceScope, "reference-comparison-only");
  assert.equal(report.establishesNativeExecution, false);
  for (const field of ["nativeExecutionQualified", "nativeQualified", "producerNativeComplete", "nativeQualification", "gates"]) {
    assert.equal(Object.hasOwn(report, field), false, field);
  }
});

test("immutable Q-1 daily conservation rejects equally corrupted D1 and PG token totals", () => {
  const golden = JSON.parse(readFileSync(new URL("../analytics-v2-test/golden/community-daily-response.json", import.meta.url), "utf8"));
  const fixture = currentContractFixture();
  const { pricingMethodVersion, registrySha256 } = fixture.actual.days[0].payload.apiEquivalentSpend;
  // Only the current pricing metadata is carried across. Every retained day,
  // total, cell, identity and publication-policy field comes from immutable Q-1.
  const dailyRows = structuredClone(golden.days).map((day) => ({ ...day, payload: { ...day.payload,
    apiEquivalentSpend: { ...day.payload.apiEquivalentSpend, pricingMethodVersion, registrySha256 } } }));
  const snapshots = [fixture.reference.beforeForcedRecompute, fixture.reference.afterForcedRecompute,
    fixture.reference.afterNativeProbes];
  for (const snapshot of snapshots) snapshot.publicResponse.body.days = structuredClone(dailyRows);
  fixture.actual.days = structuredClone(dailyRows);
  fixture.referenceSha256 = jsonSha(fixture.reference);

  // The acceptance record is a pure gate-input double. This test invokes no
  // producer/controller, and establishes neither execution nor receipt durability.
  const producerAcceptance = { schemaVersion: "current-q1-d1-producer-acceptance-v2", accepted: true, referenceSha256: fixture.referenceSha256,
    actualHelperInvocation: true, resultReturnedAfterOwnedCleanup: true, cryptographicExecutionAttestation: false,
    ...Object.fromEntries(["recomputation", "corpusConvergence", "strictExportRefusal"]
      .map((field) => [`${field}Sha256`, jsonSha(fixture.reference[field])])) };
  const gates = () => rehearsalComparisonGates({ comparisonMode: "current-worker-d1", producerAcceptance,
    parity: compareAnalyticsV2Parity({ golden, actual: fixture.actual }),
    currentContractParity: compareAnalyticsV2CurrentContract(fixture) });
  assert.equal(compareAnalyticsV2CurrentContract(fixture).equal, true);
  assert.equal(gates().immutableCorpusDailyConserved, true);

  // Preserve internal cell-to-total conservation while both backends agree on
  // the same wrong token amount. A saved-reference caller can remint its digest.
  for (const body of [...snapshots.map((snapshot) => snapshot.publicResponse.body), fixture.actual]) {
    body.days[0].payload.totals.inputUncachedTokens++;
    body.days[0].payload.cells[0].inputUncachedTokens++;
  }
  fixture.referenceSha256 = jsonSha(fixture.reference);
  assert.equal(compareAnalyticsV2CurrentContract(fixture).equal, true);
  assert.equal(gates().currentWorkerD1Equality, false, "the old synthetic receipt cannot accept a changed reference");
  // Rebind only this declared pure gate-input double to exercise conservation
  // independently. This cannot mint or substitute an executed controller receipt.
  producerAcceptance.referenceSha256 = fixture.referenceSha256;
  const retained = compareAnalyticsV2Parity({ golden, actual: fixture.actual });
  for (const name of ["daily-totals", "daily-cells"]) {
    const family = retained.families.find((entry) => entry.family === name);
    assert.equal(family.compared, 168);
    assert.equal(family.diffCount, 1);
  }
  const failed = gates();
  assert.equal(failed.immutableCorpusDailyConserved, false);
  assert.equal(failed.currentWorkerD1Equality, true, "equality alone cannot establish conserved corpus semantics");
});

/** Reader-result doubles exercise orchestration classification only. The real
 * helper must obtain these through readStorageGraphResult's production fences. */
function nativeClassificationFixture(metric = "model") {
  const verified = { scope: { metric }, unsupportedSource: false,
    fits: metric === "fits" ? [{ capacityUsd: 10 }] : null,
    composition: metric === "model" ? { status: "ready", values: [["gpt-5.6-sol", 10, 1]] } : null };
  return { metric, verified, outcome: { state: "complete", result: structuredClone(verified), reused: false },
    knownNotTestableReasons: new Set(["downsampled_quota_limit_exceeded"]) };
}

test("native classification refuses missing, malformed, mismatched and nonqualifying reader evidence", () => {
  const mutations = [
    (input) => { delete input.metric; }, (input) => { input.metric = "unknown"; },
    (input) => { input.verified = null; input.outcome.result = null; },
    (input) => { input.verified = []; input.outcome.result = []; },
    (input) => { input.verified = {}; input.outcome.result = {}; },
    (input) => { input.outcome.result.composition.values[0][1]++; },
    (input) => { input.verified.unsupportedSource = true; input.outcome.result = structuredClone(input.verified); },
    (input) => { delete input.verified.scope; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.scope.metric = "fits"; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.fits = []; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition = null; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition = []; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition.status = "unknown"; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition = { status: "not_testable", reason: "unrecognized_reason" };
      input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition = { status: "not_testable" }; input.outcome.result = structuredClone(input.verified); },
    (input) => { input.verified.composition = { status: "not_testable", reason: "downsampled_quota_limit_exceeded" };
      input.outcome.result = structuredClone(input.verified); input.knownNotTestableReasons = ["downsampled_quota_limit_exceeded"]; },
    (input) => { delete input.outcome.reused; }, (input) => { input.outcome.reused = "false"; },
    (input) => { input.outcome.state = "deferred"; }, (input) => { input.outcome.state = "refused"; },
    (input) => { input.outcome = null; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = nativeClassificationFixture(); mutate(input);
    const result = classifyCurrentQ1VerifiedNativeOutcome(input);
    assert.equal(result.state, "unresolved", `mutation ${index}`);
    assert.equal(Object.hasOwn(result, "payloadSha256"), false, `mutation ${index}`);
    assert.equal(Object.hasOwn(result, "reused"), false, `mutation ${index}`);
  }
  const fits = nativeClassificationFixture("fits");
  fits.verified.fits = null; fits.outcome.result = structuredClone(fits.verified);
  assert.equal(classifyCurrentQ1VerifiedNativeOutcome(fits).state, "unresolved");
});

test("native classification retains verified fits, ready models and known not-testable evidence exactly", () => {
  for (const metric of ["fits", "model"]) {
    const input = nativeClassificationFixture(metric);
    input.outcome.reused = metric === "model";
    assert.deepEqual(classifyCurrentQ1VerifiedNativeOutcome(input), { state: "complete",
      computeOutcomeMatchesVerified: true, payloadSha256: jsonSha(input.verified), reused: input.outcome.reused });
  }
  const input = nativeClassificationFixture();
  input.verified.composition = { status: "not_testable", reason: "downsampled_quota_limit_exceeded" };
  input.outcome.result = structuredClone(input.verified);
  assert.deepEqual(classifyCurrentQ1VerifiedNativeOutcome(input), { state: "not_testable",
    reason: "downsampled_quota_limit_exceeded", computeOutcomeMatchesVerified: true,
    payloadSha256: jsonSha(input.verified), reused: false });
});

test("current contract refuses incomplete references even with self-consistent synthetic digests", () => {
  const mutations = [
    (reference) => { reference.qualification = "unresolved"; },
    (reference) => { reference.bounds.daily++; },
    (reference) => { reference.provenance.runtimeContracts.v1 = 2; },
    (reference) => { reference.provenance.admissions.pop(); },
    (reference) => { reference.provenance.admissions[0].privateField = "unexpected"; },
    (reference) => { reference.provenance.admissions.at(-1).corpusRowsSha256 = "0".repeat(64); },
    (reference) => { reference.provenance.cohort[0].privateOwnerKey = "a"; },
    (reference) => { delete reference.recomputation.graphExecution.quiet; },
    (reference) => { reference.recomputation.graphExecution.rotation++; },
    (reference) => { reference.recomputation.graphExecution.quiet--; },
    (reference) => { reference.nativeEvidence.push({ owner: "a", metric: "model", day: "2026-09-30", state: "complete",
      invocations: 1, computeOutcomeMatchesVerified: true, payloadSha256: "f".repeat(64), reused: false, privateField: "unexpected" }); },
    (reference) => { reference.provenance.cohort.pop(); },
    (reference) => { reference.provenance.cohort.push(structuredClone(reference.provenance.cohort[0])); },
    (reference) => { reference.recomputation.liveCohort.members = 3; },
    (reference) => { reference.recomputation.graphForced.modelDays.pop(); },
    (reference) => { reference.recomputation.graphForced.modelDays[0].recomputedSha256 = null; },
    (reference) => { reference.graphPublications.pop(); },
    (reference) => { reference.graphPublications[0].sha256 = "0".repeat(64); },
    (reference) => { reference.afterNativeProbes.readiness.reasons.push("current_cache_missing_or_mismatched"); },
    (reference) => { reference.afterForcedRecompute.readiness.state = "unresolved"; },
    (reference) => { reference.afterNativeProbes.publicResponse.body.days = []; },
    (reference) => { reference.afterNativeProbes.publicResponse.body.allowanceState = "updating"; },
    (reference) => { reference.afterNativeProbes.publicResponse.body.cacheRetention = null; },
    (reference) => { reference.afterNativeProbes.adminPreview.days.pop(); },
    (reference) => { reference.afterNativeProbes.adminPreview.models.days.push(
      structuredClone(reference.afterNativeProbes.adminPreview.models.days[0])); },
    (reference) => { reference.nativeEvidence.push({ owner: "a", metric: "model", day: "2026-07-24",
      state: "not_testable", reason: "unknown", invocations: 1, payloadSha256: "0".repeat(64),
      computeOutcomeMatchesVerified: true }); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = currentContractFixture(); mutate(fixture.reference);
    // Pure synthetic construction exercises structure after the digest gate;
    // it is not evidence of producer execution or permission to mint receipts.
    fixture.referenceSha256 = jsonSha(fixture.reference);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture),
      /(?:ANALYTICS_V2_CURRENT_REFERENCE_INCOMPLETE|CURRENT_Q1_REFERENCE_BINDING_INVALID)/u, `mutation ${index}`);
  }
});

test("current v2 refuses missing, tampered or fake quiescence evidence even when the saved digest is reminted", () => {
  const mutations = [
    (reference) => { delete reference.recomputation; },
    (reference) => { reference.recomputation.actual = false; },
    (reference) => { reference.recomputation.schemaVersion = "analytics-history-oracle-v2"; },
    (reference) => { reference.recomputation.quiescence = { queueRows: 0 }; },
    (reference) => { reference.oracle = structuredClone(reference.recomputation); delete reference.recomputation; },
    (reference) => { reference.oracle = { schema: "analytics-history-oracle-v2", quiescence: { queueRows: 0 } }; },
    (reference) => { reference.quiescence = { queueRows: 0 }; },
    (reference) => { delete reference.recomputation.invocations; },
    (reference) => { reference.recomputation.invocations.graph = 0; },
    (reference) => { reference.recomputation.invocations.daily++; },
    (reference) => { delete reference.recomputation.controlTransition; },
    (reference) => { reference.recomputation.controlTransition.auditRowsAfter++; },
    (reference) => { reference.recomputation.controlTransition.afterSha256 = reference.recomputation.controlTransition.beforeSha256; },
    (reference) => { reference.recomputation.dailyForced.pop(); },
    (reference) => { reference.recomputation.graphForced.previewSha256 = null; },
    (reference) => { reference.recomputation.cacheRetention.rebuildSeriesSha256 = "z".repeat(64); },
    (reference) => { reference.recomputation.sourceInvariantSha256.after = "0".repeat(64); },
    (reference) => { delete reference.corpusConvergence; },
    (reference) => { reference.corpusConvergence.schemaVersion = "unknown"; },
    (reference) => { reference.corpusConvergence.afterRecompute.publishedDays.pop(); },
    (reference) => { reference.corpusConvergence.beforeRecompute.retainedQueue.pop(); },
    (reference) => { reference.corpusConvergence.afterRecompute.conflictEvidence[0].conflictRows = 0; },
    (reference) => { reference.corpusConvergence.afterRecompute.conflictEvidence[0].sha256 = "0".repeat(64); },
    (reference) => { reference.corpusConvergence.beforeRecompute.fence.cursorReceipt = false; },
    (reference) => { reference.corpusConvergence.afterRecompute.fence.deliveredTerminalEpoch = -1; },
    (reference) => { reference.corpusConvergence.afterRecompute.fence.pendingErasureJobs = 1; },
    (reference) => { reference.corpusConvergence.afterRecompute.fence.cacheIdle = false; },
    (reference) => { reference.corpusConvergence.afterRecompute.selector.filteredIdle = false; },
    (reference) => { reference.corpusConvergence.afterRecompute.selector.unfiltered.state = "idle"; },
    (reference) => { reference.corpusConvergence.afterRecompute.selector.unfiltered.ownersAdvanced = 1; },
    (reference) => { reference.corpusConvergence.afterRecompute.dailyPasses.pop(); },
    (reference) => { reference.corpusConvergence.afterRecompute.dailyPasses[0].outcomes.conflicts = 0; },
    (reference) => { delete reference.strictExportRefusal; },
    (reference) => { reference.strictExportRefusal.actual = false; },
    (reference) => { reference.strictExportRefusal.code = "ANALYTICS_EXPORT_INTEGRITY_FAILED"; },
    (reference) => { reference.strictExportRefusal.reasons = []; },
    (reference) => { reference.strictExportRefusal.reasons.push("cursor_receipt"); },
    (reference) => { reference.strictExportRefusal.queueRows = 0; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = currentContractFixture(); mutate(fixture.reference);
    fixture.referenceSha256 = jsonSha(fixture.reference);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /ANALYTICS_V2_CURRENT_REFERENCE_INCOMPLETE/u,
      `v2 evidence mutation ${index}`);
  }
});

test("current v2 rejects v1 bindings and conflict-day tampering instead of adapting legacy oracle evidence", () => {
  for (const mutate of [
    (fixture) => { fixture.reference.schemaVersion = "current-q1-d1-reference-v1"; },
    (fixture) => { fixture.referenceBinding.schemaVersion = "current-q1-d1-reference-binding-v2"; },
    (fixture) => { delete fixture.referenceBinding.bounds; },
    (fixture) => { fixture.referenceBinding.runtimeContracts.v11 = 0; },
    (fixture) => { delete fixture.referenceBinding.corpusStructure.v1ExtraAdmissions; },
    (fixture) => { fixture.referenceBinding.corpusStructure.v1ExtraAdmissions.entries[0].records++; },
    (fixture) => { delete fixture.referenceBinding.corpusStructure.conflictDays; },
    (fixture) => { fixture.referenceBinding.corpusStructure.conflictDays.reverse(); },
    (fixture) => { fixture.referenceBinding.corpusStructure.conflictDays[0] = fixture.referenceBinding.corpusStructure.expectedDailyDays[0]; },
    (fixture) => { delete fixture.referenceBinding.corpusStructure.admissionIdentities; },
    (fixture) => { fixture.referenceBinding.corpusStructure.admissionIdentities[0].manifestDigest = "0".repeat(64); },
  ]) {
    const fixture = currentContractFixture(); mutate(fixture); fixture.referenceSha256 = jsonSha(fixture.reference);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /CURRENT_Q1_REFERENCE_BINDING_INVALID/u);
  }
});

test("current contract refuses reminted admission identities and their dependent hashes", () => {
  const mutations = [
    ["primary manifest digest", (admissions) => {
      admissions.find((entry) => entry.format === "v11").manifestDigest = jsonSha("reminted-primary-manifest");
    }],
    ["primary nested chunk digest", (admissions) => {
      const entry = admissions.find((candidate) => candidate.format === "v11");
      entry.chunks[0].chunkDigest = jsonSha("reminted-primary-chunk");
      entry.manifestDigest = jsonSha({ reminted: true, chunks: entry.chunks });
    }],
    ["v1 chunk digest", (admissions) => {
      admissions.find((entry) => entry.format === "v1").chunkDigest = jsonSha("reminted-v1-chunk");
    }],
    ["same-coordinate v1 row digest", (admissions) => {
      const entry = admissions.find((candidate) => candidate.format === "v1" && candidate.day === "2026-04-17");
      entry.corpusRowsSha256 = jsonSha("reminted-v1-source-rows");
      entry.chunkDigest = jsonSha("reminted-v1-chunk-for-new-rows");
    }],
    ["same-coordinate v1 stream and records", (admissions) => {
      const entry = admissions.find((candidate) => candidate.format === "v1" && candidate.day === "2026-04-17");
      entry.stream = "session";
      entry.records = 2;
      entry.corpusRowsSha256 = jsonSha("reminted-v1-session-rows");
      entry.chunkDigest = jsonSha("reminted-v1-session-chunk");
    }],
  ];
  const positive = currentContractFixture();
  const ownerA = corpusIndex.owners.find((owner) => owner.key === "a");
  const aprilExtra = v1ExtraAdmissionDescriptors().find((entry) => entry.ownerKey === "a"
    && entry.day === "2026-04-17" && entry.stream === "usage");
  const acceptedAprilAdmission = positive.reference.provenance.admissions.find((entry) => entry.format === "v1"
    && entry.participantId === ownerA.participantId && entry.day === "2026-04-17");
  assert.deepEqual({ ownerKey: "a", participantId: acceptedAprilAdmission.participantId,
    format: acceptedAprilAdmission.format, day: acceptedAprilAdmission.day, stream: acceptedAprilAdmission.stream,
    records: acceptedAprilAdmission.records, corpusRowsSha256: acceptedAprilAdmission.corpusRowsSha256 },
  { ...aprilExtra });
  assert.equal(compareAnalyticsV2CurrentContract(positive).referenceComplete, true,
    "the immutable owner-a April 17 conflict-day v1 usage extra is valid before mutation");
  for (const [name, mutate] of mutations) {
    const fixture = currentContractFixture();
    const admissions = fixture.reference.provenance.admissions;
    mutate(admissions);
    fixture.reference.provenance.admissionSha256 = jsonSha(admissions);
    fixture.referenceSha256 = jsonSha(fixture.reference);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /CURRENT_Q1_REFERENCE_BINDING_INVALID/u, name);
  }
});

test("a bounded unresolved graph run stays incomplete with all model-day publications and preview present", () => {
  const fixture = currentContractFixture();
  const reference = fixture.reference;
  assert.equal(reference.graphPublications.length, 70);
  assert.ok(reference.graphPublications.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));
  assert.equal(reference.recomputation.graphForced.modelDays.length, 70);
  assert.ok(reference.recomputation.graphForced.modelDays.every((entry) => /^[a-f0-9]{64}$/u.test(entry.recomputedSha256)));
  assert.match(reference.recomputation.graphForced.previewSha256, /^[a-f0-9]{64}$/u);
  assert.ok(reference.afterNativeProbes.adminPreview);

  reference.recomputation.invocations.graph = 17_920;
  reference.recomputation.graphExecution = { state: "unresolved", reason: "invocations", iterations: 17_920,
    quiet: 29, rotation: 30 };
  fixture.referenceSha256 = jsonSha(reference);
  const completeness = assessCurrentQ1ReferenceCompleteness({ reference, corpus: fixture.referenceBinding.corpusStructure,
    snapshotReadiness: { afterForcedRecompute: reference.afterForcedRecompute.readiness,
      afterNativeProbes: reference.afterNativeProbes.readiness } });
  assert.equal(completeness.state, "unresolved");
  assert.ok(completeness.reasons.includes("recomputation_not_converged"));
  assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /ANALYTICS_V2_CURRENT_REFERENCE_INCOMPLETE/u);
});

test("current v2 native evidence accepts only the closed complete, not-testable, unresolved and refused unions", () => {
  const expected = [{ owner: "a", metric: "model", day: "2026-09-30" }];
  const complete = { ...expected[0], state: "complete", invocations: 1, computeOutcomeMatchesVerified: true,
    payloadSha256: "a".repeat(64), reused: false };
  const notTestable = { ...expected[0], state: "not_testable", invocations: 1,
    reason: "supported_quota_track_unavailable", computeOutcomeMatchesVerified: true,
    payloadSha256: "b".repeat(64), reused: false };
  const unresolved = { ...expected[0], state: "unresolved", invocations: 1, reason: "d1_timeout", bound: "stall" };
  const refused = { ...expected[0], state: "refused", invocations: 1, nativeCapacityRefusal: false,
    reason: "d1_timeout", phase: "graph_scope" };
  for (const evidence of [complete, notTestable, unresolved, refused]) {
    assert.deepEqual(validateCurrentQ1NativeEvidence([evidence], expected), [evidence]);
  }
  assert.throws(() => validateCurrentQ1NativeEvidence([complete], [expected[0], { ...expected[0], owner: "b" }]),
    /CURRENT_Q1_REFERENCE_BINDING_INVALID/u, "a missing native scope is refused");
  assert.throws(() => validateCurrentQ1NativeEvidence([complete, { ...complete, owner: "b" }], expected),
    /CURRENT_Q1_REFERENCE_BINDING_INVALID/u, "an extra native scope is refused");
  assert.throws(() => validateCurrentQ1NativeEvidence([{ ...complete, day: "2026-10-01" }], expected),
    /CURRENT_Q1_REFERENCE_BINDING_INVALID/u, "a wrong-day native scope is refused");
  for (const evidence of [
    { ...complete, privatePayload: "unexpected" },
    { ...notTestable, metric: "fits" },
    { ...unresolved, privateField: true },
    { ...refused, nativeCapacityRefusal: true },
    { ...refused, phase: "unknown" },
  ]) assert.throws(() => validateCurrentQ1NativeEvidence([evidence], expected), /CURRENT_Q1_REFERENCE_BINDING_INVALID/u);

  const fixture = currentContractFixture();
  const missingDay = fixture.reference.recomputation.graphForced.modelDays[0].day;
  fixture.reference.recomputation.invocations.graph = 17_920;
  fixture.reference.recomputation.graphExecution = { state: "unresolved", reason: "invocations", iterations: 17_920,
    quiet: 29, rotation: 30 };
  fixture.reference.recomputation.graphForced.modelDays[0].recomputedSha256 = null;
  fixture.reference.graphPublications[0] = { day: missingDay, state: "not_published", sha256: null };
  fixture.reference.nativeEvidence = fixture.referenceBinding.corpusStructure.owners.map((owner) => ({ owner: owner.key,
    metric: "model", day: missingDay, state: "unresolved", invocations: 1, reason: "d1_timeout", bound: "stall" }));
  fixture.referenceSha256 = jsonSha(fixture.reference);
  const completeness = assessCurrentQ1ReferenceCompleteness({ reference: fixture.reference,
    corpus: fixture.referenceBinding.corpusStructure, snapshotReadiness: {
      afterForcedRecompute: fixture.reference.afterForcedRecompute.readiness,
      afterNativeProbes: fixture.reference.afterNativeProbes.readiness,
    } });
  assert.equal(completeness.state, "unresolved", "valid unresolved evidence cannot qualify the reference");
  assert.ok(completeness.reasons.includes("native_result_unverified"));
  assert.equal(completeness.reasons.includes("native_scope_set_incomplete"), false,
    "the exact unresolved evidence covers each expected owner/day scope");
});

test("current contract rejects source, ordered migrations, corpus and runtime binding changes", () => {
  const mutations = [
    (fixture) => { fixture.reference.provenance.source.head = "2".repeat(40); },
    (fixture) => { fixture.reference.provenance.source.files[0].sha256 = "0".repeat(64); },
    (fixture) => { fixture.reference.provenance.source.files.push(structuredClone(fixture.reference.provenance.source.files[0])); },
    (fixture) => { fixture.reference.provenance.migrations.reverse(); },
    (fixture) => { fixture.reference.provenance.migrations.pop(); },
    (fixture) => { fixture.reference.provenance.migrations.push(structuredClone(fixture.reference.provenance.migrations[0])); },
    (fixture) => { fixture.reference.provenance.runtime.version = "v22.16.0"; },
    (fixture) => { fixture.reference.provenance.runtime.binarySha256 = "0".repeat(64); },
    (fixture) => { fixture.reference.provenance.runtime.pinnedNowMs++; },
    (fixture) => { fixture.reference.provenance.runtime.randomSeed = "other"; },
    (fixture) => { fixture.reference.provenance.corpus.canonicalSha256 = "0".repeat(64); },
    (fixture) => { fixture.reference.provenance.corpus.recordCount--; },
    (fixture) => { fixture.reference.provenance.corpus.files.pop(); },
    (fixture) => { fixture.referenceBinding.corpusStructure.owners.pop(); },
    (fixture) => { fixture.referenceBinding.extra = true; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = currentContractFixture(); mutate(fixture); fixture.referenceSha256 = jsonSha(fixture.reference);
    assert.throws(() => compareAnalyticsV2CurrentContract(fixture), /CURRENT_Q1_REFERENCE_BINDING_INVALID/u,
      `mutation ${index}`);
  }
});

test("current contract counts every changed leaf while listing bounded diagnostics", () => {
  const fixture = currentContractFixture();
  for (const day of fixture.actual.days) day.payload.apiEquivalentSpend.knownCostUsd++;
  const report = compareAnalyticsV2CurrentContract(fixture);
  assert.equal(report.unexpectedDiffs, 168);
  assert.deepEqual(report.unexpectedFamilies, ["public-response"]);
  assert.equal(report.families[0].diffCount, 168);
  assert.equal(report.families[0].diffs.length, 40);
});

test("current comparison CLI exits 0 for equality, 1 for differences and 2 for invalid input", () => {
  const root = mkdtempSync(join(tmpdir(), "current-contract-compare-check-"));
  try {
    const fixture = currentContractFixture();
    for (const [name, value] of [["reference", fixture.reference], ["binding", fixture.referenceBinding],
      ["actual", fixture.actual], ["preview", fixture.actualPreview]]) {
      writeFileSync(join(root, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
    }
    const args = ["--comparison-mode", "current-worker-d1", "--current-reference", join(root, "reference.json"),
      "--current-reference-binding", join(root, "binding.json"), "--current-reference-sha256", fixture.referenceSha256,
      "--actual", join(root, "actual.json"), "--actual-preview", join(root, "preview.json")];
    const run = (argv) => spawnSync(process.execPath, [fileURLToPath(new URL("./analytics-v2-parity-compare.mjs", import.meta.url)),
      ...argv], { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
    const equal = run(args); assert.equal(equal.status, 0, equal.stderr);
    assert.equal(JSON.parse(equal.stdout).equal, true);
    fixture.actual.cacheRetention.windows[0].bands[0].sessions++;
    writeFileSync(join(root, "actual.json"), JSON.stringify(fixture.actual), { mode: 0o600 });
    const different = run(args); assert.equal(different.status, 1, different.stderr);
    assert.equal(JSON.parse(different.stdout).unexpectedDiffs, 1);
    const missing = run(args.slice(0, -2)); assert.equal(missing.status, 2);
    assert.match(missing.stderr, /ANALYTICS_V2_PARITY_ARGUMENTS_INVALID/u);
    writeFileSync(join(root, "reference.json"), "{}", { mode: 0o600 });
    const invalid = run(args); assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH/u);
    assert.equal(invalid.stdout, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
