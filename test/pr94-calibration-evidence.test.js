import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as quota from "../packages/quota-analysis/index.js";
import * as miner from "../src/codex-transition-miner.js";
import { buildPr94QuotaGroups, derivePr94BatchedTransitions } from "../scripts/lib/pr94-analysis-worker.mjs";
import {
  buildPr94CalibrationEvidence, comparePr94CalibrationEvidence,
  iteratePr94CalibrationPrivateFrames, importPr94CalibrationEvidence,
  disposePr94CalibrationEvidencePrivate,
} from "../scripts/lib/pr94-calibration-evidence.mjs";

// Synthetic inputs exercise the actual maintained policy, never private history.
// This export-only test hook does not replace any production function body.
const sourceUrl = new URL("../src/reporting/weekly-calibration.js?pr94-evidence-test", import.meta.url).href;
const hook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== sourceUrl) return loaded;
  return { ...loaded, source: `${loaded.source}\nexport { selectResetGroups, fitReset, uniquePoints, capacityFit, fitRelativeCentral80Width, isEligible, partitionKey, resetParentKey };\n` };
} });
let original;
try { original = await import(sourceUrl); } finally { hook.deregister(); }

const HMAC_KEY = new Uint8Array(32).fill(13);
const RESET = Date.parse("2026-08-31T00:00:00.000Z") / 1_000;
const SCOPE = { startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" };

async function policyVariant(label, replace) {
  const url = new URL(`../src/reporting/weekly-calibration.js?pr94-policy-${label}`, import.meta.url).href;
  const localHook = registerHooks({ load(path, context, nextLoad) {
    const loaded = nextLoad(path, context);
    if (path !== url) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const changed = replace(source);
    assert.notEqual(changed, source, "synthetic policy mutation must be exercised");
    return { ...loaded, source: `${changed}\nexport { selectResetGroups, fitReset, uniquePoints, capacityFit, fitRelativeCentral80Width, isEligible, partitionKey, resetParentKey };\n` };
  } });
  try { return await import(url); } finally { localHook.deregister(); }
}

function rows({ planType = "pro", reset = RESET, era = "era-one", count = 12, offset = 0, slot = "primary", percentStep = 1, costStep = 10 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const time = Date.parse("2026-08-25T00:00:00.000Z") + (index + offset) * 3_600_000;
    return {
      accountScopeId: "unattributed", provider: "openai_codex", planType, planVariant: "unknown", planEraKey: era,
      aggregationEligibility: "primary_conditional", limitId: "codex", slot, windowDurationMins: 10_080, resetsAt: reset,
      eventTime: new Date(time + 3_600_000).toISOString(), lastPriorObservedAt: new Date(time).toISOString(),
      firstNextObservedAt: new Date(time + 3_600_000).toISOString(),
      priorUsedPercent: index * percentStep, nextUsedPercent: (index + 1) * percentStep,
      lastPriorCumulativeApiPricedUsd: index * costStep, firstNextCumulativeApiPricedUsd: (index + 1) * costStep,
      lastPriorCumulativeQuotaWeightedLowerUsd: index * costStep,
      firstNextCumulativeQuotaWeightedLowerUsd: (index + 1) * costStep,
      lastPriorCumulativeQuotaWeightedUpperUsd: index * costStep * 2,
      firstNextCumulativeQuotaWeightedUpperUsd: (index + 1) * costStep * 2,
      marginalUsageEventCount: 1, quality: { localCoverage: { elapsedTimeCoverageFraction: 1 }, pricingWarnings: [], attributionWarnings: [] },
    };
  });
}

function rawParent(first, overrides = {}) {
  return { accountScopeId: first.accountScopeId, provider: first.provider, planType: first.planType, limitId: first.limitId,
    windowDurationMins: first.windowDurationMins, resetsAt: first.resetsAt, snapshotCount: 13,
    uniqueSnapshotCount: 13, distinctPercentCount: 13, matchedSnapshotCount: 13, conflictedSnapshotCount: 0,
    unavailableSnapshotCount: 0, matchedUniqueSnapshotCount: 13, matchedDistinctPercentCount: 13, ...overrides };
}

function evidence(transitions = rows(), overrides = {}) {
  return buildPr94CalibrationEvidence({ internals: original, analyzeWeeklyCalibration: original.analyzeWeeklyCalibration,
    candidates: original.CANDIDATES, transitions, rawParents: [rawParent(transitions[0] ?? rows()[0])],
    revisionKind: "final", hmacKey: HMAC_KEY, scope: SCOPE, selectedPlanType: "pro", ...overrides });
}

function candidate(result, id = "standard_api") { return result.candidates.find((item) => item.candidateId === id); }
function frames(result) { return [...iteratePr94CalibrationPrivateFrames(result)]; }
function isCode(code) { return (error) => error.code === code && error.message === code; }

test("PR94 evidence reuses exact original fits and returns no raw identities or timestamps", () => {
  const transitions = rows().map((row) => ({ ...row, accountScopeId: "private-account-marker", planEraKey: "private-era-marker" }));
  const result = evidence(transitions);
  assert.equal(result.status, "pass");
  assert.equal(result.counts.rawParents, 1);
  assert.equal(result.counts.parentCandidates, 4);
  assert.equal(result.counts.knownAccountParents, 1);
  assert.equal(candidate(result).outcomes.selected_plan_primary, 1);
  assert.equal(candidate(result).primary.count, 1);
  assert.ok(candidate(result).primary.median > 0);
  assert.ok(Object.isFrozen(result.candidates[0].outcomes));
  assert.doesNotMatch(JSON.stringify(result), /private-account-marker|private-era-marker|2026-|parentKey|fragmentKey|inputDigest/);
  assert.equal(comparePr94CalibrationEvidence(result, result).identicalFitInputsCompared, 4);
});

test("PR94 evidence keeps one parent/candidate with primary and losing qualifying fragments", () => {
  const transitions = [...rows({ era: "a", count: 12 }), ...rows({ era: "b", count: 9, offset: 20 })];
  const result = evidence(transitions);
  assert.equal(result.counts.rawParents, 1);
  for (const item of result.candidates) {
    assert.equal(item.parentCandidates, 1);
    assert.equal(item.outcomes.selected_plan_primary, 1);
    assert.equal(item.outcomes.losing_qualifying_fragment, 1);
    assert.equal(item.diagnostic.count, 1);
  }
  assert.equal(frames(result)[0].fragments.length, 2);
  const compared = comparePr94CalibrationEvidence(evidence(rows()), result);
  assert.equal(compared.baselinePrimaryFits, 4);
  assert.equal(compared.retainedPrimaryFits, 4);
  assert.equal(compared.lostPrimaryFits, 0);
  assert.equal(compared.newPrimaryFits, 0);
  assert.equal(compared.changedOutcomeParentCandidates, 4);
  assert.equal(compared.requiresCoverageReview, true);
  assert.ok(compared.primaryOutcomeMatrix.every((cell) => cell.transition === "retained_primary"
    && cell.afterOutcomes.some((item) => item.outcome === "losing_qualifying_fragment" && item.count === 1)
    && cell.afterOutcomes.some((item) => item.outcome === "selected_plan_primary" && item.count === 1)));
});

test("PR94 evidence retains alternate-plan primaries and raw plan populations", () => {
  const pro = rows();
  const plus = rows({ planType: "plus", costStep: 20 });
  const result = evidence([...pro, ...plus], { rawParents: [rawParent(pro[0]), rawParent(plus[0])] });
  assert.deepEqual(result.plans.map((item) => item.planType), ["plus", "pro"]);
  assert.equal(candidate(result).outcomes.selected_plan_primary, 1);
  assert.equal(candidate(result).outcomes.alternate_plan_primary, 1);
});

test("PR94 comparison uses canonical lexical ordering for mixed plans and outcome signatures", (t) => {
  const parents = [];
  const transitions = [];
  const add = (items) => { parents.push(rawParent(items[0])); transitions.push(...items); };
  for (const planType of ["plus", "pro", "pro_lite", "unknown"]) add(rows({ planType }));
  for (const fragments of [1, 10]) {
    add(Array.from({ length: fragments }, (_, index) => rows({ era: `diagnostic-${index}`, count: 2, offset: index * 3 })
      .map((row) => ({ ...row, accountScopeId: `synthetic-${fragments}`, aggregationEligibility: "diagnostic_only" }))).flat());
  }
  add([...rows({ era: "diagnostic", count: 2 }).map((row) => ({ ...row, aggregationEligibility: "diagnostic_only" })),
    ...rows({ era: "short", count: 4, offset: 4 })].map((row) => ({ ...row, accountScopeId: "synthetic-mixed" })));
  const result = evidence(transitions, { rawParents: parents });
  t.after(() => disposePr94CalibrationEvidencePrivate(result));
  assert.equal(result.status, "pass");
  const compared = comparePr94CalibrationEvidence(result, result);
  assert.equal(compared.status, "pass");
  const keys = compared.primaryOutcomeMatrix.map((cell) => JSON.stringify([
    cell.candidateId, cell.planType, cell.accountKnown, cell.transition, cell.afterOutcomes,
  ]));
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(compared.primaryOutcomeMatrix.some((cell) => cell.afterOutcomes.some((item) => item.count === 10)));
  assert.ok(compared.primaryOutcomeMatrix.some((cell) => cell.afterOutcomes.length > 1));
  for (const cell of compared.primaryOutcomeMatrix) {
    const outcomes = cell.afterOutcomes.map((item) => item.outcome);
    assert.deepEqual(outcomes, [...outcomes].sort());
  }
});

test("PR94 evidence preserves unknown and novel plans without publishing arbitrary labels", () => {
  const a = rows({ planType: "private-plan-a" });
  const b = rows({ planType: "private-plan-b", costStep: 20 });
  const result = evidence([...a, ...b], { rawParents: [rawParent(a[0]), rawParent(b[0])] });
  assert.deepEqual(result.plans.map((item) => item.planType), ["other"]);
  assert.equal(candidate(result).primary.count, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-plan/);
});

test("PR94 evidence names unchanged production rejection gates with null empty distributions", () => {
  const short = evidence(rows({ count: 4 }));
  assert.equal(candidate(short).outcomes.insufficient_unique_boundaries, 1);
  assert.deepEqual(candidate(short).primary, { count: 0, median: null, central80: { lower: null, upper: null } });
  const narrow = evidence(rows({ percentStep: 0.1 }));
  assert.equal(candidate(narrow).outcomes.insufficient_percent_span, 1);
  const flat = evidence(rows({ costStep: 0 }));
  assert.equal(candidate(flat).outcomes.training_capacity_unavailable, 1);
});

test("PR94 evidence distinguishes attribution diagnostic-only from other row exclusions", () => {
  const diagnostic = rows().map((row) => ({ ...row, aggregationEligibility: "diagnostic_only" }));
  const result = evidence(diagnostic);
  assert.equal(result.rowReasons.aggregation_diagnostic_only, diagnostic.length);
  assert.equal(candidate(result).outcomes.aggregation_diagnostic_only, 1);
  const pricing = rows().map((row) => ({ ...row, quality: { ...row.quality, pricingWarnings: ["unpriced_component"] } }));
  assert.equal(evidence(pricing).rowReasons.pricing_warning, pricing.length);
});

test("PR94 evidence reconciles simultaneous slot, near-duplicate and overlap suppression", () => {
  const primary = rows();
  const simultaneous = evidence([...primary, ...rows({ slot: "secondary" })]);
  assert.equal(candidate(simultaneous).outcomes.simultaneous_slot_conflict, 1);
  const duplicate = rows({ reset: RESET + 1, count: 8 });
  const dupResult = evidence([...primary, ...duplicate], { rawParents: [rawParent(primary[0]), rawParent(duplicate[0])] });
  assert.equal(candidate(dupResult).outcomes.near_duplicate_reset_identity_with_less_evidence, 1);
  const overlap = rows({ reset: RESET + 10, count: 8 });
  const overlapResult = evidence([...primary, ...overlap], { rawParents: [rawParent(primary[0]), rawParent(overlap[0])] });
  assert.equal(candidate(overlapResult).outcomes.overlapping_observation_window, 1);
});

test("PR94 zero-transition parents require demonstrated reasons; ambiguous disappearance fails", () => {
  const base = rawParent(rows()[0]);
  const unchanged = evidence([], { rawParents: [{ ...base, distinctPercentCount: 1, matchedDistinctPercentCount: 1 }] });
  assert.equal(candidate(unchanged).outcomes.no_percent_change, 1);
  const insufficient = evidence([], { rawParents: [{ ...base, snapshotCount: 1, uniqueSnapshotCount: 1, distinctPercentCount: 1,
    matchedSnapshotCount: 1, matchedUniqueSnapshotCount: 1, matchedDistinctPercentCount: 1 }] });
  assert.equal(candidate(insufficient).outcomes.insufficient_snapshots, 1);
  const withheld = evidence([], { rawParents: [{ ...base, matchedSnapshotCount: 0, unavailableSnapshotCount: 13,
    matchedUniqueSnapshotCount: 0, matchedDistinctPercentCount: 0 }] });
  assert.equal(candidate(withheld).outcomes.all_snapshot_attribution_withheld, 1);
  const unexplained = evidence([], { rawParents: [base] });
  assert.equal(unexplained.status, "fail");
  assert.equal(unexplained.counts.unexplainedParents, 1);
  assert.equal(comparePr94CalibrationEvidence(unexplained, unexplained).status, "fail");
});

test("PR94 original miner proves no within-era percentage change across a Pro Plus Pro switch", async (t) => {
  const start = Date.parse("2026-08-25T00:00:00.000Z");
  const snapshot = (hour, percent, planType = "pro", duration = 10_080) => ({
    timestamp: new Date(start + hour * 3_600_000).toISOString(), timestampMs: start + hour * 3_600_000,
    window: { provider: "openai_codex", planType, limitId: "codex", slot: "primary",
      windowDurationMins: duration, resetsAt: RESET, usedPercent: percent },
  });
  const snapshots = [snapshot(0, 0), snapshot(1, 0), snapshot(2, 0, "plus", 300), snapshot(3, 1), snapshot(4, 1)];
  const grouped = buildPr94QuotaGroups(snapshots, { quota, revisionKind: "final" });
  const unsupported = evidence([], { rawParents: grouped.rawParents });
  t.after(() => disposePr94CalibrationEvidencePrivate(unsupported));
  assert.equal(unsupported.status, "fail");
  assert.equal(candidate(unsupported).outcomes.unexplained_no_transition, 1);
  const derived = await derivePr94BatchedTransitions({ modules: { miner }, usage: [], grouped,
    startAt: SCOPE.startAt, endAt: SCOPE.endAt });
  assert.deepEqual(derived.transitions, []);
  assert.deepEqual(grouped.rawParents[0].derivationEvidence, {
    groupCount: 2, snapshotCount: 4, transitionCount: 0, zeroTransitionGroupCount: 2,
  });
  const explained = evidence(derived.transitions, { rawParents: grouped.rawParents });
  t.after(() => disposePr94CalibrationEvidencePrivate(explained));
  assert.equal(explained.status, "pass");
  assert.equal(explained.counts.unexplainedParents, 0);
  assert.ok(explained.candidates.every((item) => item.outcomes.no_within_era_percent_change === 1));
  const compared = comparePr94CalibrationEvidence(explained, explained);
  assert.ok(compared.primaryOutcomeMatrix.every((cell) => cell.afterOutcomes[0].outcome === "no_within_era_percent_change"));
  assert.doesNotMatch(JSON.stringify(explained), /eraKey|2026-|resetsAt|derivationEvidence/);
});

test("PR94 refuses unsupported, inconsistent or positive derivation summaries for an empty parent", () => {
  const raw = rawParent(rows()[0]);
  const valid = { groupCount: 2, snapshotCount: 13, transitionCount: 0, zeroTransitionGroupCount: 2 };
  const mutations = [
    { ...valid, extra: 1 }, { ...valid, snapshotCount: 12 }, { ...valid, groupCount: 14 },
    { ...valid, groupCount: 0 }, { ...valid, zeroTransitionGroupCount: 1 },
    { ...valid, transitionCount: 1, zeroTransitionGroupCount: 1 },
    { ...valid, transitionCount: Number.MAX_SAFE_INTEGER },
  ];
  for (const derivationEvidence of mutations) {
    assert.throws(() => evidence([], { rawParents: [{ ...raw, derivationEvidence }] }),
      isCode("pr94_calibration_snapshot_partition_invalid"));
  }
  const single = evidence([], { rawParents: [{ ...raw, derivationEvidence: { ...valid, groupCount: 1, zeroTransitionGroupCount: 1 } }] });
  assert.equal(single.status, "fail");
  assert.equal(candidate(single).outcomes.unexplained_no_transition, 1);
  disposePr94CalibrationEvidencePrivate(single);
});

test("PR94 rejects incompatible raw snapshot partitions and unknown transition parents", () => {
  assert.throws(() => evidence([], { rawParents: [rawParent(rows()[0], { matchedSnapshotCount: 12 })] }), isCode("pr94_calibration_snapshot_partition_invalid"));
  assert.throws(() => evidence(rows(), { rawParents: [] }), isCode("pr94_calibration_transition_parent_missing"));
  const raw = rawParent(rows()[0]);
  assert.throws(() => evidence(rows(), { rawParents: [raw, raw] }), isCode("pr94_calibration_duplicate_parent"));
});

test("PR94 refuses source-policy drift and reporter disagreement rather than approximating", () => {
  assert.throws(() => evidence(rows(), { internals: { ...original, fitReset() { return null; } } }), isCode("pr94_calibration_fit_source_unrecognized"));
  const changed = (dataset, options) => {
    const report = original.analyzeWeeklyCalibration(dataset, options);
    if (report.resetValues[0]) report.resetValues[0].apiPriceEquivalentUsd += 1;
    return report;
  };
  assert.throws(() => evidence(rows(), { analyzeWeeklyCalibration: changed }), isCode("pr94_calibration_report_fit_mismatch"));
});

test("PR94 private transport is sealed, bounded, closed and independently importable", async () => {
  const originalEvidence = evidence();
  const imported = await importPr94CalibrationEvidence({ aggregate: JSON.parse(JSON.stringify(originalEvidence)), frames: frames(originalEvidence), hmacKey: HMAC_KEY });
  assert.deepEqual(imported, originalEvidence);
  assert.equal(comparePr94CalibrationEvidence(originalEvidence, imported).status, "pass");
  const changed = frames(originalEvidence);
  changed[0].fragments[0].capacity += 1;
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: originalEvidence, frames: changed, hmacKey: HMAC_KEY }), isCode("pr94_calibration_seal_invalid"));
  const foreign = frames(originalEvidence);
  foreign[0].rawAccount = "should-never-appear";
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: originalEvidence, frames: foreign, hmacKey: HMAC_KEY }), isCode("pr94_calibration_private_frames_invalid"));
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: originalEvidence, frames: frames(originalEvidence), hmacKey: new Uint8Array(32).fill(9) }), isCode("pr94_calibration_seal_invalid"));
  assert.throws(() => comparePr94CalibrationEvidence(structuredClone(originalEvidence), originalEvidence), isCode("pr94_calibration_evidence_untrusted"));
});

test("PR94 imports async private streams and rejects truncation, additions and duplicate records", async () => {
  const result = evidence();
  async function* stream(items) { for (const item of items) yield item; }
  const imported = await importPr94CalibrationEvidence({ aggregate: result, frames: stream(frames(result)), hmacKey: HMAC_KEY });
  assert.equal(comparePr94CalibrationEvidence(result, imported).status, "pass");
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: result, frames: stream(frames(result).slice(0, -1)), hmacKey: HMAC_KEY }),
    (error) => ["pr94_calibration_parent_candidate_missing", "pr94_calibration_seal_invalid"].includes(error.code));
  const duplicates = frames(result);
  duplicates.splice(1, 0, structuredClone(duplicates[0]));
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: result, frames: stream(duplicates), hmacKey: HMAC_KEY }),
    isCode("pr94_calibration_parent_multiplied"));
  const trailing = [...frames(result), { kind: "seal", digest: "0".repeat(64) }];
  await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: result, frames: stream(trailing), hmacKey: HMAC_KEY }),
    isCode("pr94_calibration_private_frames_invalid"));
});

test("PR94 fit rejection classifies insufficient training pairs using original helper results", () => {
  const cost = [0, 0, 0, 1, 1, 1, 1];
  const transitions = rows({ count: 7 }).map((row, index) => ({ ...row,
    lastPriorCumulativeApiPricedUsd: cost[index], firstNextCumulativeApiPricedUsd: cost[index],
  }));
  assert.equal(candidate(evidence(transitions)).outcomes.insufficient_training_pairs, 1);
});

test("PR94 selected population and unchanged inputs cannot be silently relabelled", () => {
  const transitions = rows({ planType: "unknown" });
  const result = evidence(transitions, { selectedPlanType: "unknown" });
  assert.equal(result.counts.unknownAccountParents, 1);
  assert.equal(candidate(result).outcomes.selected_plan_primary, 1);
  const selectedMissing = evidence(rows(), { selectedPlanType: null });
  assert.equal(candidate(selectedMissing).outcomes.unselected_plan_primary, 1);
  const differentPopulation = comparePr94CalibrationEvidence(evidence(rows()), selectedMissing);
  assert.equal(differentPopulation.status, "fail");
  assert.equal(differentPopulation.selectedPopulationMatches, false);
  assert.throws(() => comparePr94CalibrationEvidence(result, evidence(transitions, { hmacKey: new Uint8Array(64).fill(13) })),
    isCode("pr94_calibration_evidence_untrusted"));
});

test("PR94 comparison refuses changed raw-parent inventory despite identical fitted transitions", () => {
  const transitions = rows();
  const result = evidence(transitions);
  const changed = evidence(transitions, { rawParents: [rawParent(transitions[0], { snapshotCount: 14, matchedSnapshotCount: 14 })] });
  const compared = comparePr94CalibrationEvidence(result, changed);
  assert.equal(compared.changedRawParentInventory, 4);
  assert.equal(compared.status, "fail");
});

test("PR94 comparison detects missing raw parent/candidate records without exposing identity", () => {
  const one = rows();
  const two = rows({ reset: RESET + 604_800, offset: 168 });
  const before = evidence([...one, ...two], { rawParents: [rawParent(one[0]), rawParent(two[0])] });
  const after = evidence(one);
  const compared = comparePr94CalibrationEvidence(before, after);
  assert.equal(compared.status, "fail");
  assert.equal(compared.missingParentCandidates, 4);
  assert.equal(compared.reconciledParentCandidates, 4);
  assert.equal(compared.baselinePrimaryFits, 8);
  assert.equal(compared.retainedPrimaryFits, 4);
  assert.equal(compared.lostPrimaryFits, 4);
  assert.equal(compared.unexplainedPrimaryLosses, 4);
  assert.equal(compared.primaryOutcomeMatrix.filter((cell) => cell.transition === "missing_parent")
    .reduce((sum, cell) => sum + cell.baselinePrimaryFits, 0), 4);
  assert.doesNotMatch(JSON.stringify(compared), /[a-f0-9]{64}|2026-|reset/);
});

test("PR94 comparison accounts for every retained, lost and new primary without a loss tolerance", () => {
  const full = evidence();
  const short = evidence(rows({ count: 4 }));
  const unchanged = comparePr94CalibrationEvidence(full, full);
  assert.equal(unchanged.schemaVersion, "pr94-calibration-comparison-v2");
  assert.equal(unchanged.requiresCoverageReview, false);
  assert.equal(unchanged.retainedPrimaryFits, 4);
  const lost = comparePr94CalibrationEvidence(full, short);
  assert.equal(lost.status, "pass"); // Explained numerical reduction, NOT automatic coverage sign-off.
  assert.equal(lost.requiresCoverageReview, true);
  assert.equal(lost.baselinePrimaryFits, 4);
  assert.equal(lost.retainedPrimaryFits, 0);
  assert.equal(lost.lostPrimaryFits, 4);
  assert.equal(lost.changedInputPrimaryLosses, 4);
  assert.equal(lost.unexplainedPrimaryLosses, 0);
  assert.ok(lost.primaryOutcomeMatrix.every((cell) => cell.transition === "lost_primary"
    && cell.parentCandidates === 1 && cell.baselinePrimaryFits === 1 && cell.afterPrimaryFits === 0
    && cell.changedInputPrimaryLosses === 1
    && JSON.stringify(cell.afterOutcomes) === JSON.stringify([{ outcome: "insufficient_unique_boundaries", count: 1 }])));
  const gained = comparePr94CalibrationEvidence(short, full);
  assert.equal(gained.newPrimaryFits, 4);
  assert.equal(gained.lostPrimaryFits, 0);
  assert.equal(gained.requiresCoverageReview, true);
  assert.ok(gained.primaryOutcomeMatrix.every((cell) => cell.transition === "new_primary"));
  const empty = comparePr94CalibrationEvidence(short, short);
  assert.ok(empty.primaryOutcomeMatrix.every((cell) => cell.transition === "no_primary"));
  assert.equal(empty.requiresCoverageReview, false);
  const repricedInputs = comparePr94CalibrationEvidence(full, evidence(rows({ costStep: 20 })));
  assert.equal(repricedInputs.status, "pass");
  assert.equal(repricedInputs.lostPrimaryFits, 0);
  assert.equal(repricedInputs.newPrimaryFits, 0);
  assert.equal(repricedInputs.retainedPrimaryInputChanges, 4);
  assert.equal(repricedInputs.requiresCoverageReview, true);
});

test("PR94 primary loss matrix preserves attribution withholding and original suppression reasons", () => {
  const full = evidence();
  const diagnostic = evidence(rows().map((row) => ({ ...row, aggregationEligibility: "diagnostic_only" })));
  const withheld = evidence([], { rawParents: [rawParent(rows()[0], { matchedSnapshotCount: 0,
    matchedUniqueSnapshotCount: 0, matchedDistinctPercentCount: 0, unavailableSnapshotCount: 13 })] });
  for (const [after, expected] of [[diagnostic, "aggregation_diagnostic_only"], [withheld, "all_snapshot_attribution_withheld"]]) {
    const compared = comparePr94CalibrationEvidence(full, after);
    assert.equal(compared.status, "pass");
    assert.equal(compared.lostPrimaryFits, 4);
    assert.equal(compared.requiresCoverageReview, true);
    assert.ok(compared.primaryOutcomeMatrix.every((cell) => cell.afterOutcomes.length === 1
      && cell.afterOutcomes[0].outcome === expected && cell.afterOutcomes[0].count === 1));
  }
  const first = rows();
  const second = rows({ reset: RESET + 10, count: 8, offset: 30 });
  const rawParents = [rawParent(first[0]), rawParent(second[0])];
  const before = evidence([...first, ...second], { rawParents });
  const after = evidence([...first, ...rows({ reset: RESET + 10, count: 8 })], { rawParents });
  const compared = comparePr94CalibrationEvidence(before, after);
  assert.equal(compared.status, "pass");
  assert.equal(compared.lostPrimaryFits, 4);
  assert.equal(compared.retainedPrimaryFits, 4);
  assert.equal(compared.changedInputPrimaryLosses, 0);
  assert.ok(compared.primaryOutcomeMatrix.filter((cell) => cell.transition === "lost_primary")
    .every((cell) => cell.afterOutcomes[0].outcome === "overlapping_observation_window"));
});

test("PR94 comparison fails an identical-point fit rejection instead of silently counting parent presence", async () => {
  const variant = await policyVariant("reject-capacity", (source) => source.replace(
    "function capacityFit(points) {", "function capacityFit(points) { return { capacityUsd: null, pairCount: 0 };"));
  const before = evidence();
  const after = evidence(rows(), { internals: variant, analyzeWeeklyCalibration: variant.analyzeWeeklyCalibration });
  assert.equal(after.status, "pass");
  const compared = comparePr94CalibrationEvidence(before, after);
  assert.equal(compared.status, "fail");
  assert.equal(compared.reconciledParentCandidates, 4);
  assert.equal(compared.rejectedIdenticalInputFits, 4);
  assert.equal(compared.lostPrimaryFits, 4);
  assert.equal(compared.unexplainedPrimaryLosses, 4);
  assert.equal(compared.changedInputPrimaryLosses, 0);
});

test("PR94 unknown-account independence executes actual original fits and reports its limited scope", async () => {
  const result = evidence();
  assert.equal(result.schemaVersion, "pr94-calibration-evidence-v2");
  assert.deepEqual(result.unknownAccountCheck, { scope: "original_fit_gate_only", fragmentCandidatesChecked: 4,
    rowsChecked: 48, changedEligibilityRows: 0, changedPointSets: 0, changedFits: 0, unknownOnlyFitExclusions: 0 });
  const known = evidence(rows().map((row) => ({ ...row, accountScopeId: "synthetic-known" })));
  assert.equal(known.unknownAccountCheck.rowsChecked, 0);
  assert.equal(known.unknownAccountCheck.fragmentCandidatesChecked, 0);
  const variant = await policyVariant("unknown-account-excluded", (source) => source.replace(
    'const ordered = [...rows].filter(isEligible).sort((left, right) => left.eventTime.localeCompare(right.eventTime));',
    'const ordered = [...rows].filter(isEligible).filter((row) => row.accountScopeId !== "unattributed").sort((left, right) => left.eventTime.localeCompare(right.eventTime));'));
  const rejected = evidence(rows(), { internals: variant, analyzeWeeklyCalibration: variant.analyzeWeeklyCalibration });
  assert.equal(rejected.status, "fail");
  assert.equal(rejected.unknownAccountCheck.fragmentCandidatesChecked, 4);
  assert.equal(rejected.unknownAccountCheck.rowsChecked, 48);
  assert.equal(rejected.unknownAccountCheck.changedPointSets, 4);
  assert.equal(rejected.unknownAccountCheck.changedFits, 4);
  assert.equal(rejected.unknownAccountCheck.unknownOnlyFitExclusions, 4);
  assert.equal(comparePr94CalibrationEvidence(result, rejected).status, "fail");
  assert.doesNotMatch(JSON.stringify(rejected), /pr94-counterfactual|synthetic-known|[a-f0-9]{64}/u);
});

test("PR94 rejects hidden private-frame channels and revokes private lifetime explicitly", async () => {
  const result = evidence();
  for (const mutate of [
    (frame) => Object.defineProperty(frame, "hidden", { value: "secret" }),
    (frame) => Object.defineProperty(frame, "capacity", { get() { throw new Error("must-not-run"); }, enumerable: true }),
    (frame) => { frame[Symbol("secret")] = "secret"; },
    (frame) => Object.setPrototypeOf(frame, { hidden: "secret" }),
  ]) {
    const privateFrames = frames(result);
    mutate(privateFrames[0].fragments[0]);
    await assert.rejects(() => importPr94CalibrationEvidence({ aggregate: result, frames: privateFrames, hmacKey: HMAC_KEY }),
      isCode("pr94_calibration_private_frames_invalid"));
  }
  const iterator = iteratePr94CalibrationPrivateFrames(result);
  assert.equal(iterator.next().done, false);
  disposePr94CalibrationEvidencePrivate(result);
  assert.equal(result.status, "pass");
  assert.throws(() => iterator.next(), isCode("pr94_calibration_evidence_untrusted"));
  assert.throws(() => comparePr94CalibrationEvidence(result, result), isCode("pr94_calibration_evidence_untrusted"));
});
